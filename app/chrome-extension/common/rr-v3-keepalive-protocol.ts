/**
 * @fileoverview RR V3 Keepalive Protocol Constants
 * @description Shared protocol constants for Background-Offscreen keepalive communication
 */

/** Keepalive port name */
export const RR_V3_KEEPALIVE_PORT_NAME = 'rr_v3_keepalive' as const;

/** Keepalive message types */
export type KeepaliveMessageType =
  | 'keepalive.ping'
  | 'keepalive.pong'
  | 'keepalive.start'
  | 'keepalive.stop';

/** Keepalive message */
export interface KeepaliveMessage {
  type: KeepaliveMessageType;
  timestamp: number;
}

/** Default heartbeat interval (ms) - the offscreen document pings on this interval */
export const DEFAULT_KEEPALIVE_PING_INTERVAL_MS = 20_000;

/** Maximum heartbeat interval (ms) - Chrome MV3 terminates a service worker after roughly 30s idle */
export const MAX_KEEPALIVE_PING_INTERVAL_MS = 25_000;
