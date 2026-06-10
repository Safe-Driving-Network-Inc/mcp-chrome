import { ToolExecutor } from '@/common/tool-handler';
import type { ToolResult } from '@/common/tool-handler';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';

const PING_TIMEOUT_MS = 300;

// Kareenos attended browser channel — the agent drives exactly ONE tab (the
// "channel tab"). Its id is pinned in chrome.storage.session so every tool
// (navigate / read / click / fill / scroll / screenshot) targets the SAME tab,
// surviving the ephemeral MV3 service worker within a browser session. Without
// this, each tool independently guessed "the active tab" and they disagreed —
// navigate touched tab A while read read tab B — which made the agent's view of
// the page incoherent and sent it into a tab-spawning loop.
const CHANNEL_TAB_KEY = 'kareenos:channelTabId';

/**
 * Base class for browser tool executors
 */
export abstract class BaseBrowserToolExecutor implements ToolExecutor {
  abstract name: string;
  abstract execute(args: any): Promise<ToolResult>;

  /** Read the pinned channel-tab id (null when unset). */
  protected async getChannelTabId(): Promise<number | null> {
    try {
      const o = await chrome.storage.session.get(CHANNEL_TAB_KEY);
      const id = o?.[CHANNEL_TAB_KEY];
      return typeof id === 'number' ? id : null;
    } catch {
      return null;
    }
  }

  /** Pin (or clear, when null) the channel tab the agent drives. */
  protected async setChannelTab(tab: chrome.tabs.Tab | number | null): Promise<void> {
    const id = typeof tab === 'number' ? tab : (tab?.id ?? null);
    try {
      if (id == null) await chrome.storage.session.remove(CHANNEL_TAB_KEY);
      else await chrome.storage.session.set({ [CHANNEL_TAB_KEY]: id });
    } catch {
      /* storage.session unavailable — fall back to per-call active-tab resolution */
    }
  }

  /**
   * Resolve the single tab the agent drives ("channel tab"). Order:
   *   1. explicit args.tabId
   *   2. the pinned channel tab, if it still exists
   *   3. the active tab in the focused window — which then BECOMES the channel tab
   * Guarantees navigate/read/click/fill/scroll/screenshot all act on ONE tab.
   */
  protected async resolveTargetTab(args?: {
    tabId?: number;
    windowId?: number;
  }): Promise<chrome.tabs.Tab> {
    // 1. explicit tab id wins and (re)pins the channel tab
    const explicit = await this.tryGetTab(args?.tabId);
    if (explicit && explicit.id) {
      await this.setChannelTab(explicit);
      return explicit;
    }
    // 2. pinned channel tab, if still alive
    const pinnedId = await this.getChannelTabId();
    if (pinnedId != null) {
      const pinned = await this.tryGetTab(pinnedId);
      if (pinned && pinned.id) return pinned;
    }
    // 3. fall back to the active tab and adopt it as the channel tab
    const active = await this.getActiveTabInWindow(args?.windowId);
    if (active && active.id) {
      await this.setChannelTab(active);
      return active;
    }
    throw new Error('No channel tab available — open a tab and try again');
  }

