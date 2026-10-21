// Kareenos Browser Channel v2 — `wait` action → browser_wait (read-class).
//
//   { text | selector | ref, state: visible|hidden|attached|detached,
//     load: domcontentloaded|complete, timeout_ms }
//
// visible/attached fan out to every frame in scope and the first frame that
// satisfies wins; hidden/detached must hold in every reachable frame. Built on
// k-dom-core's kWaitFor (MutationObserver + 250 ms poll), so a text that
// appears in a child frame or inside an open shadow root is seen.
import { BaseBrowserToolExecutor } from '../base-browser';
import type { ToolResult } from '@/common/tool-handler';
import {
  createStructuredError,
  structuredErrorFromException,
  toBrowserError,
} from '@/common/browser-errors';
import { KAREENOS_TOOL_NAMES, K_MSG } from '@/common/kareenos-tool-names';
import { parseRef, formatRef } from '@/common/browser-refs';
import { listFrames, coreCall, expectedEpoch, noteFrameEpoch } from './core-bridge';
import { frameMatches } from './target-resolver';
import { waitForLoadState, type LoadState } from '../settle';

export type WaitState = 'visible' | 'hidden' | 'attached' | 'detached';

export interface WaitToolParams {
  text?: string;
  selector?: string;
  ref?: string;
  state?: WaitState;
  load?: LoadState;
  timeout_ms?: number; // the agent's wait budget
  frame?: string | number | null;
  laneId?: string;
  tabId?: number;
  windowId?: number;
  timeoutMs?: number; // channel budget (from the adapter)
  signal?: AbortSignal; // the command's deadline passed (2026-10-21)
}

export const WAIT_DEFAULT_MS = 10000;
export const WAIT_MAX_MS = 120000;

class WaitTool extends BaseBrowserToolExecutor {
  name = KAREENOS_TOOL_NAMES.WAIT;

