import { describe, it, expect } from 'vitest';
import { formatSnapshot, type FrameSnapshot } from '@/entrypoints/background/tools/browser/snapshot-format';

function frame(id: number, lines: string[], extra: Partial<FrameSnapshot> = {}): FrameSnapshot {
  return {
    frameId: id,
    parentFrameId: id === 0 ? -1 : 0,
    url: `https://example.com/f${id}`,
    lines,
    refs: lines.length,
    truncated: false,
    dialogs: [],
    focus: null,
    ...extra,
  };
}

describe('snapshot-format', () => {
  it('puts the dialog-owning frame first and flags it in the header', () => {
    const out = formatSnapshot({
      url: 'https://example.com/',
      title: 'Feed',
      mode: 'interactive',
      maxChars: 30000,
      frames: [
        frame(0, ['- button "Start a post" [f0e1]'], { viewport: { w: 1280, h: 720, scrollX: 0, scrollY: 0, scrollW: 1280, scrollH: 5400 } }),
        frame(3, ['- dialog "Create a post" [f3e1] modal', '  - textbox "Text" [f3e7] *focused* editable'], {
          dialogs: [{ ref: 'f3e1', name: 'Create a post', modal: true }],
          focus: { ref: 'f3e7', role: 'textbox', name: 'Text' },
        }),
      ],
    });
    const lines = out.text.split('\n');
    expect(lines[0]).toMatch(/^# snapshot url=https:\/\/example.com\/ title="Feed" viewport=1280x720 scroll=0\/5400 frames=2 refs=3 mode=interactive chars=\d+\/30000$/);
    expect(lines[1]).toBe('!! dialog open: "Create a post" [f3e1] modal (frame f3)');
    expect(lines[2]).toBe('* focus: [f3e7] textbox "Text"');
    expect(lines[3]).toBe('## f3 child-of=f0 url=https://example.com/f3 dialog');
    expect(out.text.indexOf('## f3')).toBeLessThan(out.text.indexOf('## f0 top'));
    expect(out.truncated).toBe(false);
    expect(out.frames_included).toEqual([3, 0]);
  });
  it('skips empty frames and reports inaccessible ones', () => {
    const out = formatSnapshot({
      url: 'u',
      title: 't',
      mode: 'interactive',
      maxChars: 30000,
      frames: [frame(0, ['- link "Home" [f0e1]']), frame(5, []), frame(6, [], { error: { code: 'NO_FRAME_ACCESS', message: 'x' } })],
    });
    expect(out.text).toContain('(1 empty/ad frame skipped: f5)');
    expect(out.text).toContain('(frame f6 not accessible: NO_FRAME_ACCESS');
    expect(out.frames_skipped).toEqual([5]);
    expect(out.frames_inaccessible).toEqual([6]);
  });
  it('cuts each frame to its budget with an omitted marker and never exceeds max_chars', () => {
    const big = Array.from({ length: 400 }, (_, i) => `- link "Item ${i}" [f0e${i + 1}] href="/item/${i}"`);
    const small = Array.from({ length: 10 }, (_, i) => `- button "B${i}" [f2e${i + 1}]`);
    const out = formatSnapshot({ url: 'u', title: 't', mode: 'interactive', maxChars: 4000, frames: [frame(0, big), frame(2, small)] });
    expect(out.chars).toBeLessThanOrEqual(4000);
    expect(out.truncated).toBe(true);
    expect(out.text).toMatch(/… \+\d+ lines omitted/);
    // the small frame keeps its floor: all ten lines survive
    expect(out.text).toContain('- button "B9" [f2e10]');
  });
});
