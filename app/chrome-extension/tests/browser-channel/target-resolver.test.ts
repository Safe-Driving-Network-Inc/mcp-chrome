import { describe, it, expect, vi, beforeEach } from 'vitest';
import { frameMatches, describeCandidate, resolveTarget } from '@/entrypoints/background/tools/browser/target-resolver';
import { BrowserActionError } from '@/common/browser-errors';

const chromeMock = () => (globalThis as any).chrome;

function mockFrames(frames: Array<{ frameId: number; parentFrameId: number; url: string }>) {
  chromeMock().webNavigation.getAllFrames.mockResolvedValue(frames);
}

// Per-frame canned kFindCandidates answers; everything else pongs.
function mockCore(perFrame: Record<number, any>) {
  chromeMock().tabs.sendMessage.mockImplementation(async (_tabId: number, message: any, opts: any) => {
    const fid = opts?.frameId ?? 0;
    if (message.action === 'k_dom_core_ping') return { status: 'pong', epoch: 'ep' + fid };
    if (message.action === 'kFindCandidates') return { success: true, epoch: 'ep' + fid, ...(perFrame[fid] || { total: 0, visible: 0, candidates: [] }) };
    if (message.action === 'kResolveRef') return { success: true, epoch: 'ep' + fid, role: 'button', name: 'X' };
    return {};
  });
}

describe('target-resolver', () => {
  beforeEach(() => {
    chromeMock().storage.session.get.mockResolvedValue({});
  });

  it('matches frames by id, f-prefix, "top" and url substring', () => {
    const f = { frameId: 3, parentFrameId: 0, url: 'https://www.linkedin.com/preload/?x' };
    expect(frameMatches(f, 3)).toBe(true);
    expect(frameMatches(f, 'f3')).toBe(true);
    expect(frameMatches(f, 'preload')).toBe(true);
    expect(frameMatches(f, 'top')).toBe(false);
    expect(frameMatches(f, undefined)).toBe(true);
  });

  it('describes a candidate with its ref and frame', () => {
    expect(describeCandidate({ ref: 'f3e2', frame: 3, role: 'button', name: 'Post', tier: 'exact', in_viewport: false, area: 10 })).toBe('[f3e2] button "Post" (frame f3, off-screen)');
  });

  it('resolves a ref straight to its frame', async () => {
    mockFrames([{ frameId: 0, parentFrameId: -1, url: 'u0' }, { frameId: 3, parentFrameId: 0, url: 'u3' }]);
    mockCore({});
    const t = await resolveTarget(1, 'lane', { ref: 'f3e7', kind: 'click' });
    expect(t).toMatchObject({ frameId: 3, helperRef: 'ref_7', ref: 'f3e7', tier: 'ref' });
  });

  it('refuses a ref whose frame contradicts an explicit frame', async () => {
    mockFrames([{ frameId: 0, parentFrameId: -1, url: 'u0' }, { frameId: 3, parentFrameId: 0, url: 'u3' }]);
    mockCore({});
    await expect(resolveTarget(1, 'lane', { ref: 'f3e7', frame: 'f0', kind: 'click' })).rejects.toMatchObject({ code: 'WRONG_FRAME' });
  });

  it('prefers the exact match inside a child frame over a contains-match in the top frame', async () => {
    mockFrames([{ frameId: 0, parentFrameId: -1, url: 'u0' }, { frameId: 3, parentFrameId: 0, url: 'u3' }]);
    mockCore({
      0: { total: 1, visible: 1, candidates: [{ ref: 'ref_1', tier: 'contains', in_viewport: true, area: 500, role: 'button', name: 'Post now' }] },
      3: { total: 1, visible: 1, candidates: [{ ref: 'ref_9', tier: 'exact', in_viewport: true, area: 400, role: 'button', name: 'Post' }] },
    });
    const t = await resolveTarget(1, 'lane', { selector: 'text=Post', kind: 'click' });
    expect(t.ref).toBe('f3e9');
    expect(t.frameId).toBe(3);
    expect(t.alternatives.map((c) => c.ref)).toEqual(['f0e1']);
  });

  it('raises AMBIGUOUS with refs when two visible matches tie, and nth picks one', async () => {
    mockFrames([{ frameId: 0, parentFrameId: -1, url: 'u0' }]);
    mockCore({
      0: {
        total: 2,
        visible: 2,
        candidates: [
          { ref: 'ref_1', tier: 'exact', in_viewport: true, area: 100, role: 'button', name: 'Duplicate' },
          { ref: 'ref_2', tier: 'exact', in_viewport: true, area: 100, role: 'button', name: 'Duplicate' },
        ],
      },
    });
    let err: any = null;
    try {
      await resolveTarget(1, 'lane', { selector: 'text=Duplicate', kind: 'click' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrowserActionError);
    expect(err.code).toBe('AMBIGUOUS');
    expect(err.details.candidates.map((c: any) => c.ref)).toEqual(['f0e1', 'f0e2']);
    const second = await resolveTarget(1, 'lane', { selector: 'text=Duplicate', nth: 1, kind: 'click' });
    expect(second.ref).toBe('f0e2');
    const loose = await resolveTarget(1, 'lane', { selector: 'text=Duplicate', strict: false, kind: 'click' });
    expect(loose.ref).toBe('f0e1');
  });

  it('breaks a tie by viewport presence instead of raising', async () => {
    mockFrames([{ frameId: 0, parentFrameId: -1, url: 'u0' }]);
    mockCore({
      0: {
        total: 2,
        visible: 2,
        candidates: [
          { ref: 'ref_1', tier: 'exact', in_viewport: false, area: 100, role: 'button', name: 'Message' },
          { ref: 'ref_2', tier: 'exact', in_viewport: true, area: 100, role: 'button', name: 'Message' },
        ],
      },
    });
    const t = await resolveTarget(1, 'lane', { selector: 'text=Message', kind: 'click' });
    expect(t.ref).toBe('f0e2');
  });

  it('reports NOT_FOUND with the frames searched and hidden matches', async () => {
    mockFrames([{ frameId: 0, parentFrameId: -1, url: 'u0' }, { frameId: 2, parentFrameId: 0, url: 'u2' }]);
    mockCore({ 0: { total: 2, visible: 0, candidates: [] } });
    await expect(resolveTarget(1, 'lane', { selector: 'text=Nope', kind: 'click' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { frames_searched: [0, 2], hidden_matches: 2 },
    });
  });
});
