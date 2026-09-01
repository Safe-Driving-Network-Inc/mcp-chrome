/**
 * @fileoverview Shared enqueue service
 * @description
 * Provides one enqueue path shared by the RPC server and the TriggerManager.
 *
 * Rationale:
 * - Lifts the enqueue logic out of RpcServer into a standalone service
 * - Prevents behavioural drift between RPC and TriggerManager
 * - Unifies parameter validation, run creation, enqueueing and event publishing
 */

import type { JsonObject, UnixMillis } from '../../domain/json';
import type { FlowId, NodeId, RunId } from '../../domain/ids';
import type { TriggerFireContext } from '../../domain/triggers';
import { RUN_SCHEMA_VERSION, type RunRecordV3 } from '../../domain/events';
import type { StoragePort } from '../storage/storage-port';
import type { EventsBus } from '../transport/events-bus';
import type { RunScheduler } from './scheduler';

// ==================== Types ====================

/**
 * Enqueue service dependencies
 */
export interface EnqueueRunDeps {
  /** Storage layer (only flows/runs/queue are needed) */
  storage: Pick<StoragePort, 'flows' | 'runs' | 'queue'>;
  /** Event bus */
  events: Pick<EventsBus, 'append'>;
  /** Scheduler (optional) */
  scheduler?: Pick<RunScheduler, 'kick'>;
  /** RunId generator (injectable for tests) */
  generateRunId?: () => RunId;
  /** Time source (injectable for tests) */
  now?: () => UnixMillis;
}

/**
 * Enqueue request parameters
 */
export interface EnqueueRunInput {
  /** Flow ID (required) */
  flowId: FlowId;
  /** Starting node ID (optional, defaults to the Flow's entryNodeId) */
  startNodeId?: NodeId;
  /** Priority (defaults to 0) */
  priority?: number;
  /** Maximum attempt count (defaults to 1) */
  maxAttempts?: number;
  /** Parameters passed to the Flow */
  args?: JsonObject;
  /** Trigger context (set by the TriggerManager) */
  trigger?: TriggerFireContext;
  /** Debug options */
  debug?: {
    breakpoints?: NodeId[];
    pauseOnStart?: boolean;
  };
}

/**
 * Enqueue result
 */
export interface EnqueueRunResult {
  /** The newly created Run ID */
  runId: RunId;
  /** Position in the queue (1-based) */
  position: number;
}

// ==================== Utilities ====================

/**
 * Default RunId generator
 */
function defaultGenerateRunId(): RunId {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Validate an integer parameter
 */
function validateInt(
  value: unknown,
  defaultValue: number,
  fieldName: string,
  opts?: { min?: number; max?: number },
): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  const intValue = Math.floor(value);
  if (opts?.min !== undefined && intValue < opts.min) {
    throw new Error(`${fieldName} must be >= ${opts.min}`);
  }
  if (opts?.max !== undefined && intValue > opts.max) {
    throw new Error(`${fieldName} must be <= ${opts.max}`);
  }
  return intValue;
}

/**
 * Compute a run's position in the queue
 * @description Ordered the way the scheduler runs them: priority DESC + createdAt ASC
 * @returns 1-based position, or -1 if run not found in queued items
 *
 * Note: Due to race conditions (scheduler may claim the run before this is called),
 * position may be -1. Callers should handle this gracefully.
 */
async function computeQueuePosition(
  storage: Pick<StoragePort, 'queue'>,
  runId: RunId,
): Promise<number> {
  const queueItems = await storage.queue.list('queued');
  queueItems.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.createdAt - b.createdAt;
  });
  const index = queueItems.findIndex((item) => item.id === runId);
  // Return -1 if not found (run may have been claimed already)
  return index === -1 ? -1 : index + 1;
}

// ==================== Main Function ====================

/**
 * Enqueue a run for execution
 * @description
 * Steps:
 * 1. Validate the parameters
 * 2. Verify the Flow exists
 * 3. Create the RunRecordV3 (status=queued)
 * 4. Enqueue onto the RunQueue
 * 5. Publish the run.queued event
 * 6. Kick the scheduler (best-effort)
 * 7. Compute the queue position
 */
export async function enqueueRun(
  deps: EnqueueRunDeps,
  input: EnqueueRunInput,
): Promise<EnqueueRunResult> {
  const { flowId } = input;
  if (!flowId) {
    throw new Error('flowId is required');
  }

  const now = deps.now ?? (() => Date.now());
  const generateRunId = deps.generateRunId ?? defaultGenerateRunId;

  // Validate the parameters
  const priority = validateInt(input.priority, 0, 'priority');
  const maxAttempts = validateInt(input.maxAttempts, 1, 'maxAttempts', { min: 1 });

  // Verify the Flow exists
  const flow = await deps.storage.flows.get(flowId);
  if (!flow) {
    throw new Error(`Flow "${flowId}" not found`);
  }

  // Verify startNodeId exists in the Flow
  if (input.startNodeId) {
    const nodeExists = flow.nodes.some((n) => n.id === input.startNodeId);
    if (!nodeExists) {
      throw new Error(`startNodeId "${input.startNodeId}" not found in flow "${flowId}"`);
    }
  }

  const ts = now();
  const runId = generateRunId();

  // 1. Create the RunRecordV3
  const runRecord: RunRecordV3 = {
    schemaVersion: RUN_SCHEMA_VERSION,
    id: runId,
    flowId,
    status: 'queued',
    createdAt: ts,
    updatedAt: ts,
    attempt: 0,
    maxAttempts,
    args: input.args,
    trigger: input.trigger,
    debug: input.debug,
    startNodeId: input.startNodeId,
    nextSeq: 0,
  };
  await deps.storage.runs.save(runRecord);

  // 2. Enqueue
  await deps.storage.queue.enqueue({
    id: runId,
    flowId,
    priority,
    maxAttempts,
    args: input.args,
    trigger: input.trigger,
    debug: input.debug,
  });

  // 3. Publish the run.queued event
  await deps.events.append({
    runId,
    type: 'run.queued',
    flowId,
  });

  // 4. Compute the queue position (before the kick, to reduce the chance of a race yielding position=-1)
  const position = await computeQueuePosition(deps.storage, runId);

  // 5. Kick the scheduler (best-effort, does not block the return)
  if (deps.scheduler) {
    void deps.scheduler.kick();
  }

  return { runId, position };
}
