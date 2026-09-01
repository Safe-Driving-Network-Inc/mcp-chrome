/**
 * @fileoverview Flow type definitions
 * @description The Flow IR (intermediate representation) for Record-Replay V3
 */

import type { ISODateTimeString, JsonObject } from './json';
import type { EdgeId, EdgeLabel, FlowId, NodeId } from './ids';
import type { FlowPolicy, NodePolicy } from './policy';
import type { VariableDefinition } from './variables';

/** Flow schema version */
export const FLOW_SCHEMA_VERSION = 3 as const;

/**
 * Edge V3
 * @description An edge in the DAG, connecting two nodes
 */
export interface EdgeV3 {
  /** Unique edge identifier */
  id: EdgeId;
  /** Source node ID */
  from: NodeId;
  /** Target node ID */
  to: NodeId;
  /** Edge label (used by conditional branches and error handling) */
  label?: EdgeLabel;
}

/** Node kind (extensible) */
export type NodeKind = string;

/**
 * Node V3
 * @description A node in the DAG, representing one executable operation
 */
export interface NodeV3 {
  /** Unique node identifier */
  id: NodeId;
  /** Node kind */
  kind: NodeKind;
  /** Node name (for display) */
  name?: string;
  /** Whether it is disabled */
  disabled?: boolean;
  /** Node-level policy */
  policy?: NodePolicy;
  /** Node config (its shape is determined by kind) */
  config: JsonObject;
  /** UI layout info */
  ui?: { x: number; y: number };
}

/**
 * Flow metadata binding
 * @description Ties a Flow to a specific domain / path / URL
 */
export interface FlowBinding {
  kind: 'domain' | 'path' | 'url';
  value: string;
}

/**
 * Flow V3
 * @description The complete Flow definition: nodes, edges and config
 */
export interface FlowV3 {
  /** Schema version */
  schemaVersion: typeof FLOW_SCHEMA_VERSION;
  /** Unique flow identifier */
  id: FlowId;
  /** Flow name */
  name: string;
  /** Flow description */
  description?: string;
  /** Creation time */
  createdAt: ISODateTimeString;
  /** Update time */
  updatedAt: ISODateTimeString;

  /** Entry node ID (given explicitly, never inferred from in-degree) */
  entryNodeId: NodeId;
  /** Node list */
  nodes: NodeV3[];
  /** Edge list */
  edges: EdgeV3[];

  /** Variable definitions */
  variables?: VariableDefinition[];
  /** Flow-level policy */
  policy?: FlowPolicy;
  /** Metadata */
  meta?: {
    /** Tags */
    tags?: string[];
    /** Binding rules */
    bindings?: FlowBinding[];
  };
}

/**
 * Find a node by ID
 */
export function findNodeById(flow: FlowV3, nodeId: NodeId): NodeV3 | undefined {
  return flow.nodes.find((n) => n.id === nodeId);
}

/**
 * Find every edge leaving the given node
 */
export function findEdgesFrom(flow: FlowV3, nodeId: NodeId): EdgeV3[] {
  return flow.edges.filter((e) => e.from === nodeId);
}

/**
 * Find every edge pointing at the given node
 */
export function findEdgesTo(flow: FlowV3, nodeId: NodeId): EdgeV3[] {
  return flow.edges.filter((e) => e.to === nodeId);
}
