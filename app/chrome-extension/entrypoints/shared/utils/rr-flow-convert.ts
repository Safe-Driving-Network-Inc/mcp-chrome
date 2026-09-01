/**
 * @fileoverview Two-way V2/V3 flow conversion helpers
 * @description Bridges the Builder V2 Flow type and the V3 RPC FlowV3 type
 *
 * Design notes:
 * - The Builder store still uses the V2 types (type, version, steps)
 * - The RPC layer uses the V3 types (kind, schemaVersion, entryNodeId)
 * - This module exposes the conversion to the UI layer, wrapping the low-level converters
 */

import type { Flow as FlowV2 } from '@/entrypoints/background/record-replay/types';
import type { FlowV3 } from '@/entrypoints/background/record-replay-v3/domain/flow';
import {
  convertFlowV2ToV3,
  convertFlowV3ToV2,
} from '@/entrypoints/background/record-replay-v3/storage/import/v2-to-v3';

// ==================== Types ====================

export interface FlowConversionResult<T> {
  flow: T;
  warnings: string[];
}

// ==================== V2 -> V3 (for RPC calls) ====================

/**
 * Convert a V2 Flow to V3 format, for saving over RPC
 * @param flowV2 the V2 Flow from the Builder store
 * @returns the V3 Flow plus any warnings
 * @throws if the conversion fails
 */
export function flowV2ToV3ForRpc(flowV2: FlowV2): FlowConversionResult<FlowV3> {
  const result = convertFlowV2ToV3(flowV2 as unknown as Parameters<typeof convertFlowV2ToV3>[0]);

  if (!result.success || !result.data) {
    const errorMsg =
      result.errors.length > 0 ? result.errors.join('; ') : 'Unknown conversion error';
    throw new Error(`V2→V3 conversion failed: ${errorMsg}`);
  }

  return {
    flow: result.data,
    warnings: result.warnings,
  };
}

// ==================== V3 -> V2 (for Builder display) ====================

/**
 * Convert a V3 Flow to V2 format, for display and editing in the Builder
 * @param flowV3 the V3 Flow fetched over RPC
 * @returns the V2 Flow plus any warnings
 * @throws if the conversion fails
 */
export function flowV3ToV2ForBuilder(flowV3: FlowV3): FlowConversionResult<FlowV2> {
  const result = convertFlowV3ToV2(flowV3);

  if (!result.success || !result.data) {
    const errorMsg =
      result.errors.length > 0 ? result.errors.join('; ') : 'Unknown conversion error';
    throw new Error(`V3→V2 conversion failed: ${errorMsg}`);
  }

  return {
    flow: result.data as unknown as FlowV2,
    warnings: result.warnings,
  };
}

// ==================== Type Guards ====================

/**
 * Determine whether this is a V3 Flow
 * @description Used to detect the JSON format on import
 */
export function isFlowV3(value: unknown): value is FlowV3 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return (
    obj.schemaVersion === 3 &&
    typeof obj.id === 'string' &&
    typeof obj.name === 'string' &&
    typeof obj.entryNodeId === 'string' &&
    Array.isArray(obj.nodes)
  );
}

/**
 * Determine whether this is a V2 Flow
 * @description Used to detect the JSON format on import
 */
export function isFlowV2(value: unknown): value is FlowV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.name === 'string' &&
    // V2 has a numeric version field and no schemaVersion
    typeof obj.version === 'number' &&
    obj.schemaVersion === undefined &&
    // V2 may carry either steps or nodes
    (Array.isArray(obj.steps) || Array.isArray(obj.nodes))
  );
}

// ==================== Import Helpers ====================

/**
 * Extract the candidate flows from imported JSON
 * @description Accepts a single Flow, an array of Flows, or the { flows: Flow[] } shape
 */
export function extractFlowCandidates(parsed: unknown): unknown[] {
  // Array shape
  if (Array.isArray(parsed)) {
    return parsed;
  }

  // Object shape
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;

    // { flows: [...] } shape
    if (Array.isArray(obj.flows)) {
      return obj.flows;
    }

    // A single Flow object
    if (obj.id && (Array.isArray(obj.steps) || Array.isArray(obj.nodes))) {
      return [obj];
    }
  }

  return [];
}
