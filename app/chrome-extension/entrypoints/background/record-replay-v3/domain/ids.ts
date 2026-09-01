/**
 * @fileoverview ID type definitions
 * @description The various ID types used across Record-Replay V3
 */

/** Unique identifier for a Flow */
export type FlowId = string;

/** Unique identifier for a Node */
export type NodeId = string;

/** Unique identifier for an Edge */
export type EdgeId = string;

/** Unique identifier for a Run */
export type RunId = string;

/** Unique identifier for a Trigger */
export type TriggerId = string;

/** Edge label type */
export type EdgeLabel = string;

/** Predefined edge label constants */
export const EDGE_LABELS = {
  /** Default edge */
  DEFAULT: 'default',
  /** Error-handling edge */
  ON_ERROR: 'onError',
  /** Edge taken when the condition is true */
  TRUE: 'true',
  /** Edge taken when the condition is false */
  FALSE: 'false',
} as const;

/** Edge label type (derived from the constants) */
export type EdgeLabelValue = (typeof EDGE_LABELS)[keyof typeof EDGE_LABELS];
