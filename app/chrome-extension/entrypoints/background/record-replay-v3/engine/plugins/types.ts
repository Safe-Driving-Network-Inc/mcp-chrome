/**
 * @fileoverview Plugin type definitions
 * @description The node and trigger plugin interfaces for Record-Replay V3
 */

import { z } from 'zod';

import type { JsonObject, JsonValue } from '../../domain/json';
import type { FlowId, NodeId, RunId, TriggerId } from '../../domain/ids';
import type { NodeKind } from '../../domain/flow';
import type { RRError } from '../../domain/errors';
import type { NodePolicy } from '../../domain/policy';
import type { FlowV3, NodeV3 } from '../../domain/flow';
import type { TriggerKind } from '../../domain/triggers';

/**
 * Schema type
 * @description Config validation uses Zod
 */
export type Schema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

/**
 * Node execution context
 * @description The runtime context handed to a node executor
 */
export interface NodeExecutionContext {
  /** Run ID */
  runId: RunId;
  /** Flow definition (snapshot) */
  flow: FlowV3;
  /** Current node ID */
  nodeId: NodeId;

  /** The bound Tab ID (exclusive per run) */
  tabId: number;
  /** Frame ID (0, the main frame, by default) */
  frameId?: number;

  /** Current variable table */
  vars: Record<string, JsonValue>;

  /**
   * Logging
   */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: JsonValue) => void;

  /**
   * Choose the next edge
   * @description Used by conditional branch nodes
   */
  chooseNext: (label: string) => { kind: 'edgeLabel'; label: string };

  /**
   * Artifact operations
   */
  artifacts: {
    /** Capture a screenshot of the current page */
    screenshot: () => Promise<{ ok: true; base64: string } | { ok: false; error: RRError }>;
  };

  /**
   * Persistent variable operations
   */
  persistent: {
    /** Get a persistent variable */
    get: (name: `$${string}`) => Promise<JsonValue | undefined>;
    /** Set a persistent variable */
    set: (name: `$${string}`, value: JsonValue) => Promise<void>;
    /** Delete a persistent variable */
    delete: (name: `$${string}`) => Promise<void>;
  };
}

/**
 * Variable patch operations
 */
export interface VarsPatchOp {
  op: 'set' | 'delete';
  name: string;
  value?: JsonValue;
}

/**
 * Node execution result
 */
export type NodeExecutionResult =
  | {
      status: 'succeeded';
      /** Which way execution goes next */
      next?: { kind: 'edgeLabel'; label: string } | { kind: 'end' };
      /** Output result */
      outputs?: JsonObject;
      /** Variable changes */
      varsPatch?: VarsPatchOp[];
    }
  | { status: 'failed'; error: RRError };

/**
 * Node definition
 * @description Defines the execution logic for one node type
 */
export interface NodeDefinition<
  TKind extends NodeKind = NodeKind,
  TConfig extends JsonObject = JsonObject,
> {
  /** Node type identifier */
  kind: TKind;
  /** Config validation schema */
  schema: Schema<TConfig>;
  /** Default policy */
  defaultPolicy?: NodePolicy;
  /**
   * Execute the node
   * @param ctx the execution context
   * @param node the node definition (including its config)
   */
  execute(
    ctx: NodeExecutionContext,
    node: NodeV3 & { kind: TKind; config: TConfig },
  ): Promise<NodeExecutionResult>;
}

/**
 * Trigger install context
 */
export interface TriggerInstallContext<
  TKind extends TriggerKind = TriggerKind,
  TConfig extends JsonObject = JsonObject,
> {
  /** Trigger ID */
  triggerId: TriggerId;
  /** Trigger type */
  kind: TKind;
  /** Whether it is enabled */
  enabled: boolean;
  /** The associated Flow ID */
  flowId: FlowId;
  /** Trigger config */
  config: TConfig;
  /** Parameters passed to the Flow */
  args?: JsonObject;
}

/**
 * Trigger definition
 * @description Defines the install and uninstall logic for one trigger type
 */
export interface TriggerDefinition<
  TKind extends TriggerKind = TriggerKind,
  TConfig extends JsonObject = JsonObject,
> {
  /** Trigger type identifier */
  kind: TKind;
  /** Config validation schema */
  schema: Schema<TConfig>;
  /** Install the trigger */
  install(ctx: TriggerInstallContext<TKind, TConfig>): Promise<void> | void;
  /** Uninstall the trigger */
  uninstall(ctx: TriggerInstallContext<TKind, TConfig>): Promise<void> | void;
}

/**
 * Plugin registration context
 */
export interface PluginRegistrationContext {
  /** Register a node definition */
  registerNode(def: NodeDefinition): void;
  /** Register a trigger definition */
  registerTrigger(def: TriggerDefinition): void;
}

/**
 * Plugin interface
 * @description The standard interface for a Record-Replay plugin
 */
export interface RRPlugin {
  /** Plugin name */
  name: string;
  /** Register the plugin's contents */
  register(ctx: PluginRegistrationContext): void;
}
