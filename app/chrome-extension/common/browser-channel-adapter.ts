// Kareenos Browser Channel — adapter between the platform command/result envelope
// and the fork's internal tools (P1.2). Two responsibilities:
//   1. Map a platform ACTION + args → the internal tool name + tool args.
//   2. Adapt a tool's ToolResult ({content:(text|image)[], isError}) → the
//      platform RESULT envelope ({status, message, data, errors}).
//
// Authoritative contract: docs/platform-design/browser-channel-envelope.md.
// The internal tool NAMES come from chrome-mcp-shared TOOL_NAMES (upstream
// tools) and common/kareenos-tool-names (the v2 additions).
//
// v2 (2026-09-14): eleven actions. Every action's args are still rebuilt from an
// explicit whitelist (never a spread of the command's args), but the whitelist
// now carries the targeting vocabulary — ref / frame / nth / strict — plus the
// per-command budget (timeoutMs) the server forwards, and errors come back
// STRUCTURED ({code, message, details}) instead of one prose string.

import { TOOL_NAMES } from 'chrome-mcp-shared';
import type { ToolResult } from './tool-handler';
import { KAREENOS_TOOL_NAMES } from './kareenos-tool-names';
import { parseStructuredError } from './browser-errors';

export type BrowserAction =
  | 'navigate'
  | 'read'
  | 'click'
  | 'fill'
  | 'screenshot'
  | 'scroll'
  | 'upload'
  | 'snapshot'
  | 'wait'
  | 'press'
  | 'run_steps';

export interface CommandEnvelope {
  command_id: string;
  correlation_id: string;
  // Lane = one concurrent agent task on the server (runId / conversation /
  // agent). Each lane pins its OWN tab so several agents can work at once.
  // Absent/null ⇒ the 'default' lane = the legacy single channel tab.
  lane_id?: string | null;
  action: BrowserAction;
  args: Record<string, any>;
  // The server's await window for this command (ms). The extension must answer
  // BEFORE it expires, so tools get timeout_ms - TIMEOUT_MARGIN_MS as their budget.
  timeout_ms?: number | null;
}

export interface ResultError {
  code: string;
  message: string;
  severity: string;
  details?: Record<string, any>;
}

export interface ResultEnvelope {
  command_id: string;
  correlation_id: string;
  lane_id?: string | null;
  status: 'success' | 'failed';
  message: string;
  data: Record<string, any>;
  errors: ResultError[];
}

// Per-action default await windows (ms). Mirrors TIMEOUT_MS in the backend's
// browser_tools_help.js; used when a command carries no timeout_ms (older server).
export const ACTION_DEFAULT_MS: Record<BrowserAction, number> = {
  navigate: 30000,
  read: 15000,
  snapshot: 17000,
  click: 17000,
  fill: 17000,
  press: 17000,
  scroll: 11000,
  screenshot: 20000,
  upload: 120000,
  wait: 20000,
  run_steps: 290000,
};
export const TIMEOUT_MARGIN_MS = 3000;

// The budget a tool gets: answer before the server stops waiting.
export function budgetFor(action: BrowserAction, timeoutMs?: number | null): number {
  const base = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : ACTION_DEFAULT_MS[action] || 15000;
  return Math.max(1000, base - TIMEOUT_MARGIN_MS);
}

const orUndef = (v: any) => (v === null || v === '' ? undefined : v);

// ACTION → { internal tool name, arg transform }. This is the ONLY place the
// platform's bounded vocabulary meets the fork's internal tool names.
const ACTION_MAP: Record<
  BrowserAction,
  { tool: string; buildArgs: (a: Record<string, any>) => Record<string, any> }
