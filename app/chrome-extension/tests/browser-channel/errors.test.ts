import { describe, it, expect } from 'vitest';
import {
  BrowserActionError,
  createStructuredError,
  parseStructuredError,
  toBrowserError,
  errorFromResponse,
  structuredErrorFromException,
} from '@/common/browser-errors';

describe('browser-errors', () => {
  it('round-trips a structured error through a ToolResult', () => {
    const r = createStructuredError('AMBIGUOUS', 'two matches', { candidates: [{ ref: 'f0e1' }] });
    expect(r.isError).toBe(true);
    const parsed = parseStructuredError((r.content[0] as any).text);
    expect(parsed).toEqual({ code: 'AMBIGUOUS', message: 'two matches', details: { candidates: [{ ref: 'f0e1' }] } });
    expect(parseStructuredError('plain prose')).toBeNull();
  });
  it('maps messaging failures to precise codes', () => {
    expect(toBrowserError(new Error('The message port closed before a response was received.')).code).toBe('NAV_INTERRUPTED');
    expect(toBrowserError(new Error('Could not establish connection. Receiving end does not exist.')).code).toBe('NO_FRAME_ACCESS');
    expect(toBrowserError(new Error('Cannot access a chrome:// URL')).code).toBe('NO_FRAME_ACCESS');
    expect(toBrowserError(new Error('boom')).code).toBe('EXECUTION_ERROR');
    expect(toBrowserError(new BrowserActionError('STALE_REF', 'x')).code).toBe('STALE_REF');
  });
  it('recognises helper error objects and leaves prose alone', () => {
    expect(errorFromResponse({ error: { code: 'NOT_FOUND', message: 'nope', details: { selector: 'x' } } })?.code).toBe('NOT_FOUND');
    expect(errorFromResponse({ error: 'legacy prose' })).toBeNull();
    expect(errorFromResponse({ success: true })).toBeNull();
  });
  it('wraps exceptions into structured tool results', () => {
    const r = structuredErrorFromException(new BrowserActionError('DISABLED', 'disabled', { ref: 'f0e3' }));
    expect(parseStructuredError((r.content[0] as any).text)).toEqual({ code: 'DISABLED', message: 'disabled', details: { ref: 'f0e3' } });
  });
});
