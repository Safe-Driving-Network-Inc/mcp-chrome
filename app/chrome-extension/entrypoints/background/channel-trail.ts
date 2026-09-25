// ============================================================================
// Browser Channel diagnostics trail (1.3.1)
// ============================================================================
// A ring of the last steps the channel client took: connect attempts, storage
// reads, socket open/close, bind verdicts, watch ticks. Mirrored (coalesced) to
// chrome.storage.local['kareenos_debug'] so it survives service-worker
// evictions and can be read by the popup ("Diagnostics") or by an operator
// dumping the profile's "Local Extension Settings". Why it exists: the first
// Cloud Browser ran for hours with a valid bootstrap in managed storage and never
// opened its socket, and nothing in the VM could tell us which step it stopped
// at (DevTools are policy-disabled there). NEVER pass a token or a password in.
// ============================================================================
export const TRAIL_KEY = 'kareenos_debug';
const MAX = 80;
const BOOT = Math.random().toString(36).slice(2, 6); // tells worker lifetimes apart

let ring: string[] = [];
let loaded = false;
let loadP: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loadP) return loadP;
  loadP = (async () => {
    let prev: string[] = [];
    try {
      const got = await chrome.storage.local.get(TRAIL_KEY);
      const v = got && got[TRAIL_KEY];
      if (Array.isArray(v)) prev = v.filter((x) => typeof x === 'string');
    } catch (e) {
      /* storage unreadable: keep the in-memory ring only */
    }
    ring = prev.concat(ring).slice(-MAX);
    loaded = true;
  })().finally(() => {
    loadP = null;
  });
  return loadP;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    ensureLoaded()
      .then(() => chrome.storage.local.set({ [TRAIL_KEY]: ring.slice(-MAX) }))
      .catch(() => {});
  }, 250);
}

// Record one step. `extra` is a small object of booleans/numbers/short strings.
export function trace(msg: string, extra?: Record<string, unknown>): void {
  let line = stamp() + ' ' + BOOT + ' ' + msg;
  if (extra) {
    try {
      line += ' ' + JSON.stringify(extra);
    } catch (e) {
      /* ignore */
    }
  }
  ring.push(line);
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);
  try {
    console.debug('[Kareenos channel] ' + line);
  } catch (e) {
    /* ignore */
  }
  scheduleFlush();
}

// Last `n` lines, including what earlier worker lifetimes persisted.
export async function getTrail(n = 20): Promise<string[]> {
  await ensureLoaded();
  return ring.slice(-n);
}

export function primeTrail(): void {
  ensureLoaded().catch(() => {});
}
