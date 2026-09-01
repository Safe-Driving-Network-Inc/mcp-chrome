/**
 * @fileoverview RunQueue interface definition
 * @description The management interface for the run queue
 */

import type { JsonObject, UnixMillis } from '../../domain/json';
import type { FlowId, NodeId, RunId } from '../../domain/ids';
import type { TriggerFireContext } from '../../domain/triggers';

/**
 * RunQueue config
 */
export interface RunQueueConfig {
  /** Maximum number of parallel runs */
  maxParallelRuns: number;
  /** Lease TTL (ms) */
  leaseTtlMs: number;
  /** Heartbeat interval (ms) */
  heartbeatIntervalMs: number;
}

/**
 * Default queue config
 */
export const DEFAULT_QUEUE_CONFIG: RunQueueConfig = {
  maxParallelRuns: 3,
  leaseTtlMs: 15_000,
  heartbeatIntervalMs: 5_000,
};

/**
 * Queue item status
 */
export type QueueItemStatus = 'queued' | 'running' | 'paused';

/**
 * Lease info
 */
export interface Lease {
  /** Holder ID */
  ownerId: string;
  /** Expiry time */
  expiresAt: UnixMillis;
}

/**
 * RunQueue item
 */
export interface RunQueueItem {
  /** Run ID */
  id: RunId;
  /** Flow ID */
  flowId: FlowId;
  /** Status */
  status: QueueItemStatus;
  /** Creation time */
  createdAt: UnixMillis;
  /** Update time */
  updatedAt: UnixMillis;
  /** Priority (higher number wins) */
  priority: number;
  /** Current attempt count */
  attempt: number;
  /** Maximum attempt count */
  maxAttempts: number;
  /** Tab ID */
  tabId?: number;
  /** Run parameters */
  args?: JsonObject;
  /** Trigger context */
  trigger?: TriggerFireContext;
  /** Lease info */
  lease?: Lease;
  /** Debug config */
  debug?: { breakpoints?: NodeId[]; pauseOnStart?: boolean };
}

/**
 * Enqueue request (without the auto-generated fields)
 * - priority defaults to 0
 * - maxAttempts defaults to 1
 */
export type EnqueueInput = Omit<
  RunQueueItem,
  'status' | 'createdAt' | 'updatedAt' | 'attempt' | 'lease' | 'priority' | 'maxAttempts'
> & {
  id: RunId;
  /** Priority (higher number wins, defaults to 0) */
  priority?: number;
  /** Maximum attempt count (defaults to 1) */
  maxAttempts?: number;
};

/**
 * RunQueue interface
 * @description Manages queuing and scheduling of runs
 */
export interface RunQueue {
  /**
   * Enqueue
   * @param input the enqueue request
   * @returns the queue item
   */
  enqueue(input: EnqueueInput): Promise<RunQueueItem>;

  /**
   * Claim the next runnable run
   * @param ownerId the claimant's ID
   * @param now the current time
   * @returns the queue item, or null
   */
  claimNext(ownerId: string, now: UnixMillis): Promise<RunQueueItem | null>;

  /**
   * Renew the lease heartbeat
   * @param ownerId the claimant's ID
   * @param now the current time
   */
  heartbeat(ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * Reclaim expired leases
   * @description Returns running/paused items whose lease.expiresAt < now back to queued
   * @param now the current time
   * @returns the list of reclaimed run IDs
   */
  reclaimExpiredLeases(now: UnixMillis): Promise<RunId[]>;

  /**
   * Recover orphaned leases (called after a service worker restart)
   * @description
   * - Orphaned running items are returned to queued (status -> queued, lease cleared)
   * - Orphaned paused items are adopted (status stays paused, lease ownerId updated to the new ownerId)
   * @param ownerId the new ownerId (the current service worker instance)
   * @param now the current time
   * @returns the affected run IDs (including the previous ownerId, for auditing)
   */
  recoverOrphanLeases(
    ownerId: string,
    now: UnixMillis,
  ): Promise<{
    requeuedRunning: Array<{ runId: RunId; prevOwnerId?: string }>;
    adoptedPaused: Array<{ runId: RunId; prevOwnerId?: string }>;
  }>;

  /**
   * Mark as running
   */
  markRunning(runId: RunId, ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * Mark as paused
   */
  markPaused(runId: RunId, ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * Mark as done (removes it from the queue)
   */
  markDone(runId: RunId, now: UnixMillis): Promise<void>;

  /**
   * Cancel a run
   */
  cancel(runId: RunId, now: UnixMillis, reason?: string): Promise<void>;

  /**
   * Get a queue item
   */
  get(runId: RunId): Promise<RunQueueItem | null>;

  /**
   * List the queue items
   */
  list(status?: QueueItemStatus): Promise<RunQueueItem[]>;
}

/**
 * Create a NotImplemented RunQueue
 * @description Phase 0 placeholder implementation
 */
export function createNotImplementedQueue(): RunQueue {
  const notImplemented = () => {
    throw new Error('RunQueue not implemented');
  };

  return {
    enqueue: async () => notImplemented(),
    claimNext: async () => notImplemented(),
    heartbeat: async () => notImplemented(),
    reclaimExpiredLeases: async () => notImplemented(),
    recoverOrphanLeases: async () => notImplemented(),
    markRunning: async () => notImplemented(),
    markPaused: async () => notImplemented(),
    markDone: async () => notImplemented(),
    cancel: async () => notImplemented(),
    get: async () => notImplemented(),
    list: async () => notImplemented(),
  };
}
