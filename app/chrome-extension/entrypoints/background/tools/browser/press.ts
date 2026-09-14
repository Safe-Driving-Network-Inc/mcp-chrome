// Kareenos Browser Channel v2 — `press` action → browser_press (side-effecting,
// gated like click: Enter submits, Escape dismisses).
//
//   { keys, ref? | selector?, frame? }
//
// Focus first (by ref/selector through the shared resolver), then dispatch the
// chords as TRUSTED input over CDP (utils/cdp-input.ts). When the debugger is
// held by another client the DOM keyboard-helper is the fallback — untrusted,
// so `data.transport` tells the agent which one ran. Settles afterwards
// (Escape → settle.dialog_closed, Enter → settle.navigated / url_changed).
import { BaseBrowserToolExecutor } from '../base-browser';
import type { ToolResult } from '@/common/tool-handler';
import { createStructuredError, structuredErrorFromException, toBrowserError } from '@/common/browser-errors';
import { KAREENOS_TOOL_NAMES, K_MSG } from '@/common/kareenos-tool-names';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { coreCall, listFrames } from './core-bridge';
import { resolveTarget, frameMatches } from './target-resolver';
import { withSettle } from '../settle';
import { parseKeys, dispatchKeysCdp } from '@/utils/cdp-input';

export interface PressToolParams {
  keys: string;
  ref?: string;
  selector?: string;
  frame?: string | number | null;
  laneId?: string;
  tabId?: number;
  windowId?: number;
  timeoutMs?: number;
}

class PressTool extends BaseBrowserToolExecutor {
  name = KAREENOS_TOOL_NAMES.PRESS;

  async execute(args: PressToolParams): Promise<ToolResult> {
    const keys = String(args.keys || '').trim();
    if (!keys) return createStructuredError('EXECUTION_ERROR', 'keys is required (e.g. "Enter", "Ctrl+A, Delete", "Escape")');
    try {
      parseKeys(keys);
    } catch (e) {
      return createStructuredError('EXECUTION_ERROR', (e as Error).message);
    }
    const laneId = args.laneId || 'default';
    const started = Date.now();
    try {
      const tab = await this.resolveTargetTab(args);
      if (!tab.id) return createStructuredError('NO_FRAME_ACCESS', 'The channel tab has no id');
      const tabId = tab.id;

      let target: { ref: string; frame: number; role?: string; name?: string } | null = null;
      let targetFrame = 0;
      if (args.ref || args.selector) {
        const t = await resolveTarget(tabId, laneId, { ref: args.ref, selector: args.selector, frame: args.frame, kind: 'any' });
        const f = await coreCall(tabId, t.frameId, { action: K_MSG.FOCUS, ref: t.helperRef, expect_epoch: t.expectEpoch });
        target = { ref: t.ref, frame: t.frameId, role: f?.target?.role || t.role, name: f?.target?.name || t.name };
        targetFrame = t.frameId;
      } else if (args.frame != null && args.frame !== '') {
        const frames = await listFrames(tabId);
        const f = frames.find((x) => frameMatches(x, args.frame));
        if (f) targetFrame = f.frameId;
      }

      // Assigned inside the settle callback: keep it in an object so TS does not
      // narrow the closure-assigned value away at the comparison below.
      const run: { transport: 'cdp' | 'dom'; note: string } = { transport: 'cdp', note: '' };
      const budget = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 15000;
      const { settle } = await withSettle({ tabId, laneId, budgetMs: budget - 500 }, async () => {
        try {
          await dispatchKeysCdp(tabId, keys);
        } catch (e) {
          // Debugger busy (DevTools open, another extension) → untrusted DOM events.
          run.transport = 'dom';
          run.note = (e as Error).message;
          await this.injectContentScript(tabId, ['inject-scripts/keyboard-helper.js'], false, 'ISOLATED', false, [targetFrame]);
          const r = await this.sendMessageToTab(tabId, { action: TOOL_MESSAGE_TYPES.SIMULATE_KEYBOARD, keys, delay: 30 }, targetFrame);
          if (r && r.success === false) throw toBrowserError(new Error(r.error || 'keyboard simulation failed'));
        }
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Pressed ${keys}` + (run.transport === 'dom' ? ' (DOM fallback — untrusted events; the page may ignore them)' : ''),
              keys,
              transport: run.transport,
              transport_note: run.note || undefined,
              target,
              frame: { id: targetFrame },
              settle,
              took_ms: Date.now() - started,
            }),
          },
        ],
        isError: false,
      };
    } catch (e) {
      return structuredErrorFromException(e);
    }
  }
}

export const pressTool = new PressTool();