  async execute(args: WaitToolParams): Promise<ToolResult> {
    const state: WaitState = (
      ['visible', 'hidden', 'attached', 'detached'] as WaitState[]
    ).includes(args.state as WaitState)
      ? (args.state as WaitState)
      : 'visible';
    const laneId = args.laneId || 'default';
    let budget = Math.max(0, Math.min(Number(args.timeout_ms) || WAIT_DEFAULT_MS, WAIT_MAX_MS));
    if (args.timeoutMs && args.timeoutMs > 0)
      budget = Math.min(budget, Math.max(500, args.timeoutMs - 1000));
    const started = Date.now();
    const remaining = () => Math.max(0, budget - (Date.now() - started));
    const hasTarget = !!(args.text || args.selector || args.ref);
    if (!hasTarget && !args.load) {
      return createStructuredError(
        'NOT_FOUND',
        'Provide text, selector or ref to wait for, and/or load (domcontentloaded|complete).',
      );
    }
    try {
      const tab = await this.resolveTargetTab(args);
      if (!tab.id) return createStructuredError('NO_FRAME_ACCESS', 'The channel tab has no id');
      const tabId = tab.id;

      let loadState: string | undefined;
      if (args.load) {
        const l = await waitForLoadState(tabId, args.load, remaining());
        loadState = l.status;
        if (!l.ok) {
          return createStructuredError(
            'TIMEOUT',
            `The page did not reach "${args.load}" within ${budget} ms (status: ${l.status}).`,
            { waited_ms: Date.now() - started, load: args.load, status: l.status },
          );
        }
      }
      if (!hasTarget) {
        return this.ok({
          state: null,
          matched: null,
          took_ms: Date.now() - started,
          load_state: loadState,
          url: tab.url,
        });
      }

      let frames = await listFrames(tabId);
      const parsed = args.ref ? parseRef(args.ref) : null;
      if (args.ref && !parsed)
        return createStructuredError(
          'NOT_FOUND',
          `"${args.ref}" is not a ref (refs look like f0e12).`,
        );
      if (parsed) frames = frames.filter((f) => f.frameId === parsed.frameId);
      else frames = frames.filter((f) => frameMatches(f, args.frame));
      if (!frames.length)
        return createStructuredError(
          'NO_FRAME_ACCESS',
          `No frame matches "${args.frame ?? args.ref}" on this page.`,
        );

      const positive = state === 'visible' || state === 'attached';
      const perFrameTimeout = remaining();
      const calls = frames.map(async (f) => {
        const msg: Record<string, any> = {
          action: K_MSG.WAIT_FOR,
          state,
          timeout: perFrameTimeout,
        };
        if (parsed) {
          msg.ref = parsed.helperRef;
          msg.expect_epoch = await expectedEpoch(laneId, tabId, f.frameId);
        } else if (args.selector) msg.selector = args.selector;
        else msg.text = args.text;
        const r = await coreCall(tabId, f.frameId, msg);
        if (r && r.epoch) void noteFrameEpoch(laneId, tabId, f.frameId, r.epoch, f.url);
        return { frame: f, r };
      });

      if (positive) {
        // first frame that satisfies wins; the others keep waiting until their
        // own timeout, which is harmless (they just resolve later). A frame that
        // FAILED (hung, unloading, unscriptable) is recorded, never counted as a
        // silent "no match" (2026-10-21).
        const framesFailed: Array<{ frame: number; code: string; message: string }> = [];
        const winner = await new Promise<{ frame: any; r: any } | null>((resolve) => {
          let pending = calls.length;
          if (args.signal)
            args.signal.addEventListener('abort', () => resolve(null), { once: true });
          calls.forEach((p, i) =>
            p.then(
              (v) => {
                if (v.r && v.r.success) resolve(v);
                else if (--pending === 0) resolve(null);
              },
              (err) => {
                const be = toBrowserError(err);
                framesFailed.push({
                  frame: frames[i].frameId,
                  code: be.code,
                  message: String(be.message || '').slice(0, 160),
                });
                if (--pending === 0) resolve(null);
              },
            ),
          );
        });
        if (!winner) {
          if (args.signal && args.signal.aborted) {
            return createStructuredError(
              'TIMEOUT',
              `The wait for ${args.ref || args.selector || JSON.stringify(args.text)} was cut short: the command's window closed after ${Date.now() - started} ms.`,
              {
                waited_ms: Date.now() - started,
                state,
                aborted: true,
                frames_failed: framesFailed,
              },
            );
          }
          if (framesFailed.length && framesFailed.length === frames.length) {
            return createStructuredError(
              'NO_FRAME_ACCESS',
              `No frame could be probed while waiting for ${args.ref || args.selector || JSON.stringify(args.text)}: ${framesFailed.map((f) => 'f' + f.frame + ' ' + f.code).join(', ')}. The page may be navigating — take a new browser_snapshot.`,
              {
                waited_ms: Date.now() - started,
                state,
                target: args.ref || args.selector || args.text,
                frames_failed: framesFailed,
              },
            );
          }
          return createStructuredError(
            'TIMEOUT',
            `Nothing became ${state} for ${args.ref || args.selector || JSON.stringify(args.text)} within ${budget} ms.` +
              (framesFailed.length
                ? ` ${framesFailed.length} of ${frames.length} frame(s) could not be probed (${framesFailed.map((f) => 'f' + f.frame + ' ' + f.code).join(', ')}).`
                : ''),
            {
              waited_ms: Date.now() - started,
              state,
              target: args.ref || args.selector || args.text,
              frames_searched: frames.map((f) => f.frameId),
              frames_failed: framesFailed.length ? framesFailed : undefined,
            },
          );
        }
        const m = winner.r.matched;
        return this.ok({
          state,
          matched: m
            ? {
                ref: formatRef(winner.frame.frameId, m.ref),
                frame: winner.frame.frameId,
                role: m.role,
                name: m.name,
                in_viewport: !!m.in_viewport,
              }
            : null,
          took_ms: Date.now() - started,
          load_state: loadState,
          url: tab.url,
        });
      }

      // hidden / detached: every reachable frame must agree.
      const settled = await Promise.allSettled(calls);
      let failed: string | null = null;
      settled.forEach((s) => {
        if (s.status === 'fulfilled') {
          if (!(s.value.r && s.value.r.success))
            failed = `still ${state === 'hidden' ? 'visible' : 'present'} in frame f${s.value.frame.frameId}`;
        } else {
          const be = toBrowserError(s.reason);
          if (
            be.code !== 'NO_FRAME_ACCESS' &&
            be.code !== 'NAV_INTERRUPTED' &&
            be.code !== 'STALE_REF'
          )
            failed = be.message;
        }
      });
      if (failed) {
        return createStructuredError(
          'TIMEOUT',
          `Target ${args.ref || args.selector || JSON.stringify(args.text)} did not become ${state} within ${budget} ms (${failed}).`,
          {
            waited_ms: Date.now() - started,
            state,
            target: args.ref || args.selector || args.text,
          },
        );
      }
      return this.ok({
        state,
        matched: null,
        took_ms: Date.now() - started,
        load_state: loadState,
        url: tab.url,
      });
    } catch (e) {
      return structuredErrorFromException(e);
    }
  }

  private ok(data: Record<string, any>): ToolResult {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, message: 'Wait satisfied', ...data }),
        },
      ],
      isError: false,
    };
  }
}

export const waitTool = new WaitTool();
