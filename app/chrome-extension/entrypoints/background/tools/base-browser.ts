import { ToolExecutor } from '@/common/tool-handler';
import type { ToolResult } from '@/common/tool-handler';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { errorFromResponse, BrowserActionError } from '@/common/browser-errors';

const PING_TIMEOUT_MS = 300;
const SEND_MESSAGE_TIMEOUT_MS = 10_000;

// Attended channel must be NON-INTRUSIVE: the agent works in the background and
// must never raise Chrome to the OS foreground over whatever app the user is in.
// When false (default) we never call chrome.windows.update({focused:true}) and
// never create focused windows. The agent's tab is still kept ACTIVE within its
// own window — so the user sees progress when they switch to Chrome themselves,
// and screenshot's captureVisibleTab targets the right tab — but Chrome never
// pops in front. Flip to true only if you want the browser to follow the agent.
export const BRING_WINDOW_TO_FRONT_DEFAULT = false;
// In a Kareenos Cloud Browser (hosted kind) the live view IS the point: the
// lane's tab must be the visible one and a popup window must come back to
// front, so both flags flip to true there. Attended keeps the defaults.
import { isHosted } from '../channel-mode';
export function bringWindowToFront(): boolean {
  return isHosted() ? true : BRING_WINDOW_TO_FRONT_DEFAULT;
}
export const BRING_WINDOW_TO_FRONT = BRING_WINDOW_TO_FRONT_DEFAULT;

// Keep the agent's tab ACTIVE within its window? When false (fully background),
// the agent never switches the tab the user is currently looking at — screenshots
// use CDP (Page.captureScreenshot), which works on a non-active tab, so activation
// is no longer required. Tradeoff: a fully backgrounded tab can be throttled by
// the site (paused timers/animations, lazy/virtualized content not rendering),
// which can make reads flaky on very dynamic pages. If automation gets flaky on
// such a site, flip this to true so the channel tab stays active in its window
// (it still never raises Chrome to the OS foreground — that's BRING_WINDOW_TO_FRONT).
export const ACTIVATE_CHANNEL_TAB_DEFAULT = false;
export function activateChannelTab(): boolean {
  return isHosted() ? true : ACTIVATE_CHANNEL_TAB_DEFAULT;
}
export const ACTIVATE_CHANNEL_TAB = ACTIVATE_CHANNEL_TAB_DEFAULT;

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
// navigating again — it loses page state). 8 → 3 on 2026-10-21: lanes are now
// closed when their run releases the browser (lane_close), so the cap only has
// to cover runs that are genuinely concurrent, and every extra LinkedIn tab in a
// 3 GiB Cloud Browser is memory the kernel's OOM killer eventually comes for.
export const MAX_LANE_TABS = 3;
// Popups a lane's tab opened (window.open, target=_blank): closed with the lane.
const LANE_POPUPS_KEY = 'kareenos:lanePopups';
type LanePopupMap = Record<string, number[]>;

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

async function readLanePopups(): Promise<LanePopupMap> {
  try {
    const o = await chrome.storage.session.get(LANE_POPUPS_KEY);
    const raw = o?.[LANE_POPUPS_KEY];
    return raw && typeof raw === 'object' ? { ...raw } : {};
  } catch {
    return {};
  }
}
async function writeLanePopups(map: LanePopupMap): Promise<void> {
  try {
    await chrome.storage.session.set({ [LANE_POPUPS_KEY]: map });
  } catch {
    /* noop */
  }
}
// A tab opened BY a lane's tab (or by one of its popups) belongs to that lane.
async function notePopup(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab || typeof tab.id !== 'number' || typeof tab.openerTabId !== 'number') return;
  const lanes = await readLaneTabs();
  const popups = await readLanePopups();
  let owner: string | null = null;
  for (const lane of Object.keys(lanes)) if (lanes[lane].tabId === tab.openerTabId) owner = lane;
  if (!owner)
    for (const lane of Object.keys(popups))
      if ((popups[lane] || []).includes(tab.openerTabId)) owner = lane;
  if (!owner) return;
  popups[owner] = Array.from(new Set([...(popups[owner] || []), tab.id])).slice(-20);
  await writeLanePopups(popups);
}
async function forgetPopup(tabId: number): Promise<void> {
  const popups = await readLanePopups();
  let changed = false;
  for (const lane of Object.keys(popups)) {
    const next = (popups[lane] || []).filter((id) => id !== tabId);
    if (next.length !== (popups[lane] || []).length) {
      changed = true;
      if (next.length) popups[lane] = next;
      else delete popups[lane];
    }
  }
  if (changed) await writeLanePopups(popups);
}

async function closeTabKeepingWindow(tabId: number): Promise<'closed' | 'blanked' | 'gone'> {
  let tab: chrome.tabs.Tab | null = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return 'gone';
  }
  // Closing the LAST tab of the last window would quit Chromium — in a Cloud
  // Browser that is the whole browser. Park it on about:blank instead.
  try {
    const all = await chrome.tabs.query({});
    if (all.length <= 1) {
      await chrome.tabs.update(tabId, { url: 'about:blank' });
      return 'blanked';
    }
  } catch {
    /* fall through to remove */
  }
  try {
    await chrome.tabs.remove(tabId);
    return 'closed';
  } catch {
    return 'gone';
  }
}

