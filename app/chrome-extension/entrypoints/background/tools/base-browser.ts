import { ToolExecutor } from '@/common/tool-handler';
import type { ToolResult } from '@/common/tool-handler';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { errorFromResponse } from '@/common/browser-errors';

const PING_TIMEOUT_MS = 300;

// Attended channel must be NON-INTRUSIVE: the agent works in the background and
// must never raise Chrome to the OS foreground over whatever app the user is in.
// When false (default) we never call chrome.windows.update({focused:true}) and
// never create focused windows. The agent's tab is still kept ACTIVE within its
// own window — so the user sees progress when they switch to Chrome themselves,
// and screenshot's captureVisibleTab targets the right tab — but Chrome never
// pops in front. Flip to true only if you want the browser to follow the agent.
export const BRING_WINDOW_TO_FRONT = false;

// Keep the agent's tab ACTIVE within its window? When false (fully background),
// the agent never switches the tab the user is currently looking at — screenshots
// use CDP (Page.captureScreenshot), which works on a non-active tab, so activation
// is no longer required. Tradeoff: a fully backgrounded tab can be throttled by
// the site (paused timers/animations, lazy/virtualized content not rendering),
// which can make reads flaky on very dynamic pages. If automation gets flaky on
// such a site, flip this to true so the channel tab stays active in its window
// (it still never raises Chrome to the OS foreground — that's BRING_WINDOW_TO_FRONT).
export const ACTIVATE_CHANNEL_TAB = false;

// Kareenos attended browser channel — each LANE (one concurrent agent task on
// the server) drives exactly ONE tab. The laneId→tab map lives in
// chrome.storage.session so every tool (navigate / read / click / fill /
// scroll / screenshot) of a lane targets that lane's tab, surviving the
// ephemeral MV3 service worker within a browser session, while different lanes
// work their own tabs at the same time. Commands without a lane_id land on the
// 'default' lane, which behaves exactly like the pre-lane single channel tab
// (including the transient active-tab fallback). Without pinning, each tool
// independently guessed "the active tab" and they disagreed — navigate touched
// tab A while read read tab B — which made the agent's view of the page
// incoherent and sent it into a tab-spawning loop.
const LANE_TABS_KEY = 'kareenos:laneTabs';
const LEGACY_CHANNEL_TAB_KEY = 'kareenos:channelTabId';
export const DEFAULT_LANE = 'default';

// Upper bound on concurrent lane tabs. When a NEW lane needs a tab past the
// cap, the least-recently-used lane's tab is closed (that agent recovers by
// navigating again — it loses page state, so keep this generous vs. the
// realistic 3-4 concurrent agents).
const MAX_LANE_TABS = 8;

interface LaneTabEntry {
  tabId: number;
  lastUsedAt: number;
}
type LaneTabMap = Record<string, LaneTabEntry>;

async function readLaneTabs(): Promise<LaneTabMap> {
  try {
    const o = await chrome.storage.session.get([LANE_TABS_KEY, LEGACY_CHANNEL_TAB_KEY]);
    const raw = o?.[LANE_TABS_KEY];
    const map: LaneTabMap = raw && typeof raw === 'object' ? { ...raw } : {};
    // One-time migration: a pre-lane pinned channel tab becomes the default lane.
    const legacy = o?.[LEGACY_CHANNEL_TAB_KEY];
    if (typeof legacy === 'number' && !map[DEFAULT_LANE]) {
      map[DEFAULT_LANE] = { tabId: legacy, lastUsedAt: Date.now() };
      try {
        await chrome.storage.session.remove(LEGACY_CHANNEL_TAB_KEY);
        await chrome.storage.session.set({ [LANE_TABS_KEY]: map });
      } catch {
        /* noop */
      }
    }
    return map;
  } catch {
    return {};
  }
}

async function writeLaneTabs(map: LaneTabMap): Promise<void> {
  try {
    await chrome.storage.session.set({ [LANE_TABS_KEY]: map });
  } catch {
    /* storage.session unavailable — fall back to per-call active-tab resolution */
  }
}

// Serialize every read-modify-write on the shared lane map: two lanes finishing
// navigation at the same moment would otherwise clobber each other's entry
// (storage.session get/set is not atomic).
let laneTabsChain: Promise<unknown> = Promise.resolve();
function withLaneTabs<T>(fn: (map: LaneTabMap) => Promise<T> | T): Promise<T> {
  const run = laneTabsChain.then(async () => {
    const map = await readLaneTabs();
    return fn(map);
  });
  laneTabsChain = run.catch(() => undefined);
  return run;
}

export function getLaneTabId(laneId: string = DEFAULT_LANE): Promise<number | null> {
  return withLaneTabs((map) => {
    const e = map[laneId];
    return e && typeof e.tabId === 'number' ? e.tabId : null;
  });
}

/** Pin (or clear, when tabId is null) the tab a lane drives. Enforces the LRU cap. */
export function setLaneTab(laneId: string, tabId: number | null): Promise<void> {
  return withLaneTabs(async (map) => {
    if (tabId == null) {
      if (!(laneId in map)) return;
      delete map[laneId];
      await writeLaneTabs(map);
      return;
    }
    if (!(laneId in map)) {
      // New lane past the cap → evict the least-recently-used lane and close
      // its tab (best-effort; the evicted agent recovers via navigate).
      const lanes = Object.keys(map);
      if (lanes.length >= MAX_LANE_TABS) {
        lanes.sort((a, b) => (map[a].lastUsedAt || 0) - (map[b].lastUsedAt || 0));
        const evicted = lanes[0];
        const evictedTabId = map[evicted].tabId;
        delete map[evicted];
        try {
          await chrome.tabs.remove(evictedTabId);
        } catch {
          /* already gone */
        }
      }
    }
    map[laneId] = { tabId, lastUsedAt: Date.now() };
    await writeLaneTabs(map);
  });
}

