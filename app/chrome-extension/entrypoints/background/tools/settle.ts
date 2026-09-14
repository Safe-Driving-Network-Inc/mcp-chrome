// Kareenos Browser Channel v2 — settling.
//
// Every mutating action (click, fill, upload, press, navigate, each batch step)
// used to return the instant its events were dispatched, so the agent learned
// nothing about what the page DID: it re-read the page and diffed prose by
// itself, and `navigationOccurred` was structurally always false. withSettle()
// wraps an action with a before/after probe of every frame (open dialogs, focus
// owner, url) and a mutation-quiet window, and reports the difference:
//
//   settle: { navigated, url, url_changed, new_frames, dialog_opened, dialog,
//             dialog_closed, focus_changed, focus, dom_mutations, quiet_ms, capped }
//
// Navigation is observed from the background (chrome.webNavigation / tabs
// events into a per-tab ring buffer) — an unloading frame cannot report it.
import { formatRef } from '@/common/browser-refs';
import { K_MSG } from '@/common/kareenos-tool-names';
import { listFrames, coreCall, noteFrameEpoch, type FrameInfo } from './browser/core-bridge';

export interface NavEvent {
  t: number;
  frameId: number;
  url: string;
  event: 'before' | 'committed' | 'dom' | 'completed' | 'tab_loading' | 'tab_complete';
}

const NAV_LOG_MAX = 50;
const navLog = new Map<number, NavEvent[]>();

function pushNav(tabId: number, ev: NavEvent) {
  const arr = navLog.get(tabId) || [];
  arr.push(ev);
  if (arr.length > NAV_LOG_MAX) arr.splice(0, arr.length - NAV_LOG_MAX);
  navLog.set(tabId, arr);
}

// Registered at module load: this module is imported on every SW spin-up.
try {
  chrome.webNavigation.onBeforeNavigate.addListener((d) => pushNav(d.tabId, { t: Date.now(), frameId: d.frameId, url: d.url, event: 'before' }));
  chrome.webNavigation.onCommitted.addListener((d) => pushNav(d.tabId, { t: Date.now(), frameId: d.frameId, url: d.url, event: 'committed' }));
  chrome.webNavigation.onDOMContentLoaded.addListener((d) => pushNav(d.tabId, { t: Date.now(), frameId: d.frameId, url: d.url, event: 'dom' }));
  chrome.webNavigation.onCompleted.addListener((d) => pushNav(d.tabId, { t: Date.now(), frameId: d.frameId, url: d.url, event: 'completed' }));
} catch (e) {
  /* webNavigation unavailable in some contexts */
}
try {
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading') pushNav(tabId, { t: Date.now(), frameId: 0, url: info.url || '', event: 'tab_loading' });
    else if (info.status === 'complete') pushNav(tabId, { t: Date.now(), frameId: 0, url: info.url || '', event: 'tab_complete' });
  });
} catch (e) {
  /* ignore */
}
try {
  chrome.tabs.onRemoved.addListener((tabId) => navLog.delete(tabId));
} catch (e) {
  /* ignore */
}

export function navEventsSince(tabId: number, t0: number): NavEvent[] {
  return (navLog.get(tabId) || []).filter((e) => e.t >= t0);
}

// Test seam: feed synthetic events (vitest has no real chrome events).
export function __pushNavEventForTests(tabId: number, ev: NavEvent) {
  pushNav(tabId, ev);
}

export type LoadState = 'domcontentloaded' | 'complete';

export async function waitForLoadState(tabId: number, state: LoadState, timeoutMs: number): Promise<{ ok: boolean; took_ms: number; status: string }> {
  const start = Date.now();
  const deadline = start + Math.max(0, timeoutMs);
  let status = 'unknown';
  for (;;) {
    try {
      const tab = await chrome.tabs.get(tabId);
      status = tab.status || 'unknown';
      if (status === 'complete') return { ok: true, took_ms: Date.now() - start, status };
      if (state === 'domcontentloaded') {
        const dom = navEventsSince(tabId, start - 5000).some((e) => e.frameId === 0 && (e.event === 'dom' || e.event === 'completed'));
        if (dom) return { ok: true, took_ms: Date.now() - start, status };
      }
    } catch (e) {
      return { ok: false, took_ms: Date.now() - start, status: 'gone' };
    }
    if (Date.now() >= deadline) return { ok: false, took_ms: Date.now() - start, status };
    await new Promise((r) => setTimeout(r, 150));
  }
}