/** The run that drove this lane let go (lane_close): close its tab and its popups, forget its refs. */
export async function closeLane(
  laneId: string,
): Promise<{ lane: string; tab: 'closed' | 'blanked' | 'gone' | 'none'; popups_closed: number }> {
  const lane = laneId || DEFAULT_LANE;
  const tabId = await getLaneTabId(lane);
  const popups = await readLanePopups();
  const mine = popups[lane] || [];
  let popupsClosed = 0;
  for (const id of mine) {
    const r = await closeTabKeepingWindow(id);
    if (r === 'closed') popupsClosed++;
  }
  if (mine.length) {
    delete popups[lane];
    await writeLanePopups(popups);
  }
  let tabResult: 'closed' | 'blanked' | 'gone' | 'none' = 'none';
  if (tabId != null) {
    tabResult = await closeTabKeepingWindow(tabId);
    await setLaneTab(lane, null);
  }
  try {
    await chrome.storage.session.remove('kareenos:refBook:' + lane);
  } catch {
    /* noop */
  }
  return { lane, tab: tabResult, popups_closed: popupsClosed };
}

// Orphan sweep (hosted browsers only, 2026-10-21): a tab that belongs to no lane
// and to no lane's popups, has sat there for ORPHAN_AFTER_MS, is not the active
// tab of its window and is an http(s) page, is closed. A browser whose only tab
// qualifies keeps it. First-seen times live in memory: the socket keeps this
// worker alive, and a fresh worker simply starts the clock again (conservative).
const ORPHAN_AFTER_MS = 10 * 60 * 1000;
const orphanFirstSeen = new Map<number, number>();
let lastSweepAt = 0;
export async function sweepOrphanTabs(
  minIntervalMs = 60_000,
): Promise<{ closed: number; candidates: number; lanes: number }> {
  const now = Date.now();
  if (now - lastSweepAt < minIntervalMs) return { closed: 0, candidates: 0, lanes: 0 };
  lastSweepAt = now;
  const lanes = await readLaneTabs();
  const popups = await readLanePopups();
  const known = new Set<number>();
  Object.values(lanes).forEach((e) => known.add(e.tabId));
  Object.values(popups).forEach((ids) => ids.forEach((id) => known.add(id)));
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return { closed: 0, candidates: 0, lanes: Object.keys(lanes).length };
  }
  // Lane entries whose tab is gone are pruned (a resumed browser keeps the
  // session map but not necessarily the tabs).
  const live = new Set(tabs.map((t) => t.id).filter((id): id is number => typeof id === 'number'));
  for (const lane of Object.keys(lanes))
    if (!live.has(lanes[lane].tabId)) await setLaneTab(lane, null);
  let closed = 0;
  let candidates = 0;
  for (const t of tabs) {
    if (typeof t.id !== 'number' || known.has(t.id)) continue;
    if (!/^https?:/i.test(t.url || '')) continue;
    candidates++;
    const first = orphanFirstSeen.get(t.id) || now;
    if (!orphanFirstSeen.has(t.id)) orphanFirstSeen.set(t.id, now);
    if (now - first < ORPHAN_AFTER_MS) continue;
    if (t.active) continue; // somebody may be looking at it in the live view
    const r = await closeTabKeepingWindow(t.id);
    if (r === 'closed') {
      closed++;
      orphanFirstSeen.delete(t.id);
    }
  }
  for (const id of Array.from(orphanFirstSeen.keys()))
    if (!live.has(id)) orphanFirstSeen.delete(id);
  if (closed)
    console.log(
      `[BC] orphan sweep closed ${closed} tab(s) (candidates ${candidates}, lanes ${Object.keys(lanes).length})`,
    );
  return { closed, candidates, lanes: Object.keys(lanes).length };
}

// Registered at module load — this module is imported on every MV3 SW spin-up
// (tools → background/index.ts), so the listener is always re-armed.
try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void pruneLaneTabsForTab(tabId);
    void forgetPopup(tabId);
    orphanFirstSeen.delete(tabId);
  });
} catch {
  /* tabs API unavailable in some contexts */
}
try {
  chrome.tabs.onCreated.addListener((tab) => {
    void notePopup(tab);
  });
} catch {
  /* ignore */
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
    // NAV_REQUIRED (2026-10-21): a code agents can branch on. Before it, this was a
    // bare Error that surfaced as EXECUTION_ERROR; every one of its 70 occurrences
    // on 17–21 Oct was a read dispatched beside the navigate of the same turn.
    throw new BrowserActionError(
      'NAV_REQUIRED',
      'No tab is open for this task yet — navigate to a URL first',
      { lane: laneId },
    );
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
      // A helper that never answers (a frame mid-unload, a page that froze the
      // isolated world) used to hold the whole command — and the lane — until the
      // server gave up. Every helper call now has its own deadline (2026-10-21).
      const limitMs =
        Number(message && message.__timeout_ms) > 0
          ? Number(message.__timeout_ms)
          : SEND_MESSAGE_TIMEOUT_MS;
      const send =
        typeof frameId === 'number'
          ? chrome.tabs.sendMessage(tabId, message, { frameId })
          : chrome.tabs.sendMessage(tabId, message);
      const response = await Promise.race([
        send,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new BrowserActionError(
                  'NO_FRAME_ACCESS',
                  `The page helper did not answer ${message?.action || 'the message'} within ${limitMs} ms (frame ${frameId ?? 'top'} hung or unloading)`,
                ),
              ),
            limitMs,
          ),
        ),
      ]);

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
    if (focusWindow && bringWindowToFront() && typeof tab.windowId === 'number') {
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
