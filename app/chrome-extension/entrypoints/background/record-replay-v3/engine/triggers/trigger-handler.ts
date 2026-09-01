/**
 * @fileoverview Trigger handler interface definition
 * @description The common interface implemented by every trigger type
 */

import type { TriggerSpec, TriggerKind } from '../../domain/triggers';

/**
 * Trigger handler interface
 * @description Every trigger type must implement this interface
 */
export interface TriggerHandler<K extends TriggerKind = TriggerKind> {
  /** Trigger type */
  readonly kind: K;

  /**
   * Install the trigger
   * @description Registers the chrome API listeners, etc.
   * @param trigger the trigger spec
   */
  install(trigger: Extract<TriggerSpec, { kind: K }>): Promise<void>;

  /**
   * Uninstall the trigger
   * @description Removes the chrome API listeners, etc.
   * @param triggerId the trigger ID
   */
  uninstall(triggerId: string): Promise<void>;

  /**
   * Uninstall every trigger
   * @description Cleans up every trigger of this type
   */
  uninstallAll(): Promise<void>;

  /**
   * Get the IDs of the installed triggers
   */
  getInstalledIds(): string[];
}

/**
 * Trigger fire callback
 * @description The callback TriggerManager injects into each handler
 */
export interface TriggerFireCallback {
  /**
   * Called when the trigger fires
   * @param triggerId the trigger ID
   * @param context the fire context
   */
  onFire(
    triggerId: string,
    context: {
      sourceTabId?: number;
      sourceUrl?: string;
    },
  ): Promise<void>;
}

/**
 * Trigger handler factory
 */
export type TriggerHandlerFactory<K extends TriggerKind> = (
  fireCallback: TriggerFireCallback,
) => TriggerHandler<K>;
