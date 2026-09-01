/**
 * @fileoverview Policy type definitions
 * @description The timeout, retry, error-handling and artifact policies used across Record-Replay V3
 */

import type { EdgeLabel, NodeId } from './ids';
import type { RRErrorCode } from './errors';
import type { UnixMillis } from './json';

/**
 * Timeout policy
 * @description The timeout duration and the scope it applies to
 */
export interface TimeoutPolicy {
  /** Timeout duration (ms) */
  ms: UnixMillis;
  /** Timeout scope: attempt = per attempt, node = the whole node execution */
  scope?: 'attempt' | 'node';
}

/**
 * Retry policy
 * @description Retry behaviour after a failure
 */
export interface RetryPolicy {
  /** Maximum retry count */
  retries: number;
  /** Retry interval (ms) */
  intervalMs: UnixMillis;
  /** Backoff strategy: none = fixed interval, exp = exponential backoff, linear = linear growth */
  backoff?: 'none' | 'exp' | 'linear';
  /** Maximum retry interval (ms) */
  maxIntervalMs?: UnixMillis;
  /** Jitter strategy: none = no jitter, full = fully random */
  jitter?: 'none' | 'full';
  /** Retry only on these error codes */
  retryOn?: ReadonlyArray<RRErrorCode>;
}

/**
 * Error-handling policy
 * @description What to do after a node fails
 */
export type OnErrorPolicy =
  | { kind: 'stop' }
  | { kind: 'continue'; as?: 'warning' | 'error' }
  | {
      kind: 'goto';
      target: { kind: 'edgeLabel'; label: EdgeLabel } | { kind: 'node'; nodeId: NodeId };
    }
  | { kind: 'retry'; override?: Partial<RetryPolicy> };

/**
 * Artifact policy
 * @description How screenshots and logs are collected
 */
export interface ArtifactPolicy {
  /** Screenshot policy: never, onFailure, always */
  screenshot?: 'never' | 'onFailure' | 'always';
  /** Path template for saved screenshots */
  saveScreenshotAs?: string;
  /** Whether to include console logs */
  includeConsole?: boolean;
  /** Whether to include network requests */
  includeNetwork?: boolean;
}

/**
 * Node-level policy
 * @description Execution policy config for a single node
 */
export interface NodePolicy {
  /** Timeout policy */
  timeout?: TimeoutPolicy;
  /** Retry policy */
  retry?: RetryPolicy;
  /** Error-handling policy */
  onError?: OnErrorPolicy;
  /** Artifact policy */
  artifacts?: ArtifactPolicy;
}

/**
 * Flow-level policy
 * @description Execution policy config for the whole Flow
 */
export interface FlowPolicy {
  /** Default node policy */
  defaultNodePolicy?: NodePolicy;
  /** How to handle unsupported nodes */
  unsupportedNodePolicy?: OnErrorPolicy;
  /** Overall run timeout (ms) */
  runTimeoutMs?: UnixMillis;
}

/**
 * Merge node policies
 * @description Merges the Flow-level defaults with the node-level policy
 */
export function mergeNodePolicy(
  flowDefault: NodePolicy | undefined,
  nodePolicy: NodePolicy | undefined,
): NodePolicy {
  if (!flowDefault) return nodePolicy ?? {};
  if (!nodePolicy) return flowDefault;

  return {
    timeout: nodePolicy.timeout ?? flowDefault.timeout,
    retry: nodePolicy.retry ?? flowDefault.retry,
    onError: nodePolicy.onError ?? flowDefault.onError,
    artifacts: nodePolicy.artifacts
      ? { ...flowDefault.artifacts, ...nodePolicy.artifacts }
      : flowDefault.artifacts,
  };
}
