// Kareenos Browser Channel v2 — element ref grammar.
//
// In-page, the helpers hand out `ref_<n>` (a per-DOCUMENT counter kept in
// window.__claudeElementMap). On the wire and in the agent's view a ref is
// `f<frameId>e<n>` — the chrome.webNavigation frame id makes it frame-aware,
// so click/fill/scroll/screenshot/upload never have to search frames for a
// ref: they go straight to that frame. Staleness is handled by the document
// EPOCH recorded per frame in the lane's RefBook (see core-bridge.ts): a frame
// that navigated has a new epoch and refuses the old refs (STALE_REF).
//
// Pure module (no chrome APIs) so it is unit-testable.

export interface ParsedRef {
  frameId: number;
  n: number;
  helperRef: string; // `ref_<n>` — what the in-page helpers understand
}

const REF_RE = /^f(\d+)e(\d+)$/;

export function isRef(value: unknown): value is string {
  return typeof value === 'string' && REF_RE.test(value.trim());
}

export function parseRef(value: unknown): ParsedRef | null {
  if (typeof value !== 'string') return null;
  const m = REF_RE.exec(value.trim());
  if (!m) return null;
  const frameId = Number(m[1]);
  const n = Number(m[2]);
  if (!Number.isFinite(frameId) || !Number.isFinite(n) || n < 1) return null;
  return { frameId, n, helperRef: `ref_${n}` };
}

export function formatRef(frameId: number, helperRef: string): string {
  const m = /^ref_(\d+)$/.exec(String(helperRef || '').trim());
  if (!m) return '';
  return `f${Math.max(0, Math.floor(frameId))}e${m[1]}`;
}

// `[ref_12]` → `[f3e12]` for every occurrence in a snapshot line.
export function rewriteHelperRefs(text: string, frameId: number): string {
  return String(text || '').replace(/\[ref_(\d+)\]/g, (_m, n) => `[f${frameId}e${n}]`);
}
