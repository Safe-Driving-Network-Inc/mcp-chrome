/**
 * @fileoverview Error type definitions
 * @description Error codes and error types used across Record-Replay V3
 */

import type { JsonValue } from './json';

/** Error code constants */
export const RR_ERROR_CODES = {
  // ===== Validation errors =====
  /** Generic validation error */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Unsupported node type */
  UNSUPPORTED_NODE: 'UNSUPPORTED_NODE',
  /** Invalid DAG structure */
  DAG_INVALID: 'DAG_INVALID',
  /** The DAG contains a cycle */
  DAG_CYCLE: 'DAG_CYCLE',

  // ===== Runtime errors =====
  /** Operation timed out */
  TIMEOUT: 'TIMEOUT',
  /** Tab not found */
  TAB_NOT_FOUND: 'TAB_NOT_FOUND',
  /** Frame not found */
  FRAME_NOT_FOUND: 'FRAME_NOT_FOUND',
  /** Target element not found */
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  /** Element is not visible */
  ELEMENT_NOT_VISIBLE: 'ELEMENT_NOT_VISIBLE',
  /** Navigation failed */
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  /** Network request failed */
  NETWORK_REQUEST_FAILED: 'NETWORK_REQUEST_FAILED',

  // ===== Script / tool errors =====
  /** Script execution failed */
  SCRIPT_FAILED: 'SCRIPT_FAILED',
  /** Permission denied */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** Tool execution error */
  TOOL_ERROR: 'TOOL_ERROR',

  // ===== Control errors =====
  /** The run was cancelled */
  RUN_CANCELED: 'RUN_CANCELED',
  /** The run was paused */
  RUN_PAUSED: 'RUN_PAUSED',

  // ===== Internal errors =====
  /** Internal error */
  INTERNAL: 'INTERNAL',
  /** Invariant violation */
  INVARIANT_VIOLATION: 'INVARIANT_VIOLATION',
} as const;

/** Error code type */
export type RRErrorCode = (typeof RR_ERROR_CODES)[keyof typeof RR_ERROR_CODES];

/**
 * Record-Replay error interface
 * @description A uniform error shape supporting error chaining and a retryable flag
 */
export interface RRError {
  /** Error code */
  code: RRErrorCode;
  /** Error message */
  message: string;
  /** Additional data */
  data?: JsonValue;
  /** Whether the error is retryable */
  retryable?: boolean;
  /** The causing error (error chain) */
  cause?: RRError;
}

/**
 * Factory function for creating an RRError
 */
export function createRRError(
  code: RRErrorCode,
  message: string,
  options?: { data?: JsonValue; retryable?: boolean; cause?: RRError },
): RRError {
  return {
    code,
    message,
    ...(options?.data !== undefined && { data: options.data }),
    ...(options?.retryable !== undefined && { retryable: options.retryable }),
    ...(options?.cause !== undefined && { cause: options.cause }),
  };
}
