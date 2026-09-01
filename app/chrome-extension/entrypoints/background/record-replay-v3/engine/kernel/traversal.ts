/**
 * @fileoverview DAG traversal and validation
 * @description Validation, traversal and next-node lookup for a Flow DAG
 */

import type { NodeId, EdgeLabel } from '../../domain/ids';
import type { FlowV3, EdgeV3 } from '../../domain/flow';
import { EDGE_LABELS } from '../../domain/ids';
import { RR_ERROR_CODES, createRRError, type RRError } from '../../domain/errors';

/**
 * DAG validation result
 */
export type ValidateFlowDAGResult = { ok: true } | { ok: false; errors: RRError[] };

/**
 * Validate a Flow DAG structure
 * @param flow the Flow definition
 * @returns the validation result
 */
export function validateFlowDAG(flow: FlowV3): ValidateFlowDAGResult {
  const errors: RRError[] = [];
  const nodeIds = new Set(flow.nodes.map((n) => n.id));

  // Check that entryNodeId exists
  if (!nodeIds.has(flow.entryNodeId)) {
    errors.push(
      createRRError(
        RR_ERROR_CODES.DAG_INVALID,
        `Entry node "${flow.entryNodeId}" does not exist in flow`,
      ),
    );
  }

  // Check that the nodes referenced by edges exist
  for (const edge of flow.edges) {
    if (!nodeIds.has(edge.from)) {
      errors.push(
        createRRError(
          RR_ERROR_CODES.DAG_INVALID,
          `Edge "${edge.id}" references non-existent source node "${edge.from}"`,
        ),
      );
    }
    if (!nodeIds.has(edge.to)) {
      errors.push(
        createRRError(
          RR_ERROR_CODES.DAG_INVALID,
          `Edge "${edge.id}" references non-existent target node "${edge.to}"`,
        ),
      );
    }
  }

  // Check for cycles
  const cycle = detectCycle(flow);
  if (cycle) {
    errors.push(
      createRRError(RR_ERROR_CODES.DAG_CYCLE, `Cycle detected in flow: ${cycle.join(' -> ')}`),
    );
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

/**
 * Detect a cycle in the DAG
 * @param flow the Flow definition
 * @returns the cycle path if one exists, otherwise null
 */
export function detectCycle(flow: FlowV3): NodeId[] | null {
  const adjacency = buildAdjacencyMap(flow);
  const visited = new Set<NodeId>();
  const recursionStack = new Set<NodeId>();
  const path: NodeId[] = [];

  function dfs(nodeId: NodeId): boolean {
    visited.add(nodeId);
    recursionStack.add(nodeId);
    path.push(nodeId);

    const neighbors = adjacency.get(nodeId) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) {
          return true;
        }
      } else if (recursionStack.has(neighbor)) {
        // Found a cycle
        const cycleStart = path.indexOf(neighbor);
        path.push(neighbor); // close the cycle
        path.splice(0, cycleStart); // drop the nodes before the cycle
        return true;
      }
    }

    path.pop();
    recursionStack.delete(nodeId);
    return false;
  }

  for (const node of flow.nodes) {
    if (!visited.has(node.id)) {
      if (dfs(node.id)) {
        return path;
      }
    }
  }

  return null;
}

/**
 * Find the next node
 * @param flow the Flow definition
 * @param currentNodeId the current node ID
 * @param label the edge label (optional, defaults to 'default')
 * @returns the next node ID, or null if there is no successor
 */
export function findNextNode(
  flow: FlowV3,
  currentNodeId: NodeId,
  label?: EdgeLabel,
): NodeId | null {
  const outEdges = flow.edges.filter((e) => e.from === currentNodeId);

  if (outEdges.length === 0) {
    return null;
  }

  // When a label is given, prefer a matching edge
  if (label) {
    const matchedEdge = outEdges.find((e) => e.label === label);
    if (matchedEdge) {
      return matchedEdge.to;
    }
  }

  // Otherwise take the default edge
  const defaultEdge = outEdges.find(
    (e) => e.label === EDGE_LABELS.DEFAULT || e.label === undefined,
  );
  if (defaultEdge) {
    return defaultEdge.to;
  }

  // If there is only one edge, use it
  if (outEdges.length === 1) {
    return outEdges[0].to;
  }

  return null;
}

/**
 * Find the edge carrying the given label
 */
export function findEdgeByLabel(
  flow: FlowV3,
  fromNodeId: NodeId,
  label: EdgeLabel,
): EdgeV3 | undefined {
  return flow.edges.find((e) => e.from === fromNodeId && e.label === label);
}

/**
 * Get every outgoing edge of a node
 */
export function getOutEdges(flow: FlowV3, nodeId: NodeId): EdgeV3[] {
  return flow.edges.filter((e) => e.from === nodeId);
}

/**
 * Get every incoming edge of a node
 */
export function getInEdges(flow: FlowV3, nodeId: NodeId): EdgeV3[] {
  return flow.edges.filter((e) => e.to === nodeId);
}

/**
 * Build the adjacency list
 */
function buildAdjacencyMap(flow: FlowV3): Map<NodeId, NodeId[]> {
  const map = new Map<NodeId, NodeId[]>();

  for (const node of flow.nodes) {
    map.set(node.id, []);
  }

  for (const edge of flow.edges) {
    const neighbors = map.get(edge.from);
    if (neighbors) {
      neighbors.push(edge.to);
    }
  }

  return map;
}

/**
 * Get every node reachable from the entry node
 */
export function getReachableNodes(flow: FlowV3): Set<NodeId> {
  const reachable = new Set<NodeId>();
  const adjacency = buildAdjacencyMap(flow);

  function dfs(nodeId: NodeId): void {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);

    const neighbors = adjacency.get(nodeId) || [];
    for (const neighbor of neighbors) {
      dfs(neighbor);
    }
  }

  dfs(flow.entryNodeId);
  return reachable;
}

/**
 * Check whether a node is reachable
 */
export function isNodeReachable(flow: FlowV3, nodeId: NodeId): boolean {
  return getReachableNodes(flow).has(nodeId);
}
