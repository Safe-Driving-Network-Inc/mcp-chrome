// Kareenos Browser Channel v2 — "the page navigated under my action".
//
// After Enter in a composer or a click on a submit button the page often
// navigates or re-renders before the helper can answer; Chrome then reports the
// lost reply as a messaging error. Until 2026-10-21 that surfaced as
// EXECUTION_ERROR with Chrome's current wording ("message channel closed…"), so
// agents could not tell a posted comment from a failed one and re-sent it. Every
// side-effecting tool now routes its failures through here: when the error means
// the frame navigated/unloaded, or when the background saw the top frame commit a
// navigation during the action, the answer is NAV_INTERRUPTED with
// data.navigated = true, the new URL when known, and a message that says the
// action most likely completed. Other failures pass through unchanged.
import type { ToolResult } from '@/common/tool-handler';
import {
  createStructuredError,
  structuredErrorFromException,
  toBrowserError,
} from '@/common/browser-errors';
import { navEventsSince } from '../settle';

export interface NavInterruptedContext {
  action: 'click' | 'fill' | 'press' | 'upload' | 'navigate' | string;
  tabId?: number;
  startedAt?: number;
  detail?: string; // e.g. the keys pressed
}

async function currentUrl(tabId?: number): Promise<string | null> {
  if (typeof tabId !== 'number') return null;
  try {
    const t = await chrome.tabs.get(tabId);
    return t.url || null;
  } catch {
    return null;
  }
}

export async function actionErrorResult(
  e: unknown,
  ctx: NavInterruptedContext,
): Promise<ToolResult> {
  const be = toBrowserError(e);
  const navigated =
    typeof ctx.tabId === 'number' && typeof ctx.startedAt === 'number'
      ? navEventsSince(ctx.tabId, ctx.startedAt).some(
          (ev) =>
            ev.frameId === 0 &&
            (ev.event === 'committed' || ev.event === 'tab_loading' || ev.event === 'before'),
        )
      : false;
  const frameLost = be.code === 'NAV_INTERRUPTED' || (be.code === 'NO_FRAME_ACCESS' && navigated);
  if (!frameLost) return structuredErrorFromException(e);
  const url = await currentUrl(ctx.tabId);
  const what =
    ctx.action === 'press'
      ? `the key press${ctx.detail ? ' (' + ctx.detail + ')' : ''} was delivered`
      : ctx.action === 'fill'
        ? 'the value was entered'
        : `the ${ctx.action} fired`;
  return createStructuredError(
    'NAV_INTERRUPTED',
    `The page navigated while the ${ctx.action} was running, so the ${ctx.action} most likely completed (${what}).` +
      (url ? ` The tab is now at ${url}.` : '') +
      ` Take a new browser_snapshot before continuing, and do not repeat the ${ctx.action} unless the page shows it did not happen.`,
    {
      navigated: true,
      url: url || undefined,
      likely_completed: true,
      action: ctx.action,
      cause: be.message,
    },
  );
}
