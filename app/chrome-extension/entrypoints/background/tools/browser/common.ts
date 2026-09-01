import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import {
  BaseBrowserToolExecutor,
  BRING_WINDOW_TO_FRONT,
  ACTIVATE_CHANNEL_TAB,
  DEFAULT_LANE,
} from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';

// Default window dimensions
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 720;

interface NavigateToolParams {
  url?: string;
  newWindow?: boolean;
  width?: number;
  height?: number;
  refresh?: boolean;
  tabId?: number;
  windowId?: number;
  background?: boolean; // when true, do not activate tab or focus window
  laneId?: string; // which lane's tab this navigation drives/creates
}

/**
 * Tool for navigating to URLs in browser tabs or windows
 */
class NavigateTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NAVIGATE;

  /**
   * Auto-capture hook removed for the Kareenos browser channel (GIF recording is
   * out of scope). Kept as a no-op so existing call sites need no change.
   */
  private async triggerAutoCapture(_tabId: number, _url?: string): Promise<void> {
    return;
  }

  async execute(args: NavigateToolParams): Promise<ToolResult> {
    const {
      newWindow = false,
      width,
      height,
      url,
      refresh = false,
      tabId,
      background,
      windowId,
    } = args;
    const laneId = args.laneId || DEFAULT_LANE;

    console.log(
      `Attempting to ${refresh ? 'refresh current tab' : `open URL: ${url}`} with options:`,
      args,
    );

    try {
      // Handle refresh option first
      if (refresh) {
        console.log('Refreshing current active tab');
        const explicit = await this.tryGetTab(tabId);
        // Get target tab (explicit or active in provided window)
        const targetTab = explicit || (await this.getActiveTabOrThrowInWindow(windowId));
        if (!targetTab.id) return createErrorResponse('No target tab found to refresh');
        await chrome.tabs.reload(targetTab.id);

        console.log(`Refreshed tab ID: ${targetTab.id}`);

        // Get updated tab information
        const updatedTab = await chrome.tabs.get(targetTab.id);

        // Trigger auto-capture on refresh
        await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Successfully refreshed current tab',
                tabId: updatedTab.id,
                windowId: updatedTab.windowId,
                url: updatedTab.url,
              }),
            },
          ],
          isError: false,
        };
      }

      // Validate that url is provided when not refreshing
      if (!url) {
        return createErrorResponse('URL parameter is required when refresh is not true');
      }

      // Handle history navigation: url="back" or url="forward"
      if (url === 'back' || url === 'forward') {
        const explicitTab = await this.tryGetTab(tabId);
        const targetTab = explicitTab || (await this.getActiveTabOrThrowInWindow(windowId));
        if (!targetTab.id) {
          return createErrorResponse('No target tab found for history navigation');
        }

        // Respect background flag for focus behavior
        await this.ensureFocus(targetTab, {
          activate: background !== true,
          focusWindow: background !== true,
        });

        if (url === 'forward') {
          await chrome.tabs.goForward(targetTab.id);
          console.log(`Navigated forward in tab ID: ${targetTab.id}`);
        } else {
          await chrome.tabs.goBack(targetTab.id);
          console.log(`Navigated back in tab ID: ${targetTab.id}`);
        }

        const updatedTab = await chrome.tabs.get(targetTab.id);

        // Trigger auto-capture on history navigation
        await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Successfully navigated ${url} in browser history`,
                tabId: updatedTab.id,
                windowId: updatedTab.windowId,
                url: updatedTab.url,
              }),
            },
          ],
          isError: false,
        };
      }

      // Attended browser channel: each LANE drives EXACTLY ONE tab. Navigation
      // happens IN PLACE on that lane's tab — we do not open a new tab per URL
      // (the old per-path matching spawned a tab on every hop and let read/click
      // drift to a different tab). A new tab/window is created only on explicit
      // opt-in (newWindow / width / height) or when the lane has no tab yet —
      // which is how each concurrent agent task gets its own dedicated tab.
      const openInNewWindow = newWindow || typeof width === 'number' || typeof height === 'number';

      if (!openInNewWindow) {
        // Steer ONLY an explicit tab or the lane's already-pinned tab. Do NOT
        // adopt the user's currently-active tab here — navigating it in place
        // would hijack whatever the user is looking at (e.g. the agent-runner
        // tab itself, or ANOTHER lane's tab). When the lane has no tab yet,
        // fall through to OPEN A NEW dedicated tab below.
        let channelTab: chrome.tabs.Tab | null = await this.tryGetTab(tabId);
        if (!channelTab) {
          const pinnedId = await this.getChannelTabId(laneId);
          if (pinnedId != null) channelTab = await this.tryGetTab(pinnedId);
        }

        if (channelTab && typeof channelTab.id === 'number') {
          await chrome.tabs.update(channelTab.id, {
            url,
            active: ACTIVATE_CHANNEL_TAB && background !== true,
          });
          if (
            background !== true &&
            BRING_WINDOW_TO_FRONT &&
            typeof channelTab.windowId === 'number'
          ) {
            await chrome.windows.update(channelTab.windowId, { focused: true });
          }
          // Wait for the page to settle so a following read/click sees the new page.
          await this.waitForTabLoad(channelTab.id);
          await this.setChannelTab(channelTab.id, laneId);

          const updatedTab = await chrome.tabs.get(channelTab.id);
          await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Navigated channel tab',
                  tabId: updatedTab.id,
                  windowId: updatedTab.windowId,
                  url: updatedTab.url,
                }),
              },
            ],
            isError: false,
          };
        }
        // No channel tab yet → fall through to create one (and pin it below).
      }

      if (openInNewWindow) {
        console.log('Opening URL in a new window.');

        // Create new window
        const newWindow = await chrome.windows.create({
          url: url,
          width: typeof width === 'number' ? width : DEFAULT_WINDOW_WIDTH,
          height: typeof height === 'number' ? height : DEFAULT_WINDOW_HEIGHT,
          focused: background !== true && BRING_WINDOW_TO_FRONT,
        });

        if (newWindow && newWindow.id !== undefined) {
          console.log(`URL opened in new Window ID: ${newWindow.id}`);

          // Trigger auto-capture if the new window has a tab
          const firstTab = newWindow.tabs?.[0];
          if (firstTab?.id) {
            // Adopt the new window's tab as this lane's tab subsequent tools drive.
            await this.setChannelTab(firstTab.id, laneId);
            await this.waitForTabLoad(firstTab.id);
            await this.triggerAutoCapture(firstTab.id, firstTab.url);
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Opened URL in new window',
                  windowId: newWindow.id,
                  tabs: newWindow.tabs
                    ? newWindow.tabs.map((tab) => ({
                        tabId: tab.id,
                        url: tab.url,
                      }))
                    : [],
                }),
              },
            ],
            isError: false,
          };
        }
      } else {
        console.log('Opening URL in the last active window.');
        // Try to open a new tab in the specified window, otherwise the most recently active window
        let targetWindow: chrome.windows.Window | null = null;
        if (typeof windowId === 'number') {
          targetWindow = await chrome.windows.get(windowId, { populate: false });
        }
        if (!targetWindow) {
          targetWindow = await chrome.windows.getLastFocused({ populate: false });
        }

        if (targetWindow && targetWindow.id !== undefined) {
          console.log(`Found target Window ID: ${targetWindow.id}`);

          const newTab = await chrome.tabs.create({
            url: url,
            windowId: targetWindow.id,
            active: ACTIVATE_CHANNEL_TAB && background !== true,
          });
          if (background !== true && BRING_WINDOW_TO_FRONT) {
            await chrome.windows.update(targetWindow.id, { focused: true });
          }

          console.log(
            `URL opened in new Tab ID: ${newTab.id} in existing Window ID: ${targetWindow.id}`,
          );

          // This newly created tab becomes the lane's single tab the agent drives.
          if (newTab.id) {
            await this.setChannelTab(newTab.id, laneId);
            await this.waitForTabLoad(newTab.id);
            await this.triggerAutoCapture(newTab.id, newTab.url);
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Opened channel tab',
                  tabId: newTab.id,
                  windowId: targetWindow.id,
                  url: newTab.url,
                }),
              },
            ],
            isError: false,
          };
        } else {
          // In rare cases, if there's no recently active window (e.g., browser just started with no windows)
          // Fall back to opening in a new window
          console.warn('No last focused window found, falling back to creating a new window.');

          const fallbackWindow = await chrome.windows.create({
            url: url,
            width: DEFAULT_WINDOW_WIDTH,
            height: DEFAULT_WINDOW_HEIGHT,
            focused: BRING_WINDOW_TO_FRONT,
          });

          if (fallbackWindow && fallbackWindow.id !== undefined) {
            console.log(`URL opened in fallback new Window ID: ${fallbackWindow.id}`);

            // Trigger auto-capture if fallback window has a tab
            const firstTab = fallbackWindow.tabs?.[0];
            if (firstTab?.id) {
              await this.setChannelTab(firstTab.id, laneId);
              await this.waitForTabLoad(firstTab.id);
              await this.triggerAutoCapture(firstTab.id, firstTab.url);
            }

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: 'Opened URL in new window',
                    windowId: fallbackWindow.id,
                    tabs: fallbackWindow.tabs
                      ? fallbackWindow.tabs.map((tab) => ({
                          tabId: tab.id,
                          url: tab.url,
                        }))
                      : [],
                  }),
                },
              ],
              isError: false,
            };
          }
        }
      }

      // If all attempts fail, return a generic error
      return createErrorResponse('Failed to open URL: Unknown error occurred');
    } catch (error) {
      if (chrome.runtime.lastError) {
        console.error(`Chrome API Error: ${chrome.runtime.lastError.message}`, error);
        return createErrorResponse(`Chrome API Error: ${chrome.runtime.lastError.message}`);
      } else {
        console.error('Error in navigate:', error);
        return createErrorResponse(
          `Error navigating to URL: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
export const navigateTool = new NavigateTool();

interface CloseTabsToolParams {
  tabIds?: number[];
  url?: string;
}

/**
 * Tool for closing browser tabs
 */
class CloseTabsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLOSE_TABS;

  async execute(args: CloseTabsToolParams): Promise<ToolResult> {
    const { tabIds, url } = args;
    let urlPattern = url;
    console.log(`Attempting to close tabs with options:`, args);

    try {
      // If URL is provided, close all tabs matching that URL
      if (urlPattern) {
        console.log(`Searching for tabs with URL: ${url}`);
        try {
          // Build a proper Chrome match pattern from a concrete URL.
          // If caller already provided a match pattern with '*', use as-is.
          if (!urlPattern.includes('*')) {
            // Ignore search/hash; match by origin + pathname prefix.
            // Use URL to normalize; fallback to simple suffixing when parsing fails.
            try {
              const u = new URL(urlPattern);
              const basePath = u.pathname || '/';
              const pathWithWildcard = basePath.endsWith('/') ? `${basePath}*` : `${basePath}/*`;
              urlPattern = `${u.protocol}//${u.host}${pathWithWildcard}`;
            } catch {
              // Not a fully-qualified URL; ensure it ends with wildcard
              urlPattern = urlPattern.endsWith('/') ? `${urlPattern}*` : `${urlPattern}/*`;
            }
          }
        } catch {
          // Best-effort: ensure we have some wildcard
          urlPattern = urlPattern.endsWith('*')
            ? urlPattern
            : urlPattern.endsWith('/')
              ? `${urlPattern}*`
              : `${urlPattern}/*`;
        }

        const tabs = await chrome.tabs.query({ url: urlPattern });

        if (!tabs || tabs.length === 0) {
          console.log(`No tabs found with URL pattern: ${urlPattern}`);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  message: `No tabs found with URL pattern: ${urlPattern}`,
                  closedCount: 0,
                }),
              },
            ],
            isError: false,
          };
        }

        console.log(`Found ${tabs.length} tabs with URL pattern: ${urlPattern}`);
        const tabIdsToClose = tabs
          .map((tab) => tab.id)
          .filter((id): id is number => id !== undefined);

        if (tabIdsToClose.length === 0) {
          return createErrorResponse('Found tabs but could not get their IDs');
        }

        await chrome.tabs.remove(tabIdsToClose);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Closed ${tabIdsToClose.length} tabs with URL: ${url}`,
                closedCount: tabIdsToClose.length,
                closedTabIds: tabIdsToClose,
              }),
            },
          ],
          isError: false,
        };
      }

      // If tabIds are provided, close those tabs
      if (tabIds && tabIds.length > 0) {
        console.log(`Closing tabs with IDs: ${tabIds.join(', ')}`);

        // Verify that all tabIds exist
        const existingTabs = await Promise.all(
          tabIds.map(async (tabId) => {
            try {
              return await chrome.tabs.get(tabId);
            } catch (error) {
              console.warn(`Tab with ID ${tabId} not found`);
              return null;
            }
          }),
        );

        const validTabIds = existingTabs
          .filter((tab): tab is chrome.tabs.Tab => tab !== null)
          .map((tab) => tab.id)
          .filter((id): id is number => id !== undefined);

        if (validTabIds.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  message: 'None of the provided tab IDs exist',
                  closedCount: 0,
                }),
              },
            ],
            isError: false,
          };
        }

        await chrome.tabs.remove(validTabIds);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Closed ${validTabIds.length} tabs`,
                closedCount: validTabIds.length,
                closedTabIds: validTabIds,
                invalidTabIds: tabIds.filter((id) => !validTabIds.includes(id)),
              }),
            },
          ],
          isError: false,
        };
      }

      // If no tabIds or URL provided, close the current active tab
      console.log('No tabIds or URL provided, closing active tab');
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!activeTab || !activeTab.id) {
        return createErrorResponse('No active tab found');
      }

      await chrome.tabs.remove(activeTab.id);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Closed active tab',
              closedCount: 1,
              closedTabIds: [activeTab.id],
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in CloseTabsTool.execute:', error);
      return createErrorResponse(
        `Error closing tabs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const closeTabsTool = new CloseTabsTool();

interface SwitchTabToolParams {
  tabId: number;
  windowId?: number;
}

/**
 * Tool for switching the active tab
 */
class SwitchTabTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SWITCH_TAB;

  async execute(args: SwitchTabToolParams): Promise<ToolResult> {
    const { tabId, windowId } = args;

    console.log(`Attempting to switch to tab ID: ${tabId} in window ID: ${windowId}`);

    try {
      if (windowId !== undefined) {
        await chrome.windows.update(windowId, { focused: true });
      }
      await chrome.tabs.update(tabId, { active: true });

      const updatedTab = await chrome.tabs.get(tabId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Successfully switched to tab ID: ${tabId}`,
              tabId: updatedTab.id,
              windowId: updatedTab.windowId,
              url: updatedTab.url,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      if (chrome.runtime.lastError) {
        console.error(`Chrome API Error: ${chrome.runtime.lastError.message}`, error);
        return createErrorResponse(`Chrome API Error: ${chrome.runtime.lastError.message}`);
      } else {
        console.error('Error in SwitchTabTool.execute:', error);
        return createErrorResponse(
          `Error switching tab: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

export const switchTabTool = new SwitchTabTool();
