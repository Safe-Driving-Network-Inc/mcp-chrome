/**
 * @fileoverview Event type definitions
 * @description Run events and run state for Record-Replay V3
 */

import type { JsonObject, JsonValue, UnixMillis } from './json';
import type { EdgeLabel, FlowId, NodeId, RunId } from './ids';
import type { RRError } from './errors';
import type { TriggerFireContext } from './triggers';

/** Unsubscribe function type */
export type Unsubscribe = () => void;

/** Run state */
export type RunStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'canceled';

/**
 * Base event interface
 * @description Fields shared by every event
 */
export interface EventBase {
  /** The owning Run ID */
  runId: RunId;
  /** Event timestamp */
  ts: UnixMillis;
  /** Monotonically increasing sequence number */
  seq: number;
}

/**
 * Pause reason
 * @description Why the run was paused
 */
export type PauseReason =
  | { kind: 'breakpoint'; nodeId: NodeId }
  | { kind: 'step'; nodeId: NodeId }
  | { kind: 'command' }
  | { kind: 'policy'; nodeId: NodeId; reason: string };

/** Resume reason */
export type RecoveryReason = 'sw_restart' | 'lease_expired';

/**
 * Run event union
 * @description Every possible runtime event
 */
export type RunEvent =
  // ===== Run lifecycle events =====
  | (EventBase & { type: 'run.queued'; flowId: FlowId })
  | (EventBase & { type: 'run.started'; flowId: FlowId; tabId: number })
  | (EventBase & { type: 'run.paused'; reason: PauseReason; nodeId?: NodeId })
  | (EventBase & { type: 'run.resumed' })
  | (EventBase & {
      type: 'run.recovered';
      /** Resume reason */
      reason: RecoveryReason;
      /** State before resuming */
      fromStatus: 'running' | 'paused';
      /** State after resuming */
      toStatus: 'queued';
      /** The previous ownerId (kept for auditing) */
      prevOwnerId?: string;
    })
  | (EventBase & { type: 'run.canceled'; reason?: string })
  | (EventBase & { type: 'run.succeeded'; tookMs: number; outputs?: JsonObject })
  | (EventBase & { type: 'run.failed'; error: RRError; nodeId?: NodeId })

  // ===== Node execution events =====
  | (EventBase & { type: 'node.queued'; nodeId: NodeId })
  | (EventBase & { type: 'node.started'; nodeId: NodeId; attempt: number })
  | (EventBase & {
      type: 'node.succeeded';
      nodeId: NodeId;
      tookMs: number;
      next?: { kind: 'edgeLabel'; label: EdgeLabel } | { kind: 'end' };
    })
  | (EventBase & {
      type: 'node.failed';
      nodeId: NodeId;
      attempt: number;
      error: RRError;
      decision: 'retry' | 'continue' | 'stop' | 'goto';
    })
  | (EventBase & { type: 'node.skipped'; nodeId: NodeId; reason: 'disabled' | 'unreachable' })

  // ===== Variable and log events =====
  | (EventBase & {
      type: 'vars.patch';
      patch: Array<{ op: 'set' | 'delete'; name: string; value?: JsonValue }>;
    })
  | (EventBase & { type: 'artifact.screenshot'; nodeId: NodeId; data: string; savedAs?: string })
  | (EventBase & {
      type: 'log';
      level: 'debug' | 'info' | 'warn' | 'error';
      message: string;
      data?: JsonValue;
    });

/** Run event type (extracted from the union) */
export type RunEventType = RunEvent['type'];

/**
 * Distributive Omit (preserves the union)
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * Run event input type
 * @description seq must be allocated atomically by the storage layer (via RunRecordV3.nextSeq)
 * ts is optional and defaults to Date.now()
 */
export type RunEventInput = DistributiveOmit<RunEvent, 'seq' | 'ts'> & {
  ts?: UnixMillis;
};

/** Run schema version */
export const RUN_SCHEMA_VERSION = 3 as const;

/**
 * Run record V3
 * @description The run summary record persisted in IndexedDB
 */
export interface RunRecordV3 {
  /** Schema version */
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  /** Unique run identifier */
  id: RunId;
  /** The associated Flow ID */
  flowId: FlowId;

  /** Current state */
  status: RunStatus;
  /** Creation time */
  createdAt: UnixMillis;
  /** Last update time */
  updatedAt: UnixMillis;

  /** Execution start time */
  startedAt?: UnixMillis;
  /** End time */
  finishedAt?: UnixMillis;
  /** Total duration (ms) */
  tookMs?: number;

  /** The bound Tab ID (exclusive per run) */
  tabId?: number;
  /** Starting node ID (when it is not the default entry) */
  startNodeId?: NodeId;
  /** The node currently executing */
  currentNodeId?: NodeId;

  /** Current attempt count */
  attempt: number;
  /** Maximum attempt count */
  maxAttempts: number;

  /** Run parameters */
  args?: JsonObject;
  /** Trigger context */
  trigger?: TriggerFireContext;
  /** Debug config */
  debug?: { breakpoints?: NodeId[]; pauseOnStart?: boolean };

  /** Error details (on failure) */
  error?: RRError;
  /** Output result */
  outputs?: JsonObject;

  /** Next event sequence number (cached field) */
  nextSeq: number;
}

/**
 * Whether the run has terminated
 */
export function isTerminalStatus(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

/**
 * Whether the run is currently executing
 */
export function isActiveStatus(status: RunStatus): boolean {
  return status === 'running' || status === 'paused';
}
