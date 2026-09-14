// Kareenos Browser Channel v2 — scroll (read-class).
//
// Scrolls the page, a container (by ref / selector / text=), or the nearest
// scrollable ancestor of a target, in ANY frame and through open shadow roots —
// the old version ran document.querySelector in the top frame only and silently
// scrolled the page when the selector missed. A missed target is now NOT_FOUND.
// `direction: into_view` scrolls a target into view. A mini settle reports
// dom_mutations so the agent can tell a virtualized list rendered new rows.
import type { ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { createStructuredError, structuredErrorFromException } from '@/common/browser-errors';
import { K_MSG } from '@/common/kareenos-tool-names';
import { formatRef } from '@/common/browser-refs';
import { listFrames, coreCall } from './core-bridge';
import { resolveTarget, frameMatches } from './target-resolver';

interface ScrollToolParams {
  selector?: string;
  ref?: string;
  frame?: string | number | null;
  direction?: 'down' | 'up' | 'top' | 'bottom' | 'into_view';
  amount?: number;
  tabId?: number;
  windowId?: number;
  laneId?: string;
  timeoutMs?: number;
}

class ScrollTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SCROLL;

  async execute(args: ScrollToolParams): Promise<ToolResult> {
    const direction = (['down', 'up', 'top', 'bottom', 'into_view'] as const).includes(args.direction as any) ? args.direction! : 'down';
    const laneId = args.laneId || 'default';
    if (direction === 'into_view' && !args.ref && !args.selector) {
      return createStructuredError('NOT_FOUND', 'direction "into_view" needs a ref or selector');
    }
    try {
      const tab = await this.resolveTargetTab(args);
      if (!tab.id) return createStructuredError('NO_FRAME_ACCESS', 'The channel tab has no id');
      const tabId = tab.id;

      let frameId = 0;
      let frameUrl = '';
      const msg: Record<string, any> = { action: K_MSG.SCROLL, direction, amount: typeof args.amount === 'number' ? args.amount : undefined };
      let targetRef: string | undefined;
      if (args.ref || args.selector) {
        const t = await resolveTarget(tabId, laneId, { ref: args.ref, selector: args.selector, frame: args.frame, kind: 'any' });
        frameId = t.frameId;
        frameUrl = t.frameUrl;
        msg.ref = t.helperRef;
        msg.expect_epoch = t.expectEpoch;
        targetRef = t.ref;
      } else {
        const frames = await listFrames(tabId);
        const f = frames.find((x) => frameMatches(x, args.frame)) || frames[0];
        frameId = f.frameId;
        frameUrl = f.url;
      }

      const r = await coreCall(tabId, frameId, msg);
      let mini: any = null;
      try {
        mini = await coreCall(tabId, frameId, { action: K_MSG.QUIET_WAIT, quiet_ms: 150, cap_ms: 1000 });
      } catch (e) {
        mini = null;
      }
      const out: Record<string, any> = {
        success: true,
        message: r.scrolled ? `Scrolled ${direction}` : `Nothing to scroll (${direction}) — already at the ${direction === 'up' || direction === 'top' ? 'top' : 'end'}`,
        scrolled: !!r.scrolled,
        direction,
        scrollTop: r.scrollTop,
        scrollHeight: r.scrollHeight,
        clientHeight: r.clientHeight,
        atTop: r.atTop,
        atBottom: r.atBottom,
        container: r.container,
        frame: { id: frameId, url: frameUrl || undefined },
        target: r.target ? { ref: targetRef || formatRef(frameId, r.target.ref), role: r.target.role, name: r.target.name, in_viewport: r.in_viewport } : undefined,
        settle: mini ? { dom_mutations: mini.mutations, quiet_ms: mini.waited_ms, capped: !!mini.capped } : undefined,
      };
      return { content: [{ type: 'text', text: JSON.stringify(out) }], isError: false };
    } catch (e) {
      return structuredErrorFromException(e);
    }
  }
}

export const scrollTool = new ScrollTool();