> = {
  navigate: {
    tool: TOOL_NAMES.BROWSER.NAVIGATE, // chrome_navigate
    buildArgs: (a) => ({ url: a.url }),
  },
  read: {
    tool: TOOL_NAMES.BROWSER.WEB_FETCHER, // chrome_get_web_content
    buildArgs: (a) => ({
      textContent: true,
      selector: orUndef(a.selector),
      frame: orUndef(a.frame),
      maxChars: orUndef(a.max_chars),
    }),
  },
  click: {
    tool: TOOL_NAMES.BROWSER.CLICK, // chrome_click_element
    buildArgs: (a) => ({
      selector: orUndef(a.selector),
      ref: orUndef(a.ref),
      frame: orUndef(a.frame),
      nth: orUndef(a.nth),
      strict: typeof a.strict === 'boolean' ? a.strict : undefined,
    }),
  },
  fill: {
    tool: TOOL_NAMES.BROWSER.FILL, // chrome_fill_or_select
    buildArgs: (a) => ({
      selector: orUndef(a.selector),
      ref: orUndef(a.ref),
      frame: orUndef(a.frame),
      nth: orUndef(a.nth),
      strict: typeof a.strict === 'boolean' ? a.strict : undefined,
      value: a.value,
    }),
  },
  screenshot: {
    tool: TOOL_NAMES.BROWSER.SCREENSHOT, // chrome_screenshot
    buildArgs: (a) => ({
      name: 'browser_screenshot',
      storeBase64: true,
      fullPage: a.full_page === true,
      selector: orUndef(a.selector),
      ref: orUndef(a.ref),
      frame: orUndef(a.frame),
      // Capture via CDP on the (possibly background) channel tab — never needs to
      // bring the tab to the foreground.
      background: true,
    }),
  },
  scroll: {
    tool: TOOL_NAMES.BROWSER.SCROLL, // chrome_scroll
    buildArgs: (a) => ({
      selector: orUndef(a.selector),
      ref: orUndef(a.ref),
      frame: orUndef(a.frame),
      direction: a.direction || 'down',
      amount: a.amount,
    }),
  },
  upload: {
    tool: TOOL_NAMES.BROWSER.FILE_UPLOAD, // chrome_upload_file
    // Bytes arrive base64 IN the command (server-resolved) — the extension
    // never fetches storage URLs (they may point at an internal endpoint).
    buildArgs: (a) => ({
      selector: orUndef(a.selector),
      ref: orUndef(a.ref),
      frame: orUndef(a.frame),
      base64Data: a.base64,
      fileName: a.file_name || undefined,
      mimeType: a.mime_type || undefined,
    }),
  },
  snapshot: {
    tool: KAREENOS_TOOL_NAMES.SNAPSHOT,
    buildArgs: (a) => ({
      mode: a.mode === 'full' ? 'full' : 'interactive',
      selector: orUndef(a.selector),
      maxChars: orUndef(a.max_chars),
      includeText: a.include_text === true,
      frame: orUndef(a.frame),
    }),
  },
  wait: {
    tool: KAREENOS_TOOL_NAMES.WAIT,
    buildArgs: (a) => ({
      text: orUndef(a.text),
      selector: orUndef(a.selector),
      ref: orUndef(a.ref),
      state: orUndef(a.state),
      load: orUndef(a.load),
      timeout_ms: orUndef(a.timeout_ms),
      frame: orUndef(a.frame),
    }),
  },
  press: {
    tool: KAREENOS_TOOL_NAMES.PRESS,
    buildArgs: (a) => ({
      keys: a.keys,
      ref: orUndef(a.ref),
      selector: orUndef(a.selector),
      frame: orUndef(a.frame),
    }),
  },
  run_steps: {
    tool: KAREENOS_TOOL_NAMES.RUN_STEPS,
    buildArgs: (a) => ({
      steps: Array.isArray(a.steps) ? a.steps : [],
      stop_on_error: a.stop_on_error !== false,
    }),
  },
};

export function isSupportedAction(action: string): action is BrowserAction {
  return Object.prototype.hasOwnProperty.call(ACTION_MAP, action);
}

