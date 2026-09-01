/**
 * @fileoverview Lease management
 * @description Renewing run leases and reclaiming expired ones
 */

import type { UnixMillis } from '../../domain/json';
import type { RunId } from '../../domain/ids';
import type { RunQueue, RunQueueConfig, Lease } from './queue';

/**
 * Lease manager
 * @description Handles lease renewal and expiry detection
 */
export interface LeaseManager {
  /**
   * Start the heartbeat
   * @param ownerId the holder's ID
   */
  startHeartbeat(ownerId: string): void;

  /**
   * Stop the heartbeat
   * @param ownerId the holder's ID
   */
  stopHeartbeat(ownerId: string): void;

  /**
   * Check for and reclaim expired leases
   * @param now the current time
   * @returns the list of reclaimed run IDs
   */
  reclaimExpiredLeases(now: UnixMillis): Promise<RunId[]>;

  /**
   * Whether a lease has expired
   */
  isLeaseExpired(lease: Lease, now: UnixMillis): boolean;

  /**
   * Create a new lease
   */
  createLease(ownerId: string, now: UnixMillis): Lease;

  /**
   * Stop every heartbeat
   */
  dispose(): void;
}

/**
 * Create a lease manager
 */
export function createLeaseManager(queue: RunQueue, config: RunQueueConfig): LeaseManager {
  const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

  return {
    startHeartbeat(ownerId: string): void {
      // If a timer already exists, stop it first
      this.stopHeartbeat(ownerId);

      // Create the new heartbeat timer
      const timer = setInterval(async () => {
        try {
          await queue.heartbeat(ownerId, Date.now());
        } catch (error) {
          console.error(`[LeaseManager] Heartbeat failed for ${ownerId}:`, error);
        }
      }, config.heartbeatIntervalMs);

      heartbeatTimers.set(ownerId, timer);
    },

    stopHeartbeat(ownerId: string): void {
      const timer = heartbeatTimers.get(ownerId);
      if (timer) {
        clearInterval(timer);
        heartbeatTimers.delete(ownerId);
      }
    },

    async reclaimExpiredLeases(now: UnixMillis): Promise<RunId[]> {
      // Delegate to the queue implementation which uses the lease_expiresAt index
      // for efficient scanning and updates storage atomically.
      return queue.reclaimExpiredLeases(now);
    },

    isLeaseExpired(lease: Lease, now: UnixMillis): boolean {
      return lease.expiresAt < now;
    },

    createLease(ownerId: string, now: UnixMillis): Lease {
      return {
        ownerId,
        expiresAt: now + config.leaseTtlMs,
      };
    },

    dispose(): void {
      for (const timer of heartbeatTimers.values()) {
        clearInterval(timer);
      }
      heartbeatTimers.clear();
    },
  };
}

/**
 * Generate a unique owner ID
 * @description Identifies the current service worker instance
 */
export function generateOwnerId(): string {
  return `sw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
