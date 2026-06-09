import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';

// Kareenos Browser Channel — scroll tool (read-class). Lets an agent advance a
// page or a scrollable container (e.g. a virtualized list like LinkedIn's
// messaging sidebar) so off-screen items render into the DOM and become
// readable / clickable. Not side-effecting → never hits the approval gate.

interface ScrollToolParams {
  selector?: string; // optional CSS selector of the scroll container; omitted = the page
  direction?: 'down' | 'up' | 'top' | 'bottom'; // default 'down'
  amount?: number; // pixels for up/down; default ~85% of the container's viewport
  tabId?: number;
  windowId?: number;
}

class ScrollTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SCROLL;

  async execute(args: ScrollToolParams): Promise<ToolResult> {
    const { selector, direction = 'down', amount } = args;
    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse('Active tab has no ID');
      }

      const [{ result } = { result: null }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        // Runs in the page. Returns the post-scroll position so the agent can tell
        // whether more content is available (atBottom) and loop if needed.
        func: (sel: string | null, dir: string, amt: number | null) => {
          let el: any = null;
          if (sel) el = document.querySelector(sel);
          // Fall back to the document's scrolling element when no selector (or it
          // isn't itself scrollable).
          const scroller =
            el && el.scrollHeight > el.clientHeight
              ? el
              : document.scrollingElement || document.documentElement || document.body;
          if (!scroller) return { error: 'No scrollable element found' };
          const step =
            typeof amt === 'number' && amt > 0 ? amt : Math.floor(scroller.clientHeight * 0.85);
          const before = scroller.scrollTop;
          if (dir === 'top') scroller.scrollTop = 0;
          else if (dir === 'bottom') scroller.scrollTop = scroller.scrollHeight;
          else if (dir === 'up') scroller.scrollTop = Math.max(0, before - step);
          else scroller.scrollTop = before + step; // 'down'
          const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
          const atTop = scroller.scrollTop <= 0;
          return {
            scrolled: scroller.scrollTop !== before,
            scrollTop: scroller.scrollTop,
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight,
            atBottom,
            atTop,
            usedSelector: sel || null,
          };
        },
        args: [selector || null, direction, typeof amount === 'number' ? amount : null],
      });

      if (result && (result as any).error) {
        return createErrorResponse((result as any).error);
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result || { scrolled: false }) }],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error scrolling: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const scrollTool = new ScrollTool();
