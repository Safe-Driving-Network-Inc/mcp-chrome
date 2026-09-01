import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import {
  BaseBrowserToolExecutor,
  BRING_WINDOW_TO_FRONT,
  ACTIVATE_CHANNEL_TAB,
} from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';

interface WebFetcherToolParams {
  htmlContent?: boolean; // get the visible HTML content of the current page. default: false
  textContent?: boolean; // get the visible text content of the current page. default: true
  url?: string; // optional URL to fetch content from (if not provided, uses active tab)
  selector?: string; // optional CSS selector to get content from a specific element
  tabId?: number; // target existing tab id
  background?: boolean; // do not activate/focus
  windowId?: number; // target window id to pick active tab or create tab
  laneId?: string; // which lane's tab to read
  frameId?: number; // read only this frame (default: top frame + meaningful child frames)
}

class WebFetcherTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WEB_FETCHER;

  /**
   * Execute web fetcher operation
   */
  async execute(args: WebFetcherToolParams): Promise<ToolResult> {
    // Handle mutually exclusive parameters: if htmlContent is true, textContent is forced to false
    const htmlContent = args.htmlContent === true;
    const textContent = htmlContent ? false : args.textContent !== false; // Default is true, unless htmlContent is true or textContent is explicitly set to false
    const url = args.url;
    const selector = args.selector;
    const explicitTabId = args.tabId;
    const background = args.background === true;
    const windowId = args.windowId;

    console.log(`Starting web fetcher with options:`, {
      htmlContent,
      textContent,
      url,
      selector,
    });

    try {
      // Get tab to fetch content from
      let tab;

      if (typeof explicitTabId === 'number') {
        tab = await chrome.tabs.get(explicitTabId);
      } else if (url) {
        // If URL is provided, check if it's already open
        console.log(`Checking if URL is already open: ${url}`);
        const allTabs = await chrome.tabs.query({});

        // Find tab with matching URL
        const matchingTabs = allTabs.filter((t) => {
          // Normalize URLs for comparison (remove trailing slashes)
          const tabUrl = t.url?.endsWith('/') ? t.url.slice(0, -1) : t.url;
          const targetUrl = url.endsWith('/') ? url.slice(0, -1) : url;
          return tabUrl === targetUrl;
        });

        if (matchingTabs.length > 0) {
          // Use existing tab
          tab = matchingTabs[0];
          console.log(`Found existing tab with URL: ${url}, tab ID: ${tab.id}`);
        } else {
          // Create new tab with the URL
          console.log(`No existing tab found with URL: ${url}, creating new tab`);
          tab = await chrome.tabs.create({ url, active: background ? false : true });

          // Wait for page to load
          console.log('Waiting for page to load...');
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      } else {
        // Target the lane's single tab (same tab this lane's navigate steers),
        // so a read always reflects the page the agent just navigated to.
        tab = await this.resolveTargetTab({ windowId, laneId: args.laneId });
      }

      if (!tab.id) {
        return createErrorResponse('Tab has no ID');
      }

      // Optionally bring tab/window to foreground
      if (!background) {
        // Fully background by default: don't switch the user's active tab and
        // never raise Chrome to the OS foreground. (read works on a background
        // tab via the injected content script.)
        if (ACTIVATE_CHANNEL_TAB) {
          await chrome.tabs.update(tab.id, { active: true });
        }
        if (BRING_WINDOW_TO_FRONT) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      }

      // Prepare result object
      const result: any = {
        success: true,
        url: tab.url,
        title: tab.title,
      };

      // READ EVERY FRAME. Real apps render dialogs/composers inside a same-origin
      // CHILD frame (LinkedIn's post box is one) — a top-frame-only read then
      // returns the page behind the dialog, so the agent concludes its click did
      // nothing and starts over. Frames are read in order (top first) and joined.
      const frameIds = await this.listFrameIds(tab.id, args.frameId);
      const MIN_FRAME_CHARS = 80; // below this a frame is an ad/tracker/blank shim
      const MAX_EXTRA_FRAME_CHARS = 20000; // don't let odd pages blow up context

      // frameId -> url, purely to label each block in the joined text.
      const frameUrls: Record<number, string> = {};
      if (frameIds.length > 1) {
        try {
          const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
          (frames || []).forEach((f) => {
            frameUrls[f.frameId] = f.url || '';
          });
        } catch (e) {
          /* labels are cosmetic */
        }
      }

      const readFrame = async (fid: number | undefined, action: string) => {
        await this.injectContentScript(
          tab.id!,
          ['inject-scripts/web-fetcher-helper.js'],
          false,
          'ISOLATED',
          false,
          fid === undefined ? undefined : [fid],
        );
        return this.sendMessageToTab(tab.id!, { action, selector: selector }, fid);
      };

      // Get HTML content if requested — first frame that answers wins.
      if (htmlContent) {
        let lastError = '';
        for (const fid of frameIds) {
          try {
            const r = await readFrame(fid, TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_HTML_CONTENT);
            if (r && r.success && r.htmlContent) {
              result.htmlContent = r.htmlContent;
              break;
            }
            lastError = (r && r.error) || lastError;
          } catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
          }
        }
        if (result.htmlContent === undefined) result.htmlContentError = lastError || 'not found';
      }

      // Get text content if requested (and htmlContent is not true)
      if (textContent) {
        let lastError = '';
        let primary: any = null;
        const extras: string[] = [];
        let extraChars = 0;

        for (const fid of frameIds) {
          let r: any = null;
          try {
            r = await readFrame(fid, TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_TEXT_CONTENT);
          } catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
            continue;
          }
          if (!r || !r.success) {
            lastError = (r && r.error) || lastError;
            continue;
          }
          // With a selector, the first frame that matches is the answer.
          if (selector) {
            primary = r;
            break;
          }
          if (!primary) {
            primary = r; // top frame (or first readable frame) owns the metadata
            continue;
          }
          const txt = String(r.textContent || '').trim();
          if (txt.length < MIN_FRAME_CHARS) continue; // ad/tracker/blank frame
          if (extraChars >= MAX_EXTRA_FRAME_CHARS) continue;
          const slice = txt.slice(0, MAX_EXTRA_FRAME_CHARS - extraChars);
          extraChars += slice.length;
          const label = (fid !== undefined && frameUrls[fid]) || `frame ${fid}`;
          extras.push(`\n\n--- frame: ${label} ---\n${slice}`);
        }

        if (primary) {
          result.textContent = String(primary.textContent || '') + extras.join('');
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
        } else {
          console.error('Failed to get text content:', lastError);
          result.textContentError = lastError || 'not found';
        }
      }

      // Interactive elements feature has been removed

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in web fetcher:', error);
      return createErrorResponse(
        `Error fetching web content: ${error instanceof Error ? error.message : String(error)}`,
      );
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

class GetInteractiveElementsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_INTERACTIVE_ELEMENTS;

  /**
   * Execute get interactive elements operation
   */
  async execute(args: GetInteractiveElementsToolParams): Promise<ToolResult> {
    const { textQuery, selector, includeCoordinates = true, types } = args;

    console.log(`Starting get interactive elements with options:`, args);

    try {
      // Get current tab
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) {
        return createErrorResponse('No active tab found');
      }

      const tab = tabs[0];
      if (!tab.id) {
        return createErrorResponse('Active tab has no ID');
      }

      // Ensure content script is injected
      await this.injectContentScript(tab.id, ['inject-scripts/interactive-elements-helper.js']);

      // Send message to content script
      const result = await this.sendMessageToTab(tab.id, {
        action: TOOL_MESSAGE_TYPES.GET_INTERACTIVE_ELEMENTS,
        textQuery,
        selector,
        includeCoordinates,
        types,
      });

      if (!result.success) {
        return createErrorResponse(result.error || 'Failed to get interactive elements');
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              elements: result.elements,
              count: result.elements.length,
              query: {
                textQuery,
                selector,
                types: types || 'all',
              },
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in get interactive elements operation:', error);
      return createErrorResponse(
        `Error getting interactive elements: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const getInteractiveElementsTool = new GetInteractiveElementsTool();
