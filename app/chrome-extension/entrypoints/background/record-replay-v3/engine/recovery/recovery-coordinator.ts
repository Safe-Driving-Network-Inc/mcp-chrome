/**
 * @fileoverview Crash recovery coordinator (P3-06)
 * @description
 * An MV3 service worker can be terminated at any moment. On startup this coordinator reconciles
 * the queue state against the run records so interrupted runs can resume.
 *
 * Recovery strategy:
 * - Orphaned running items: returned to queued, awaiting rescheduling (rerun from the start)
 * - Orphaned paused items: the lease is adopted, the paused status is kept
 * - Queue leftovers for already-terminal runs: cleaned up
 *
 * When to call it:
 * - Must be called before scheduler.start()
 * - Normally called once at service worker startup
 */

import type { UnixMillis } from '../../domain/json';
import type { RunId } from '../../domain/ids';
import { isTerminalStatus, type RunStatus } from '../../domain/events';
import type { StoragePort } from '../storage/storage-port';
import type { EventsBus } from '../transport/events-bus';

// ==================== Types ====================

/**
 * Recovery result
 */
export interface RecoveryResult {
  /** Running run IDs that were returned to queued */
  requeuedRunning: RunId[];
  /** Paused run IDs that were adopted */
  adoptedPaused: RunId[];
  /** Terminal run IDs that were cleaned up */
  cleanedTerminal: RunId[];
}

/**
 * Recovery coordinator dependencies
 */
