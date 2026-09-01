/**
 * @fileoverview V2 data reader
 * @description Reads V2-format data (placeholder implementation)
 */

/**
 * V2 data reader interface
 * @description To be implemented in phase 5+
 */
export interface V2Reader {
  /** Read the V2 flows */
  readFlows(): Promise<unknown[]>;
  /** Read the V2 runs */
  readRuns(): Promise<unknown[]>;
  /** Read the V2 triggers */
  readTriggers(): Promise<unknown[]>;
  /** Read the V2 schedules */
  readSchedules(): Promise<unknown[]>;
}

/**
 * Create a NotImplemented V2Reader
 */
export function createNotImplementedV2Reader(): V2Reader {
  const notImplemented = async () => {
    throw new Error('V2Reader not implemented');
  };

  return {
    readFlows: notImplemented,
    readRuns: notImplemented,
    readTriggers: notImplemented,
    readSchedules: notImplemented,
  };
}