function touchLane(laneId: string): Promise<void> {
  return withLaneTabs(async (map) => {
    const e = map[laneId];
    if (!e) return;
    e.lastUsedAt = Date.now();
    await writeLaneTabs(map);
  });
}

function pruneLaneTabsForTab(tabId: number): Promise<void> {
  return withLaneTabs(async (map) => {
    let changed = false;
    for (const lane of Object.keys(map)) {
      if (map[lane].tabId === tabId) {
        delete map[lane];
        changed = true;
      }
    }
    if (changed) await writeLaneTabs(map);
  });
}

// Registered at module load — this module is imported on every MV3 SW spin-up
// (tools → background/index.ts), so the listener is always re-armed.
try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void pruneLaneTabsForTab(tabId);
  });
} catch {
  /* tabs API unavailable in some contexts */
}

/**
 * Base class for browser tool executors
 */
export abstract class BaseBrowserToolExecutor implements ToolExecutor {
  abstract name: string;
  abstract execute(args: any): Promise<ToolResult>;

  /** Read a lane's pinned tab id (null when unset). */
  protected async getChannelTabId(laneId: string = DEFAULT_LANE): Promise<number | null> {
    return getLaneTabId(laneId);
  }

  /** Pin (or clear, when null) the tab a lane drives. */
  protected async setChannelTab(
    tab: chrome.tabs.Tab | number | null,
    laneId: string = DEFAULT_LANE,
  ): Promise<void> {
    const id = typeof tab === 'number' ? tab : (tab?.id ?? null);
    return setLaneTab(laneId, id);
  }

  /**
   * Resolve the single tab a LANE drives. Order:
   *   1. explicit args.tabId  (pins it to this lane)
   *   2. the lane's pinned tab, if it still exists (dead entries are pruned)
   *   3. the active tab in the focused window — TRANSIENT fallback, NOT pinned,
   *      and ONLY for the 'default' lane (legacy single-channel behavior). A
   *      named lane must never adopt the user's active tab: with several agents
   *      running, that tab may well be ANOTHER lane's tab — cross-talk.
   * Guarantees navigate/read/click/fill/scroll/screenshot of one lane all act
   * on that lane's ONE tab.
   *
   * A lane's tab is established only by navigate (which CREATES a dedicated tab
   * when none exists) or an explicit tabId — NEVER by silently adopting+pinning
   * the user's active tab, which would let a later navigate drive the user's own
   * tab in place (e.g. hijacking the agent-runner tab).
   */
  protected async resolveTargetTab(args?: {
    tabId?: number;
    windowId?: number;
    laneId?: string;
  }): Promise<chrome.tabs.Tab> {
    const laneId = args?.laneId || DEFAULT_LANE;
    // 1. explicit tab id wins and (re)pins this lane's tab
    const explicit = await this.tryGetTab(args?.tabId);
    if (explicit && explicit.id) {
      await this.setChannelTab(explicit, laneId);
      return explicit;
    }
    // 2. the lane's pinned tab, if still alive
    const pinnedId = await this.getChannelTabId(laneId);
    if (pinnedId != null) {
      const pinned = await this.tryGetTab(pinnedId);
      if (pinned && pinned.id) {
        void touchLane(laneId);
        return pinned;
      }
      await this.setChannelTab(null, laneId); // prune the dead entry
    }
    // 3. transient fallback to the active tab — default lane only (see note above)
    if (laneId === DEFAULT_LANE) {
      const active = await this.getActiveTabInWindow(args?.windowId);
      if (active && active.id) {
        return active;
      }
    }
    throw new Error('No tab is open for this task yet — navigate to a URL first');
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
  /**
   * Frame ids to search, top frame first.
   *
   * Real apps render their composer/editor inside a SAME-ORIGIN CHILD FRAME
   * (LinkedIn's post box is one), leaving the top document with no editable and
   * no file input at all — a top-frame-only search then truthfully reports
   * "not found" on a page that visibly has the control. Callers loop these and
   * keep the first frame that answers.
   */
  protected async listFrameIds(tabId: number, frameId?: number): Promise<(number | undefined)[]> {
    if (frameId !== undefined) return [frameId];
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      if (frames && frames.length) {
        return frames.map((f) => f.frameId).sort((a, b) => a - b);
      }
    } catch (e) {
      /* fall through to top frame only */
    }
    return [undefined];
  }

  protected async sendMessageToTab(tabId: number, message: any, frameId?: number): Promise<any> {
    try {
      const response =
        typeof frameId === 'number'
          ? await chrome.tabs.sendMessage(tabId, message, { frameId })
          : await chrome.tabs.sendMessage(tabId, message);

      if (response && response.error) {
        // v2 helpers answer { error: { code, message, details } } — keep it
        // structured so the tool can report the code; legacy prose stays an Error.
        const structured = errorFromResponse(response);
        if (structured) throw structured;
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
    // Never raise Chrome to the OS foreground unless explicitly enabled.
    if (focusWindow && BRING_WINDOW_TO_FRONT && typeof tab.windowId === 'number') {
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