export interface RecoveryCoordinatorDeps {
  /** Storage layer */
  storage: StoragePort;
  /** Event bus */
  events: EventsBus;
  /** The current service worker's ownerId */
  ownerId: string;
  /** Time source */
  now: () => UnixMillis;
  /** Logger */
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

// ==================== Main Function ====================

/**
 * Run crash recovery
 * @description
 * Called at service worker startup to reconcile the queue state against the run records.
 *
 * Order of operations:
 * 1. Pre-clean: walk every queue item and drop leftovers that are terminal or have no RunRecord
 * 2. Recover orphaned leases: requeue running, adopt paused
 * 3. Sync RunRecord state: make each RunRecord agree with the queue state
 * 4. Emit recovery events: emit run.recovered for the requeued running items
 */
export async function recoverFromCrash(deps: RecoveryCoordinatorDeps): Promise<RecoveryResult> {
  const logger = deps.logger ?? console;

  if (!deps.ownerId) {
    throw new Error('ownerId is required');
  }

  const now = deps.now();

  // Rationale: recovery must clean up *before* adopting or requeuing, otherwise an already-terminal run could be re-queued and run again
  const cleanedTerminalSet = new Set<RunId>();

  // ==================== Step 1: pre-clean ====================
  // Walk every queue item and drop leftovers that are terminal or have no RunRecord
  try {
    const items = await deps.storage.queue.list();
    for (const item of items) {
      const runId = item.id;
      const run = await deps.storage.runs.get(runId);

      // Defensive cleanup: a queue item without a RunRecord cannot be executed
      if (!run) {
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
          logger.debug(`[Recovery] Cleaned orphan queue item without RunRecord: ${runId}`);
        } catch (e) {
          logger.warn('[Recovery] markDone for missing RunRecord failed:', runId, e);
        }
        continue;
      }

      // Clean up terminal runs (the SW can crash after the runner finishes but before the scheduler marks it done)
      if (isTerminalStatus(run.status)) {
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
          logger.debug(`[Recovery] Cleaned terminal queue item: ${runId} (status=${run.status})`);
        } catch (e) {
          logger.warn('[Recovery] markDone for terminal run failed:', runId, e);
        }
      }
    }
  } catch (e) {
    logger.warn('[Recovery] Pre-clean failed:', e);
  }

  // ==================== Step 2: recover orphaned leases ====================
  // Best-effort: a failure here must not block startup
  let requeuedRunning: Array<{ runId: RunId; prevOwnerId?: string }> = [];
  let adoptedPaused: Array<{ runId: RunId; prevOwnerId?: string }> = [];
  try {
    const result = await deps.storage.queue.recoverOrphanLeases(deps.ownerId, now);
    requeuedRunning = result.requeuedRunning;
    adoptedPaused = result.adoptedPaused;
  } catch (e) {
    logger.error('[Recovery] recoverOrphanLeases failed:', e);
    // Carry on; do not block startup
  }

  // ==================== Step 3: sync RunRecord state ====================
  const requeuedRunningIds: RunId[] = [];
  for (const entry of requeuedRunning) {
    const runId = entry.runId;
    requeuedRunningIds.push(runId);

    // Skip items already cleaned up in step 1
    if (cleanedTerminalSet.has(runId)) {
      continue;
    }

    try {
      const run = await deps.storage.runs.get(runId);
      if (!run) {
        // The RunRecord is gone, drop the queue item (defensive)
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
        } catch (markDoneErr) {
          logger.warn(
            '[Recovery] markDone for missing RunRecord in Step3 failed:',
            runId,
            markDoneErr,
          );
        }
        continue;
      }

      // Skip terminal runs (something else may have updated them during recovery)
      // and drop the queue item so nothing is left behind
      if (isTerminalStatus(run.status)) {
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
          logger.debug(
            `[Recovery] Cleaned terminal queue item in Step3: ${runId} (status=${run.status})`,
          );
        } catch (markDoneErr) {
          logger.warn('[Recovery] markDone for terminal run in Step3 failed:', runId, markDoneErr);
        }
        continue;
      }

      // Set the RunRecord state to queued
      await deps.storage.runs.patch(runId, { status: 'queued', updatedAt: now });

      // Emit the recovery event (best-effort; a failure must not derail recovery)
      try {
        const fromStatus: 'running' | 'paused' = run.status === 'paused' ? 'paused' : 'running';
        await deps.events.append({
          runId,
          type: 'run.recovered',
          reason: 'sw_restart',
          fromStatus,
          toStatus: 'queued',
          prevOwnerId: entry.prevOwnerId,
          ts: now,
        });
        logger.info(`[Recovery] Requeued orphan running run: ${runId} (from=${fromStatus})`);
      } catch (eventErr) {
        logger.warn('[Recovery] Failed to emit run.recovered event:', runId, eventErr);
        // Carry on; this must not derail recovery
      }
    } catch (e) {
      logger.warn('[Recovery] Reconcile requeued running failed:', runId, e);
    }
  }

  // ==================== Step 4: sync the RunRecords of adopted paused items ====================
  const adoptedPausedIds: RunId[] = [];
  for (const entry of adoptedPaused) {
    const runId = entry.runId;
    adoptedPausedIds.push(runId);

    // Skip items already cleaned up in step 1
    if (cleanedTerminalSet.has(runId)) {
      continue;
    }

    try {
      const run = await deps.storage.runs.get(runId);
      if (!run) {
        // The RunRecord is gone, drop the queue item (defensive)
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
        } catch (markDoneErr) {
          logger.warn(
            '[Recovery] markDone for missing RunRecord in Step4 failed:',
            runId,
            markDoneErr,
          );
        }
        continue;
      }

      // Skip terminal runs and drop the queue item
      if (isTerminalStatus(run.status)) {
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
          logger.debug(
            `[Recovery] Cleaned terminal queue item in Step4: ${runId} (status=${run.status})`,
          );
        } catch (markDoneErr) {
          logger.warn('[Recovery] markDone for terminal run in Step4 failed:', runId, markDoneErr);
        }
        continue;
      }

      // If the RunRecord state is not paused, sync it
      if (run.status !== 'paused') {
        await deps.storage.runs.patch(runId, { status: 'paused' as RunStatus, updatedAt: now });
      }

      logger.info(`[Recovery] Adopted orphan paused run: ${runId}`);
    } catch (e) {
      logger.warn('[Recovery] Reconcile adopted paused failed:', runId, e);
    }
  }

  const result: RecoveryResult = {
    requeuedRunning: requeuedRunningIds,
    adoptedPaused: adoptedPausedIds,
    cleanedTerminal: Array.from(cleanedTerminalSet),
  };

  logger.info('[Recovery] Complete:', {
    requeuedRunning: result.requeuedRunning.length,
    adoptedPaused: result.adoptedPaused.length,
    cleanedTerminal: result.cleanedTerminal.length,
  });

  return result;
}
