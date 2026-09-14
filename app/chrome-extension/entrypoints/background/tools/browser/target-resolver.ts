// Kareenos Browser Channel v2 — ONE way to turn { ref | selector, frame, nth,
// strict } into { frameId, helperRef } for click / fill / scroll / screenshot /
// press / upload.
//
//   ref       → exact frame from the ref itself; epoch-checked (STALE_REF /
//               DETACHED come from the page, WRONG_FRAME when `frame` disagrees).
//   selector  → kFindCandidates in EVERY frame in scope, concurrently; merge by
//               tier (exact → contains → css → ancestor), then in-viewport, then
//               area. nth picks; strict + several visible → AMBIGUOUS; a tie for
//               first place (same tier, same viewport status) → AMBIGUOUS with
//               the candidates listed (each with a usable ref); otherwise best
//               wins and the rest are reported as alternatives.
//   frame     → `f3` / 3 / a URL substring restricts the frames searched.
//
// This replaces the old "try frames top-first, first answer wins" loops, which
// let a top-frame false positive beat the real match inside a child frame.
import { parseRef, formatRef } from '@/common/browser-refs';
import { BrowserActionError } from '@/common/browser-errors';
import { K_MSG } from '@/common/kareenos-tool-names';
import { listFrames, coreCall, expectedEpoch, noteFrameEpoch, type FrameInfo } from './core-bridge';

export type TargetKind = 'click' | 'fill' | 'upload' | 'any';

export interface TargetSpec {
  ref?: string;
  selector?: string;
  frame?: string | number | null;
  nth?: number | null;
  strict?: boolean | null;
  kind: TargetKind;
}

export interface Candidate {
  ref: string;
  frame: number;
  frame_url?: string;
  role: string;
  name: string;
  tier: string;
  in_viewport: boolean;
  area: number;
  editable?: boolean;
  disabled?: boolean;
}

export interface ResolvedTarget {
  frameId: number;
  frameUrl: string;
  helperRef: string;
  ref: string;
  expectEpoch?: string;
  role?: string;
  name?: string;
  tier?: string;
  candidates: Candidate[];
  alternatives: Candidate[];
}

const TIER_RANK: Record<string, number> = { exact: 0, contains: 1, css: 2, ancestor: 3 };

export function frameMatches(frame: FrameInfo, spec: string | number | null | undefined): boolean {
  if (spec == null || spec === '') return true;
  if (typeof spec === 'number') return frame.frameId === spec;
  const s = String(spec).trim();
  const m = /^f?(\d+)$/i.exec(s);
  if (m) return frame.frameId === Number(m[1]);
  if (s === 'top') return frame.frameId === 0;
  return !!frame.url && frame.url.toLowerCase().includes(s.toLowerCase());
}

export function describeCandidate(c: Candidate): string {
  const where = c.frame === 0 ? 'top' : `frame f${c.frame}`;
  return `[${c.ref}] ${c.role} "${c.name}" (${where}${c.in_viewport ? '' : ', off-screen'}${c.disabled ? ', disabled' : ''})`;
}

