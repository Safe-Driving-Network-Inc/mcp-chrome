/**
 * @fileoverview Debugger type definitions
 * @description The debugger state and protocol for Record-Replay V3
 */

import type { JsonValue } from './json';
import type { NodeId, RunId } from './ids';
import type { PauseReason } from './events';

/**
 * Breakpoint definition
 */
export interface Breakpoint {
  /** ID of the node the breakpoint sits on */
  nodeId: NodeId;
  /** Whether it is enabled */
  enabled: boolean;
}

/**
 * Debugger state
 * @description Describes the debugger's current connection and execution state
 */
export interface DebuggerState {
  /** The associated Run ID */
  runId: RunId;
  /** Debugger connection state */
  status: 'attached' | 'detached';
  /** Execution state */
  execution: 'running' | 'paused';
  /** Pause reason (only meaningful when execution='paused') */
  pauseReason?: PauseReason;
  /** Current node ID */
  currentNodeId?: NodeId;
  /** Breakpoint list */
  breakpoints: Breakpoint[];
  /** Step mode */
  stepMode?: 'none' | 'stepOver';
}

/**
 * Debugger commands
 * @description Commands the client sends to the debugger
 */
export type DebuggerCommand =
  // ===== Connection control =====
  | { type: 'debug.attach'; runId: RunId }
  | { type: 'debug.detach'; runId: RunId }

  // ===== Execution control =====
  | { type: 'debug.pause'; runId: RunId }
  | { type: 'debug.resume'; runId: RunId }
  | { type: 'debug.stepOver'; runId: RunId }

  // ===== Breakpoint management =====
  | { type: 'debug.setBreakpoints'; runId: RunId; nodeIds: NodeId[] }
  | { type: 'debug.addBreakpoint'; runId: RunId; nodeId: NodeId }
  | { type: 'debug.removeBreakpoint'; runId: RunId; nodeId: NodeId }

  // ===== State queries =====
  | { type: 'debug.getState'; runId: RunId }

  // ===== Variable operations =====
  | { type: 'debug.getVar'; runId: RunId; name: string }
  | { type: 'debug.setVar'; runId: RunId; name: string; value: JsonValue };

/** Debugger command type (extracted from the union) */
export type DebuggerCommandType = DebuggerCommand['type'];

/**
 * Debugger command response
 */
export type DebuggerResponse =
  | { ok: true; state?: DebuggerState; value?: JsonValue }
  | { ok: false; error: string };

/**
 * Create the initial debugger state
 */
export function createInitialDebuggerState(runId: RunId): DebuggerState {
  return {
    runId,
    status: 'detached',
    execution: 'running',
    breakpoints: [],
    stepMode: 'none',
  };
}
