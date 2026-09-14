// Kareenos Browser Channel v2 — structured error taxonomy.
//
// Helpers know exactly WHY an action failed (nothing matched, several things
// matched, the match is hidden, the ref is stale, the frame navigated…) and used
// to flatten all of it into one prose string; the agent then had nothing to
// branch on. Now every layer carries { code, message, details }:
//   helper  → { error: { code, message, details } }          (k-dom-core & co.)
//   tool    → ToolResult text = {"__kerror": {...}}, isError  (createStructuredError)
//   adapter → RESULT envelope errors[0] = { code, message, severity, details }
//   server  → tool result message prefixed "[CODE] …" + data.candidates
import type { ToolResult } from './tool-handler';

export type BrowserErrorCode =
  | 'NOT_FOUND' // nothing matched the selector/text in any searched frame
  | 'AMBIGUOUS' // several visible matches tie; details.candidates lists them with refs
  | 'NOT_VISIBLE' // matched but not rendered (hidden, zero-size, aria-hidden)
  | 'NOT_FILLABLE' // matched but is not an editable control
  | 'COVERED' // matched, rendered, but another element wins the hit test
  | 'DISABLED' // matched but disabled / aria-disabled
  | 'DETACHED' // the ref's element was removed from the document
  | 'STALE_REF' // the ref is from before a navigation / unknown in this frame
  | 'WRONG_FRAME' // ref frame contradicts an explicit frame argument
  | 'NO_FRAME_ACCESS' // the frame cannot be scripted (chrome://, sandboxed, gone)
  | 'TIMEOUT' // the action / wait did not finish within its budget
  | 'NAV_INTERRUPTED' // the frame navigated while the action ran
  | 'UNSUPPORTED_ACTION'
  | 'EXECUTION_ERROR';

export const BROWSER_ERROR_CODES: readonly BrowserErrorCode[] = [
  'NOT_FOUND',
  'AMBIGUOUS',
  'NOT_VISIBLE',
  'NOT_FILLABLE',
  'COVERED',
  'DISABLED',
  'DETACHED',
  'STALE_REF',
  'WRONG_FRAME',
  'NO_FRAME_ACCESS',
  'TIMEOUT',
  'NAV_INTERRUPTED',
  'UNSUPPORTED_ACTION',
  'EXECUTION_ERROR',
];

export interface StructuredError {
  code: BrowserErrorCode | string;
  message: string;
  details?: Record<string, any>;
}

export class BrowserActionError extends Error {
  code: BrowserErrorCode | string;
  details?: Record<string, any>;
  constructor(code: BrowserErrorCode | string, message: string, details?: Record<string, any>) {
    super(message);
    this.name = 'BrowserActionError';
    this.code = code || 'EXECUTION_ERROR';
    this.details = details;
  }
}

export function isBrowserActionError(e: unknown): e is BrowserActionError {
  return !!e && typeof e === 'object' && (e as any).name === 'BrowserActionError' && typeof (e as any).code === 'string';
}

// A helper reply of the shape { error: { code, message, details } } → error.
// (A bare-string `error` is legacy prose and is left to the caller.)
export function errorFromResponse(response: any): BrowserActionError | null {
  const e = response && response.error;
  if (!e || typeof e !== 'object' || typeof e.code !== 'string') return null;
  return new BrowserActionError(e.code, String(e.message || e.code), e.details && typeof e.details === 'object' ? e.details : undefined);
}

// Wrap anything thrown on the tool path into a BrowserActionError, mapping the
// Chrome messaging failures that have a precise meaning.
export function toBrowserError(e: unknown, fallbackCode: BrowserErrorCode = 'EXECUTION_ERROR'): BrowserActionError {
  if (isBrowserActionError(e)) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/message port closed before a response/i.test(msg)) {
    return new BrowserActionError('NAV_INTERRUPTED', 'The frame navigated or unloaded while the action was running: ' + msg);
  }
  if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
    return new BrowserActionError('NO_FRAME_ACCESS', 'The target frame could not be reached (it may have navigated, closed, or cannot run scripts): ' + msg);
  }
  if (/Cannot access (a )?chrome:\/\/|chrome-extension:\/\/|Cannot access contents of|Extensions cannot|The extensions gallery cannot be scripted/i.test(msg)) {
    return new BrowserActionError('NO_FRAME_ACCESS', msg);
  }
  return new BrowserActionError(fallbackCode, msg);
}

const KERROR_KEY = '__kerror';

export function createStructuredError(
  code: BrowserErrorCode | string,
  message: string,
  details?: Record<string, any>,
): ToolResult {
  const payload: StructuredError = { code, message };
  if (details && Object.keys(details).length) payload.details = details;
  return {
    content: [{ type: 'text', text: JSON.stringify({ [KERROR_KEY]: payload }) }],
    isError: true,
  };
}

export function structuredErrorFromException(e: unknown): ToolResult {
  const be = toBrowserError(e);
  return createStructuredError(be.code, be.message, be.details);
}

export function parseStructuredError(text: string): StructuredError | null {
  if (!text || typeof text !== 'string') return null;
  try {
    const parsed = JSON.parse(text);
    const k = parsed && parsed[KERROR_KEY];
    if (k && typeof k.code === 'string') {
      return { code: k.code, message: String(k.message || k.code), details: k.details && typeof k.details === 'object' ? k.details : undefined };
    }
  } catch (e) {
    /* not structured */
  }
  return null;
}
