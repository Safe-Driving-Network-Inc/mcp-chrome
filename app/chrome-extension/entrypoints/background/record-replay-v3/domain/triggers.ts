/**
 * @fileoverview Trigger type definitions
 * @description The trigger specs for Record-Replay V3
 */

import type { JsonObject, UnixMillis } from './json';
import type { FlowId, TriggerId } from './ids';

/** Trigger type */
export type TriggerKind =
  | 'manual'
  | 'url'
  | 'cron'
  | 'interval'
  | 'once'
  | 'command'
  | 'contextMenu'
  | 'dom';

/**
 * Base trigger interface
 */
export interface TriggerSpecBase {
  /** Trigger ID */
  id: TriggerId;
  /** Trigger type */
  kind: TriggerKind;
  /** Whether it is enabled */
  enabled: boolean;
  /** The associated Flow ID */
  flowId: FlowId;
  /** Parameters passed to the Flow */
  args?: JsonObject;
}

/**
 * URL match rule
 */
export interface UrlMatchRule {
  kind: 'url' | 'domain' | 'path';
  value: string;
}

/**
 * Trigger spec union
 */
export type TriggerSpec =
  // Manual trigger
  | (TriggerSpecBase & { kind: 'manual' })

  // URL trigger
  | (TriggerSpecBase & {
      kind: 'url';
      match: UrlMatchRule[];
    })

  // Cron schedule trigger
  | (TriggerSpecBase & {
      kind: 'cron';
      cron: string;
      timezone?: string;
    })

  // Interval trigger (repeats on a fixed interval)
  | (TriggerSpecBase & {
      kind: 'interval';
      /** Interval in minutes, minimum 1 */
      periodMinutes: number;
    })

  // Once trigger (fires at a given time, then disables itself)
  | (TriggerSpecBase & {
      kind: 'once';
      /** Fire timestamp (Unix milliseconds) */
      whenMs: UnixMillis;
    })

  // Keyboard shortcut trigger
  | (TriggerSpecBase & {
      kind: 'command';
      commandKey: string;
    })

  // Context menu trigger
  | (TriggerSpecBase & {
      kind: 'contextMenu';
      title: string;
      contexts?: ReadonlyArray<string>;
    })

  // DOM element appearance trigger
  | (TriggerSpecBase & {
      kind: 'dom';
      selector: string;
      appear?: boolean;
      once?: boolean;
      debounceMs?: UnixMillis;
    });

/**
 * Trigger fire context
 * @description Context captured when a trigger fires
 */
export interface TriggerFireContext {
  /** Trigger ID */
  triggerId: TriggerId;
  /** Trigger type */
  kind: TriggerKind;
  /** Fire time */
  firedAt: UnixMillis;
  /** Originating Tab ID */
  sourceTabId?: number;
  /** Originating URL */
  sourceUrl?: string;
}

/**
 * Get the typed trigger spec for a given trigger type
 */
export type TriggerSpecByKind<K extends TriggerKind> = Extract<TriggerSpec, { kind: K }>;

/**
 * Whether the trigger is enabled
 */
export function isTriggerEnabled(trigger: TriggerSpec): boolean {
  return trigger.enabled;
}

/**
 * Create a trigger fire context
 */
export function createTriggerFireContext(
  trigger: TriggerSpec,
  options?: { sourceTabId?: number; sourceUrl?: string },
): TriggerFireContext {
  return {
    triggerId: trigger.id,
    kind: trigger.kind,
    firedAt: Date.now(),
    sourceTabId: options?.sourceTabId,
    sourceUrl: options?.sourceUrl,
  };
}
