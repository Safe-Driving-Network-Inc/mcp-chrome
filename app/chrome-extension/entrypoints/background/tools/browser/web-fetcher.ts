// Kareenos Browser Channel v2 — read (chrome_get_web_content → platform "read").
//
// Reads the lane's tab as visible TEXT. Without a selector every frame is read
// (top first, meaningful child frames appended under `--- frame: <url> ---`).
// With a selector, every frame is searched and the FIRST FRAME WHERE IT MATCHES
// answers — the old loop accepted the top frame's "not matched, here is the
// whole page anyway" reply, so a selector that only existed in a child frame was
// never found and the agent could not even tell (selectorMatched was dropped).
// Line structure is preserved (lists/tables stay readable) and the output is
// capped by max_chars.
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import {
  BaseBrowserToolExecutor,
  bringWindowToFront,
  activateChannelTab,
} from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { createStructuredError, structuredErrorFromException, toBrowserError } from '@/common/browser-errors';
import { listFrames, ensureCore, type FrameInfo } from './core-bridge';
import { frameMatches } from './target-resolver';

interface WebFetcherToolParams {
  htmlContent?: boolean; // get the visible HTML content of the current page. default: false
  textContent?: boolean; // get the visible text content of the current page. default: true
  url?: string; // optional URL to fetch content from (if not provided, uses active tab)
  selector?: string; // optional CSS / text= selector to get content from a specific element
  tabId?: number; // target existing tab id
  background?: boolean; // do not activate/focus
  windowId?: number; // target window id to pick active tab or create tab
  laneId?: string; // which lane's tab to read
  frameId?: number; // read only this frame id
  frame?: string | number | null; // f3 / 3 / URL substring — restrict the frames read
  maxChars?: number; // cap on the returned text (default 30000)
  timeoutMs?: number;
}

const READ_DEFAULT_CHARS = 30000;
const READ_MAX_CHARS = 100000;

class WebFetcherTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WEB_FETCHER;

  async execute(args: WebFetcherToolParams): Promise<ToolResult> {
    // Handle mutually exclusive parameters: if htmlContent is true, textContent is forced to false
    const htmlContent = args.htmlContent === true;
    const textContent = htmlContent ? false : args.textContent !== false;
    const url = args.url;
    const selector = (args.selector || '').trim() || undefined;
    const explicitTabId = args.tabId;
    const background = args.background === true;
    const windowId = args.windowId;
    const maxChars = Math.max(1000, Math.min(Number(args.maxChars) || READ_DEFAULT_CHARS, READ_MAX_CHARS));

    try {
      let tab: chrome.tabs.Tab;
      if (typeof explicitTabId === 'number') {
        tab = await chrome.tabs.get(explicitTabId);
      } else if (url) {
        const allTabs = await chrome.tabs.query({});
        const matchingTabs = allTabs.filter((t) => {
          const tabUrl = t.url?.endsWith('/') ? t.url.slice(0, -1) : t.url;
          const targetUrl = url.endsWith('/') ? url.slice(0, -1) : url;
          return tabUrl === targetUrl;
        });
        if (matchingTabs.length > 0) {
          tab = matchingTabs[0];
        } else {
          tab = await chrome.tabs.create({ url, active: background ? false : true });
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      } else {
        // Target the lane's single tab (same tab this lane's navigate steers),
        // so a read always reflects the page the agent just navigated to.
        tab = await this.resolveTargetTab({ windowId, laneId: args.laneId });
      }
      if (!tab.id) return createErrorResponse('Tab has no ID');
      const tabId = tab.id;

      if (!background) {
        if (activateChannelTab()) await chrome.tabs.update(tabId, { active: true });
        if (bringWindowToFront()) await chrome.windows.update(tab.windowId, { focused: true });
      }

      const result: any = { success: true, url: tab.url, title: tab.title };

      let frames: FrameInfo[] = await listFrames(tabId);
      if (typeof args.frameId === 'number') frames = frames.filter((f) => f.frameId === args.frameId);
      else frames = frames.filter((f) => frameMatches(f, args.frame));
      if (!frames.length) {
        return createStructuredError('NO_FRAME_ACCESS', `No frame matches "${args.frame ?? args.frameId}" on this page.`);
      }
      const MIN_FRAME_CHARS = 80; // below this a frame is an ad/tracker/blank shim
      const MAX_EXTRA_FRAME_CHARS = 20000;

      const readFrame = async (f: FrameInfo, action: string) => {
        if (selector) {
          // text= selectors resolve through the core; make sure it is there.
          try {
            await ensureCore(tabId, f.frameId);
          } catch (e) {
            /* the helper's own deep query still runs */
          }
        }
        await this.injectContentScript(tabId, ['inject-scripts/web-fetcher-helper.js'], false, 'ISOLATED', false, [f.frameId]);
        return this.sendMessageToTab(tabId, { action, selector }, f.frameId);
      };

      const framesRead: number[] = [];
      if (htmlContent) {
        let lastError = '';
        for (const f of frames) {
          try {
            const r = await readFrame(f, TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_HTML_CONTENT);
            if (r && r.success && r.htmlContent) {
              result.htmlContent = r.htmlContent;
              result.frame = { id: f.frameId, url: f.url };
              break;
            }
            lastError = (r && r.error) || lastError;
          } catch (e) {
            lastError = toBrowserError(e).message;
          }
        }
        if (result.htmlContent === undefined) result.htmlContentError = lastError || 'not found';
      }

      if (textContent) {
        let primary: any = null;
        let primaryFrame: FrameInfo | null = null;
        const extras: string[] = [];
        let extraChars = 0;
        let lastErr: any = null;

        for (const f of frames) {
          let r: any = null;
          try {
            r = await readFrame(f, TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_TEXT_CONTENT);
          } catch (e) {
            lastErr = toBrowserError(e);
            continue; // NOT_FOUND in this frame / frame not scriptable → try the next
          }
          if (!r || !r.success) {
            lastErr = toBrowserError(new Error((r && r.error) || 'read failed'));
            continue;
          }
          framesRead.push(f.frameId);
          if (selector) {
            if (r.selectorMatched === false) continue;
            primary = r;
            primaryFrame = f;
            break; // the first frame where the selector MATCHES answers
          }
          if (!primary) {
            primary = r; // top frame (or first readable frame) owns the metadata
            primaryFrame = f;
            continue;
          }
          const txt = String(r.textContent || '').trim();
          if (txt.length < MIN_FRAME_CHARS) continue;
          if (extraChars >= MAX_EXTRA_FRAME_CHARS) continue;
          const slice = txt.slice(0, MAX_EXTRA_FRAME_CHARS - extraChars);
          extraChars += slice.length;
          extras.push(`\n\n--- frame f${f.frameId}: ${f.url || 'about:blank'} ---\n${slice}`);
        }

        if (!primary) {
          if (selector) {
            return createStructuredError('NOT_FOUND', `Nothing matches "${selector}" in ${frames.length} frame(s). Take a browser_snapshot to see the page, or read without a selector.`, {
              selector,
              frames_searched: frames.map((f) => f.frameId),
              last_error: lastErr ? lastErr.message : undefined,
            });
          }
          return createStructuredError(lastErr ? lastErr.code : 'NO_FRAME_ACCESS', lastErr ? lastErr.message : 'No frame of this page could be read.');
        }

        let text = String(primary.textContent || '') + extras.join('');
        result.truncated = false;
        if (text.length > maxChars) {
          text = text.slice(0, maxChars) + '\n… (truncated at max_chars — pass a selector, a frame, or raise max_chars)';
          result.truncated = true;
        }
        result.textContent = text;
        result.max_chars = maxChars;
        result.frame = primaryFrame ? { id: primaryFrame.frameId, url: primaryFrame.url } : undefined;
        result.selector_matched = selector ? true : undefined;
        result.frames_read = framesRead;
        if (extras.length) result.framesIncluded = extras.length;
        if (primary.article) {
          result.article = {
            title: primary.article.title,
            byline: primary.article.byline,
            siteName: primary.article.siteName,
            excerpt: primary.article.excerpt,
            lang: primary.article.lang,
          };
        }
        if (primary.metadata) result.metadata = primary.metadata;
      }

      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
    } catch (error) {
      return structuredErrorFromException(error);
    }
  }
}

export const webFetcherTool = new WebFetcherTool();

interface GetInteractiveElementsToolParams {
  textQuery?: string; // Text to search for within interactive elements (fuzzy search)
  selector?: string; // CSS selector to filter interactive elements
  includeCoordinates?: boolean; // Include element coordinates in the response (default: true)
  types?: string[]; // Types of interactive elements to include (default: all types)
}

// Upstream tool, NOT registered on the channel (browser_snapshot supersedes it).
class GetInteractiveElementsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_INTERACTIVE_ELEMENTS;

  async execute(args: GetInteractiveElementsToolParams): Promise<ToolResult> {
    const { textQuery, selector, includeCoordinates = true, types } = args;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) return createErrorResponse('No active tab found');
      const tab = tabs[0];
      if (!tab.id) return createErrorResponse('Active tab has no ID');
      await this.injectContentScript(tab.id, ['inject-scripts/interactive-elements-helper.js']);
      const result = await this.sendMessageToTab(tab.id, {
        action: TOOL_MESSAGE_TYPES.GET_INTERACTIVE_ELEMENTS,
        textQuery,
        selector,
        includeCoordinates,
        types,
      });
      if (!result.success) return createErrorResponse(result.error || 'Failed to get interactive elements');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              elements: result.elements,
              count: result.elements.length,
              query: { textQuery, selector, types: types || 'all' },
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error getting interactive elements: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const getInteractiveElementsTool = new GetInteractiveElementsTool();
