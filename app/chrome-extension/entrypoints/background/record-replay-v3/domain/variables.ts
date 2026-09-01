/**
 * @fileoverview Variable type definitions
 * @description The variable pointers and persistent variables used across Record-Replay V3
 */

import type { JsonValue, UnixMillis } from './json';

/** Variable name */
export type VariableName = string;

/** Persistent variable name (prefixed with $) */
export type PersistentVariableName = `$${string}`;

/** Variable scope */
export type VariableScope = 'run' | 'flow' | 'persistent';

/**
 * Variable pointer
 * @description A reference to a variable, supporting JSON-path access
 */
export interface VariablePointer {
  /** Variable scope */
  scope: VariableScope;
  /** Variable name */
  name: VariableName;
  /** JSON path (for reaching nested properties) */
  path?: ReadonlyArray<string | number>;
}

/**
 * Variable definition
 * @description A variable declared on a Flow
 */
export interface VariableDefinition {
  /** Variable name */
  name: VariableName;
  /** Display label */
  label?: string;
  /** Description */
  description?: string;
  /** Whether it is sensitive (never displayed or exported) */
  sensitive?: boolean;
  /** Whether it is required */
  required?: boolean;
  /** Default value */
  default?: JsonValue;
  /** Scope (excludes persistent; persistent is inferred from the $ prefix) */
  scope?: Exclude<VariableScope, 'persistent'>;
}

/**
 * Persistent variable record
 * @description A persistent variable stored in IndexedDB
 */
export interface PersistentVarRecord {
  /** Variable key (prefixed with $) */
  key: PersistentVariableName;
  /** Variable value */
  value: JsonValue;
  /** Last update time */
  updatedAt: UnixMillis;
  /** Version number (monotonic, used for LWW and debugging) */
  version: number;
}

/**
 * Whether a variable name refers to a persistent variable
 */
export function isPersistentVariable(name: string): name is PersistentVariableName {
  return name.startsWith('$');
}

/**
 * Parse a variable pointer string
 * @example "$user.name" -> { scope: 'persistent', name: '$user', path: ['name'] }
 */
export function parseVariablePointer(ref: string): VariablePointer | null {
  if (!ref) return null;

  const parts = ref.split('.');
  const name = parts[0];
  const path = parts.slice(1);

  if (isPersistentVariable(name)) {
    return {
      scope: 'persistent',
      name,
      path: path.length > 0 ? path : undefined,
    };
  }

  // Defaults to the run scope
  return {
    scope: 'run',
    name,
    path: path.length > 0 ? path : undefined,
  };
}