export interface SettleRef {
  ref: string;
  role: string;
  name: string;
  frame: number;
}

export interface SettleReport {
  navigated: boolean;
  url: string;
  url_changed: boolean;
  new_frames: number;
  dialog_opened: boolean;
  dialog: (SettleRef & { modal: boolean }) | null;
  dialog_closed: boolean;
  focus_changed: boolean;
  focus: (SettleRef & { editable: boolean }) | null;
  dom_mutations: number;
  quiet_ms: number;
  capped: boolean;
}

interface FrameProbe {
  frame: FrameInfo;
  url: string;
  epoch?: string;
  dialogs: Array<{ ref: string; name: string; modal: boolean }>;
  focus: { ref: string; role: string; name: string; editable: boolean; is_iframe: boolean } | null;
}

async function probeAll(tabId: number, laneId: string): Promise<FrameProbe[]> {
  const frames = await listFrames(tabId);
  const settled = await Promise.allSettled(
    frames.map(async (f) => {
      const r = await coreCall(tabId, f.frameId, { action: K_MSG.STATE_PROBE });
      if (r && r.epoch) void noteFrameEpoch(laneId, tabId, f.frameId, r.epoch, r.url || f.url);
      return {
        frame: f,
        url: (r && r.url) || f.url,
        epoch: r && r.epoch,
        dialogs: (r && r.dialogs) || [],
        focus: (r && r.focus) || null,
      } as FrameProbe;
    }),
  );
  const out: FrameProbe[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') out.push(s.value);
    else out.push({ frame: frames[i], url: frames[i].url, dialogs: [], focus: null });
  });
  return out;
}

function dialogKeys(probes: FrameProbe[]): Map<string, SettleRef & { modal: boolean }> {
  const m = new Map<string, SettleRef & { modal: boolean }>();
  probes.forEach((p) => {
    p.dialogs.forEach((d) => {
      m.set(`${p.frame.frameId}:${d.name}`, { ref: formatRef(p.frame.frameId, d.ref), role: 'dialog', name: d.name, frame: p.frame.frameId, modal: !!d.modal });
    });
  });
  return m;
}

// The frame that really owns focus: the deepest probe whose active element is
// not itself an <iframe> (the top frame reports the iframe element when focus
// is inside a child).
function focusOwner(probes: FrameProbe[]): (SettleRef & { editable: boolean }) | null {
  let best: (SettleRef & { editable: boolean }) | null = null;
  probes.forEach((p) => {
    const f = p.focus;
    if (!f || f.is_iframe) return;
    const cand = { ref: formatRef(p.frame.frameId, f.ref), role: f.role, name: f.name, frame: p.frame.frameId, editable: !!f.editable };
    if (!best || p.frame.frameId > best.frame) best = cand;
  });
  return best;
}

function focusKey(f: (SettleRef & { editable: boolean }) | null): string {
  return f ? `${f.frame}:${f.role}:${f.name}:${f.editable}` : '';
}

// After a navigation there is no meaningful "before": report the landed page —
// quiet window, open dialogs, focus — with navigated:true.
export async function postNavigationSettle(tabId: number, laneId: string, opts?: { quietMs?: number; capMs?: number }): Promise<SettleReport> {
  const frames = await listFrames(tabId);
  const quiet = await Promise.allSettled(
    frames.map((f) => coreCall(tabId, f.frameId, { action: K_MSG.QUIET_WAIT, quiet_ms: opts?.quietMs ?? 300, cap_ms: opts?.capMs ?? 2000 })),
  );
  let mutations = 0;
  let quietWaited = 0;
  let capped = false;
  quiet.forEach((q) => {
    if (q.status !== 'fulfilled' || !q.value) return;
    mutations += Number(q.value.mutations) || 0;
    quietWaited = Math.max(quietWaited, Number(q.value.waited_ms) || 0);
    if (q.value.capped) capped = true;
  });
  const after = await probeAll(tabId, laneId);
  const url = after.find((p) => p.frame.frameId === 0)?.url || '';
  const dialogs = dialogKeys(after);
  let first: (SettleRef & { modal: boolean }) | null = null;
  dialogs.forEach((v) => {
    if (!first) first = v;
  });
  return {
    navigated: true,
    url,
    url_changed: true,
    new_frames: 0,
    dialog_opened: !!first,
    dialog: first,
    dialog_closed: false,
    focus_changed: false,
    focus: focusOwner(after),
    dom_mutations: mutations,
    quiet_ms: quietWaited,
    capped,
  };
}

