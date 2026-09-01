// Kareenos Browser Channel — adapter between the platform command/result envelope
// and the fork's internal tools (P1.2). Two responsibilities:
//   1. Map a platform ACTION + args → the internal tool name + tool args.
//   2. Adapt a tool's ToolResult ({content:(text|image)[], isError}) → the
//      platform RESULT envelope ({status, message, data, errors}).
//
// Authoritative contract: docs/platform-design/browser-channel-envelope.md.
// The internal tool NAMES come from chrome-mcp-shared TOOL_NAMES.BROWSER.

import { TOOL_NAMES } from 'chrome-mcp-shared';
import type { ToolResult } from './tool-handler';

export type BrowserAction =
  | 'navigate'
  | 'read'
  | 'click'
  | 'fill'
  | 'screenshot'
  | 'scroll'
  | 'upload';

export interface CommandEnvelope {
  command_id: string;
  correlation_id: string;
  // Lane = one concurrent agent task on the server (runId / conversation /
  // agent). Each lane pins its OWN tab so several agents can work at once.
  // Absent/null ⇒ the 'default' lane = the legacy single channel tab.
  lane_id?: string | null;
  action: BrowserAction;
  args: Record<string, any>;
}

export interface ResultEnvelope {
  command_id: string;
  correlation_id: string;
  lane_id?: string | null;
  status: 'success' | 'failed';
  message: string;
  data: Record<string, any>;
  errors: Array<{ code: string; message: string; severity: string }>;
}

// ACTION → { internal tool name, arg transform }. This is the ONLY place the
// platform's bounded-seven vocabulary meets the fork's internal tool names.
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
    buildArgs: (a) => ({ textContent: true, selector: a.selector || undefined }),
  },
  click: {
    tool: TOOL_NAMES.BROWSER.CLICK, // chrome_click_element
    buildArgs: (a) => ({ selector: a.selector }),
  },
  fill: {
    tool: TOOL_NAMES.BROWSER.FILL, // chrome_fill_or_select
    buildArgs: (a) => ({ selector: a.selector, value: a.value }),
  },
  screenshot: {
    tool: TOOL_NAMES.BROWSER.SCREENSHOT, // chrome_screenshot
    buildArgs: (a) => ({
      name: 'browser_screenshot',
      storeBase64: true,
      fullPage: false,
      selector: a.selector || undefined,
      // Capture via CDP on the (possibly background) channel tab — never needs to
      // bring the tab to the foreground.
      background: true,
    }),
  },
  scroll: {
    tool: TOOL_NAMES.BROWSER.SCROLL, // chrome_scroll
    buildArgs: (a) => ({
      selector: a.selector || undefined,
      direction: a.direction || 'down',
      amount: a.amount,
    }),
  },
  upload: {
    tool: TOOL_NAMES.BROWSER.FILE_UPLOAD, // chrome_upload_file
    // Bytes arrive base64 IN the command (server-resolved) — the extension
    // never fetches storage URLs (they may point at an internal endpoint).
    buildArgs: (a) => ({
      selector: a.selector,
      base64Data: a.base64,
      fileName: a.file_name || undefined,
      mimeType: a.mime_type || undefined,
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
  // laneId is injected AFTER buildArgs so the per-action transforms stay
  // lane-agnostic; every tool resolves its target tab from this lane.
  return {
    name: m.tool,
    args: { ...m.buildArgs(command.args || {}), laneId: command.lane_id || 'default' },
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

  // Screenshot: the tool returns content[].text = JSON {base64Data, mimeType}.
  // Surface it as { base64, media_type } so the server persists it to S3 and
  // builds a file_block (server-side), instead of inlining base64 elsewhere.
  if (action === 'screenshot') {
    let base64 = '';
    let mediaType = 'image/jpeg';
    try {
      const parsed = JSON.parse(text);
      base64 = parsed.base64Data || parsed.base64 || '';
      mediaType = parsed.mimeType || parsed.media_type || mediaType;
    } catch (e) {
      /* fall through to empty */
    }
    return {
      ...base,
      status: 'success',
      message: 'Screenshot captured',
      data: { base64, media_type: mediaType },
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

// Build a server-shaped failure envelope (unsupported action, internal error).
export function failureEnvelope(
  command: CommandEnvelope,
  code: string,
  message: string,
): ResultEnvelope {
  return {
    command_id: command.command_id,
    correlation_id: command.correlation_id,
    lane_id: command.lane_id || null,
    status: 'failed',
    message,
    data: {},
    errors: [{ code, message, severity: 'error' }],
  };
}