export function resolveToolCall(command: CommandEnvelope): {
  name: string;
  args: Record<string, any>;
} {
  const m = ACTION_MAP[command.action];
  // laneId + timeoutMs are injected AFTER buildArgs so the per-action transforms
  // stay lane/budget-agnostic; every tool resolves its target tab from this lane
  // and keeps its waits inside the budget.
  return {
    name: m.tool,
    args: {
      ...m.buildArgs(command.args || {}),
      laneId: command.lane_id || 'default',
      timeoutMs: budgetFor(command.action, command.timeout_ms),
    },
  };
}

// Pull the first text content item's string out of a ToolResult.
function firstText(result: ToolResult): string {
  if (!result || !Array.isArray(result.content)) return '';
  for (const c of result.content) {
    if (c && (c as any).type === 'text' && typeof (c as any).text === 'string')
      return (c as any).text;
  }
  return '';
}

// Adapt a ToolResult to the platform RESULT envelope for a given command/action.
export function toResultEnvelope(
  action: BrowserAction,
  command: CommandEnvelope,
  result: ToolResult,
): ResultEnvelope {
  const base = {
    command_id: command.command_id,
    correlation_id: command.correlation_id,
    lane_id: command.lane_id || null,
  };
  const text = firstText(result);

  if (result && result.isError) {
    const structured = parseStructuredError(text);
    if (structured) {
      const details = structured.details || {};
      const data: Record<string, any> = { error_details: details };
      if (Array.isArray(details.candidates)) data.candidates = details.candidates;
      if (details.settle) data.settle = details.settle;
      return {
        ...base,
        status: 'failed',
        message: `[${structured.code}] ${structured.message}`,
        data,
        errors: [{ code: structured.code, message: structured.message, severity: 'error', details }],
      };
    }
    return {
      ...base,
      status: 'failed',
      message: text || 'Browser action failed',
      data: {},
      errors: [
        {
          code: 'BROWSER_ACTION_FAILED',
          message: text || 'Browser action failed',
          severity: 'error',
        },
      ],
    };
  }

  // Screenshot: the tool returns content[].text = JSON {base64Data, mimeType, …}.
  // Surface it as { base64, media_type } so the server persists it to S3 and
  // builds a file_block (server-side), instead of inlining base64 elsewhere.
  if (action === 'screenshot') {
    let base64 = '';
    let mediaType = 'image/jpeg';
    let extra: Record<string, any> = {};
    try {
      const parsed = JSON.parse(text);
      base64 = parsed.base64Data || parsed.base64 || '';
      mediaType = parsed.mimeType || parsed.media_type || mediaType;
      if (parsed.clip) extra.clip = parsed.clip;
      if (parsed.clip_warning) extra.clip_warning = parsed.clip_warning;
      if (parsed.target) extra.target = parsed.target;
      if (parsed.frame) extra.frame = parsed.frame;
    } catch (e) {
      /* fall through to empty */
    }
    return {
      ...base,
      status: 'success',
      message: 'Screenshot captured' + (extra.clip_warning ? ' — ' + extra.clip_warning : ''),
      data: { base64, media_type: mediaType, ...extra },
      errors: [],
    };
  }

  // Other actions: try to parse the text as a JSON object payload; otherwise
  // wrap it as { text }.
  let data: Record<string, any> = {};
  try {
    const parsed = JSON.parse(text);
    data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { text };
  } catch (e) {
    data = text ? { text } : {};
  }
  return { ...base, status: 'success', message: data.message || action + ' ok', data, errors: [] };
}

// Build a server-shaped failure envelope (unsupported action, internal error, timeout).
export function failureEnvelope(
  command: CommandEnvelope,
  code: string,
  message: string,
  details?: Record<string, any>,
): ResultEnvelope {
  const err: ResultError = { code, message, severity: 'error' };
  if (details) err.details = details;
  return {
    command_id: command.command_id,
    correlation_id: command.correlation_id,
    lane_id: command.lane_id || null,
    status: 'failed',
    message: `[${code}] ${message}`,
    data: details ? { error_details: details } : {},
    errors: [err],
  };
}