export interface SettleOptions {
  tabId: number;
  laneId: string;
  quietMs?: number; // mutation-quiet window (default 300)
  capMs?: number; // max time to wait for quiet (default 3000)
  budgetMs?: number; // overall time left for the whole action (caps everything)
}

export async function withSettle<T>(opts: SettleOptions, action: () => Promise<T>): Promise<{ result: T; settle: SettleReport }> {
  const quietMs = Math.max(50, opts.quietMs ?? 300);
  const started = Date.now();
  const budget = opts.budgetMs && opts.budgetMs > 0 ? opts.budgetMs : 0;
  const remaining = () => (budget ? Math.max(0, budget - (Date.now() - started)) : Infinity);

  const before = await probeAll(opts.tabId, opts.laneId);
  const urlBefore = before.find((p) => p.frame.frameId === 0)?.url || '';
  const t0 = Date.now();

  const result = await action();

  // Quiet window in every frame that is still alive (a navigated frame simply
  // fails the message — that is the navigation signal, not an error).
  const capMs = Math.min(opts.capMs ?? 3000, budget ? Math.max(200, remaining() - 300) : opts.capMs ?? 3000);
  const framesNow = await listFrames(opts.tabId);
  const quiet = await Promise.allSettled(
    framesNow.map((f) => coreCall(opts.tabId, f.frameId, { action: K_MSG.QUIET_WAIT, quiet_ms: quietMs, cap_ms: capMs })),
  );
  let mutations = 0;
  let quietWaited = 0;
  let capped = false;
  quiet.forEach((q) => {
    if (q.status !== 'fulfilled' || !q.value) return;
    mutations += Number(q.value.mutations) || 0;
    quietWaited = Math.max(quietWaited, Number(q.value.waited_ms) || 0);
    if (q.value.capped) capped = true;
  });

  const nav = navEventsSince(opts.tabId, t0);
  const topCommitted = nav.some((e) => e.frameId === 0 && (e.event === 'committed' || e.event === 'tab_loading'));
  if (topCommitted) {
    await waitForLoadState(opts.tabId, 'complete', Math.min(15000, budget ? remaining() - 200 : 15000));
  }

  const after = await probeAll(opts.tabId, opts.laneId);
  const urlAfter = after.find((p) => p.frame.frameId === 0)?.url || urlBefore;

  const dBefore = dialogKeys(before);
  const dAfter = dialogKeys(after);
  let opened: (SettleRef & { modal: boolean }) | null = null;
  dAfter.forEach((v, k) => {
    if (!dBefore.has(k) && !opened) opened = v;
  });
  let closed = false;
  dBefore.forEach((_v, k) => {
    if (!dAfter.has(k)) closed = true;
  });

  const fBefore = focusOwner(before);
  const fAfter = focusOwner(after);

  const settle: SettleReport = {
    navigated: topCommitted,
    url: urlAfter,
    url_changed: !!urlBefore && !!urlAfter && urlBefore !== urlAfter,
    new_frames: Math.max(0, after.length - before.length),
    dialog_opened: !!opened,
    dialog: opened,
    dialog_closed: closed,
    focus_changed: focusKey(fBefore) !== focusKey(fAfter),
    focus: fAfter,
    dom_mutations: mutations,
    quiet_ms: quietWaited,
    capped,
  };
  return { result, settle };
}
