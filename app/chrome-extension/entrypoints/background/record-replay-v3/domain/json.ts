/**
 * @fileoverview Base JSON type definitions
 * @description The JSON-related types used across Record-Replay V3
 */

/** JSON primitive type */
export type JsonPrimitive = string | number | boolean | null;

/** JSON object type */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** JSON array type */
export type JsonArray = JsonValue[];

/** Any JSON value */
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/** ISO 8601 date-time string */
export type ISODateTimeString = string;

/** Unix timestamp in milliseconds */
export type UnixMillis = number;