  /**
   * Wait until a tab finishes loading (status 'complete'), or until timeout.
   * navigate() must await this before returning so a subsequent read/click does
   * not race an un-loaded page (a key cause of the stale-read loop).
   */
  protected async waitForTabLoad(tabId: number, timeoutMs = 15000): Promise<void> {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') return;
    } catch {
      return;
    }
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          chrome.tabs.onUpdated.removeListener(listener);
        } catch {
          /* noop */
        }
        clearTimeout(timer);
        resolve();
      };
      const listener = (updatedId: number, info: chrome.tabs.TabChangeInfo) => {
        if (updatedId === tabId && info.status === 'complete') finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      try {
        chrome.tabs.onUpdated.addListener(listener);
      } catch {
        finish();
      }
    });
  }

  /**
   * Inject content script into tab
   */
  protected async injectContentScript(
    tabId: number,
    files: string[],
    injectImmediately = false,
    world: 'MAIN' | 'ISOLATED' = 'ISOLATED',
    allFrames: boolean = false,
    frameIds?: number[],
  ): Promise<void> {
    console.log(`Injecting ${files.join(', ')} into tab ${tabId}`);

    // check if script is already injected
    try {
      const pingFrameId = frameIds?.[0];
      const response = await Promise.race([
        typeof pingFrameId === 'number'
          ? chrome.tabs.sendMessage(
              tabId,
              { action: `${this.name}_ping` },
              { frameId: pingFrameId },
            )
          : chrome.tabs.sendMessage(tabId, { action: `${this.name}_ping` }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`${this.name} Ping action to tab ${tabId} timed out`)),
            PING_TIMEOUT_MS,
          ),
        ),
      ]);

      if (response && response.status === 'pong') {
        console.log(
          `pong received for action '${this.name}' in tab ${tabId}. Assuming script is active.`,
        );
        return;
      } else {
        console.warn(`Unexpected ping response in tab ${tabId}:`, response);
      }
    } catch (error) {
      console.error(
        `ping content script failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const target: { tabId: number; allFrames?: boolean; frameIds?: number[] } = { tabId };
      if (frameIds && frameIds.length > 0) {
        target.frameIds = frameIds;
      } else if (allFrames) {
        target.allFrames = true;
      }
      await chrome.scripting.executeScript({
        target,
        files,
        injectImmediately,
        world,
      } as any);
      console.log(`'${files.join(', ')}' injection successful for tab ${tabId}`);
    } catch (injectionError) {
      const errorMessage =
        injectionError instanceof Error ? injectionError.message : String(injectionError);
      console.error(
        `Content script '${files.join(', ')}' injection failed for tab ${tabId}: ${errorMessage}`,
      );
      throw new Error(
        `${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: Failed to inject content script in tab ${tabId}: ${errorMessage}`,
      );
    }
  }

  /**
   * Send message to tab
   */
  protected async sendMessageToTab(tabId: number, message: any, frameId?: number): Promise<any> {
    try {
      const response =
        typeof frameId === 'number'
          ? await chrome.tabs.sendMessage(tabId, message, { frameId })
          : await chrome.tabs.sendMessage(tabId, message);

      if (response && response.error) {
        throw new Error(String(response.error));
      }

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `Error sending message to tab ${tabId} for action ${message?.action || 'unknown'}: ${errorMessage}`,
      );

      if (error instanceof Error) {
        throw error;
      }
      throw new Error(errorMessage);
    }
  }

  /**
   * Try to get an existing tab by id. Returns null when not found.
   */
  protected async tryGetTab(tabId?: number): Promise<chrome.tabs.Tab | null> {
    if (typeof tabId !== 'number') return null;
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  /**
   * Get the active tab in the current window. Throws when not found.
   */
  protected async getActiveTabOrThrow(): Promise<chrome.tabs.Tab> {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active || !active.id) throw new Error('Active tab not found');
    return active;
  }

  /**
   * Optionally focus window and/or activate tab. Defaults preserve current behavior
   * when caller sets activate/focus flags explicitly.
   */
  protected async ensureFocus(
    tab: chrome.tabs.Tab,
    options: { activate?: boolean; focusWindow?: boolean } = {},
  ): Promise<void> {
    const activate = options.activate === true;
    const focusWindow = options.focusWindow === true;
    if (focusWindow && typeof tab.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    if (activate && typeof tab.id === 'number') {
      await chrome.tabs.update(tab.id, { active: true });
    }
  }

  /**
   * Get the active tab. When windowId provided, search within that window; otherwise currentWindow.
   */
  protected async getActiveTabInWindow(windowId?: number): Promise<chrome.tabs.Tab | null> {
    if (typeof windowId === 'number') {
      const tabs = await chrome.tabs.query({ active: true, windowId });
      return tabs && tabs[0] ? tabs[0] : null;
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  /**
   * Same as getActiveTabInWindow, but throws if not found.
   */
  protected async getActiveTabOrThrowInWindow(windowId?: number): Promise<chrome.tabs.Tab> {
    const tab = await this.getActiveTabInWindow(windowId);
    if (!tab || !tab.id) throw new Error('Active tab not found');
    return tab;
  }
}