export async function resolveTarget(tabId: number, laneId: string, spec: TargetSpec): Promise<ResolvedTarget> {
  const frames = await listFrames(tabId);
  const frameUrlOf = (fid: number) => frames.find((f) => f.frameId === fid)?.url || '';

  // --- by ref -----------------------------------------------------------------
  if (spec.ref) {
    const parsed = parseRef(spec.ref);
    if (!parsed) {
      throw new BrowserActionError('NOT_FOUND', `"${spec.ref}" is not a ref — refs look like f0e12 (take them from browser_snapshot)`, { ref: spec.ref });
    }
    const frame = frames.find((f) => f.frameId === parsed.frameId);
    if (!frame) {
      throw new BrowserActionError('STALE_REF', `Ref ${spec.ref} points at frame f${parsed.frameId}, which no longer exists — take a new browser_snapshot.`, { ref: spec.ref });
    }
    if (spec.frame != null && spec.frame !== '' && !frameMatches(frame, spec.frame)) {
      throw new BrowserActionError('WRONG_FRAME', `Ref ${spec.ref} lives in frame f${parsed.frameId}, not in the requested frame "${spec.frame}".`, { ref: spec.ref, frame: spec.frame });
    }
    const expect = await expectedEpoch(laneId, tabId, parsed.frameId);
    const r = await coreCall(tabId, parsed.frameId, { action: K_MSG.RESOLVE_REF, ref: parsed.helperRef, expect_epoch: expect });
    if (r && r.epoch) void noteFrameEpoch(laneId, tabId, parsed.frameId, r.epoch, frame.url);
    return {
      frameId: parsed.frameId,
      frameUrl: frame.url,
      helperRef: parsed.helperRef,
      ref: spec.ref,
      expectEpoch: expect,
      role: r?.role,
      name: r?.name,
      tier: 'ref',
      candidates: [],
      alternatives: [],
    };
  }

  // --- by selector / text ------------------------------------------------------
  const selector = (spec.selector || '').trim();
  if (!selector) throw new BrowserActionError('NOT_FOUND', 'Provide a ref (from browser_snapshot) or a selector (CSS or text=Label).');

  const scoped = frames.filter((f) => frameMatches(f, spec.frame));
  if (!scoped.length) {
    throw new BrowserActionError('NO_FRAME_ACCESS', `No frame matches "${spec.frame}" on this page (frames: ${frames.map((f) => 'f' + f.frameId).join(', ')}).`, { frame: spec.frame, frames: frames.map((f) => ({ id: f.frameId, url: f.url })) });
  }

  const perFrame = await Promise.allSettled(
    scoped.map(async (f) => {
      const r = await coreCall(tabId, f.frameId, { action: K_MSG.FIND_CANDIDATES, selector, kind: spec.kind, limit: 12 });
      if (r && r.epoch) void noteFrameEpoch(laneId, tabId, f.frameId, r.epoch, f.url);
      return { frame: f, result: r };
    }),
  );

  const merged: Candidate[] = [];
  let hiddenTotal = 0;
  const searched: number[] = [];
  const inaccessible: number[] = [];
  perFrame.forEach((p, i) => {
    const f = scoped[i];
    if (p.status !== 'fulfilled') {
      inaccessible.push(f.frameId);
      return;
    }
    searched.push(f.frameId);
    const r = p.value.result || {};
    hiddenTotal += Math.max(0, Number(r.total || 0) - Number(r.visible || 0));
    (r.candidates || []).forEach((c: any) => {
      merged.push({
        ref: formatRef(f.frameId, c.ref),
        frame: f.frameId,
        frame_url: f.url,
        role: c.role,
        name: c.name,
        tier: c.tier,
        in_viewport: !!c.in_viewport,
        area: Number(c.area) || 0,
        editable: !!c.editable,
        disabled: !!c.disabled,
      });
    });
  });

  merged.sort((a, b) => {
    const ta = TIER_RANK[a.tier] ?? 9;
    const tb = TIER_RANK[b.tier] ?? 9;
    if (ta !== tb) return ta - tb;
    if (a.in_viewport !== b.in_viewport) return a.in_viewport ? -1 : 1;
    return a.area - b.area;
  });

  if (!merged.length) {
    const hint = hiddenTotal
      ? ` ${hiddenTotal} hidden match(es) exist — the control may need a scroll, a menu opened first, or a different label.`
      : '';
    throw new BrowserActionError('NOT_FOUND', `Nothing visible matches "${selector}" in ${searched.length} frame(s).${hint} Take a browser_snapshot to see what is on the page and act by ref.`, {
      selector,
      frames_searched: searched,
      frames_inaccessible: inaccessible,
      hidden_matches: hiddenTotal,
    });
  }

  let chosen: Candidate;
  if (spec.nth != null && spec.nth !== ('' as any)) {
    const idx = Math.floor(Number(spec.nth));
    if (!Number.isFinite(idx) || idx < 0 || idx >= merged.length) {
      throw new BrowserActionError('NOT_FOUND', `nth=${spec.nth} is out of range: "${selector}" has ${merged.length} visible match(es).`, { selector, candidates: merged.slice(0, 8) });
    }
    chosen = merged[idx];
  } else {
    const strict = spec.strict === true;
    const tie =
      merged.length > 1 &&
      (TIER_RANK[merged[0].tier] ?? 9) === (TIER_RANK[merged[1].tier] ?? 9) &&
      merged[0].in_viewport === merged[1].in_viewport;
    if ((strict && merged.length > 1) || (tie && spec.strict !== false)) {
      const list = merged.slice(0, 8);
      throw new BrowserActionError('AMBIGUOUS', `"${selector}" matches ${merged.length} visible elements. Pick one by ref: ${list.map(describeCandidate).join(' | ')}`, {
        selector,
        count: merged.length,
        candidates: list,
      });
    }
    chosen = merged[0];
  }

  const parsedChosen = parseRef(chosen.ref)!;
  return {
    frameId: chosen.frame,
    frameUrl: frameUrlOf(chosen.frame),
    helperRef: parsedChosen.helperRef,
    ref: chosen.ref,
    expectEpoch: await expectedEpoch(laneId, tabId, chosen.frame),
    role: chosen.role,
    name: chosen.name,
    tier: chosen.tier,
    candidates: merged.slice(0, 8),
    alternatives: merged.filter((c) => c !== chosen).slice(0, 5),
  };
}
