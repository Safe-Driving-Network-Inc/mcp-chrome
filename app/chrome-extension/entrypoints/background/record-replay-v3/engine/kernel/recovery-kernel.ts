/**
 * @fileoverview An ExecutionKernel implementation with crash recovery (P3-06)
 * @description
 * Provides a recovery-enhanced ExecutionKernel that supports `recover()`.
 * Crash recovery is delegated to the RecoveryCoordinator.
 *
 * The other execution methods (startRun, pauseRun, etc.) are not implemented yet and will land in a later phase.
 */

import type { UnixMillis } from '../../domain/json';
import type { RunId } from '../../domain/ids';
import type { DebuggerCommand, DebuggerState } from '../../domain/debug';

import type { StoragePort } from '../storage/storage-port';
import type { EventsBus } from '../transport/events-bus';
import { recoverFromCrash } from '../recovery/recovery-coordinator';

import type { ExecutionKernel, RunStartRequest, RunStatusInfo } from './kernel';

// ==================== Types ====================

/**
 * Dependencies of the recovery-capable kernel
 */
export interface RecoveryEnabledKernelDeps {
  /** Storage layer */
  storage: StoragePort;
  /** Event bus */
  events: EventsBus;
  /** The current service worker's ownerId */
  ownerId: string;
  /** Time source */
  now?: () => UnixMillis;
  /** Logger */
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

// ==================== Factory ====================

/**
 * Create a recovery-capable ExecutionKernel
 * @description
 * This implementation only supports `recover()` and `getRunStatus()`.
 * The other execution methods are not implemented yet and will land in a later phase.
 */
export function createRecoveryEnabledKernel(deps: RecoveryEnabledKernelDeps): ExecutionKernel {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());

  if (!deps.ownerId) {
    throw new Error('ownerId is required');
  }

  const notImplemented = (name: string): never => {
    throw new Error(`ExecutionKernel.${name} not implemented`);
  };

  return {
    onEvent: (listener) => deps.events.subscribe(listener),

    startRun: async (_req: RunStartRequest) => notImplemented('startRun'),
    pauseRun: async (_runId: RunId) => notImplemented('pauseRun'),
    resumeRun: async (_runId: RunId) => notImplemented('resumeRun'),
    cancelRun: async (_runId: RunId) => notImplemented('cancelRun'),

    debug: async (
      _runId: RunId,
      _cmd: DebuggerCommand,
    ): Promise<{ ok: true; state?: DebuggerState } | { ok: false; error: string }> => {
      return { ok: false, error: 'ExecutionKernel.debug not configured' };
    },

    getRunStatus: async (runId: RunId): Promise<RunStatusInfo | null> => {
      const run = await deps.storage.runs.get(runId);
      if (!run) return null;
      return {
        status: run.status,
        currentNodeId: run.currentNodeId,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        tabId: run.tabId,
      };
    },

    recover: async (): Promise<void> => {
      logger.info('[RecoveryKernel] Starting crash recovery...');
      const result = await recoverFromCrash({
        storage: deps.storage,
        events: deps.events,
        ownerId: deps.ownerId,
        now,
        logger,
      });
      logger.info('[RecoveryKernel] Recovery complete:', result);
    },
  };
}
