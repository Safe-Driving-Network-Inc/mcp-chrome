import { describe, it, expect } from 'vitest';
import { RUN_STEPS_ALLOWED, RUN_STEPS_MAX, __test } from '@/entrypoints/background/tools/browser/run-steps';

describe('run-steps helpers', () => {
  it('diffs snapshots by line and samples added/removed', () => {
    const before = '# snapshot a\n- button "Post" [f0e1]\n- link "Home" [f0e2]';
    const after = '# snapshot b\n- button "Post" [f0e1]\n- dialog "Editor" [f3e1]';
    const d = __test.lineDiff(before, after);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.sample).toContain('+ - dialog "Editor" [f3e1]');
    expect(d.sample).toContain('- - link "Home" [f0e2]');
  });
  it('compacts step data and hides screenshot bytes', () => {
    expect(__test.compactData('screenshot', { base64: 'x'.repeat(5000) })).toEqual({ captured: true });
    const c = __test.compactData('read', { textContent: 'y'.repeat(2000), message: 'ok' });
    expect(c.textContent.length).toBeLessThan(700);
  });
  it('keeps the allowed step set bounded', () => {
    expect(RUN_STEPS_ALLOWED).not.toContain('run_steps');
    expect(RUN_STEPS_ALLOWED).not.toContain('upload');
    expect(RUN_STEPS_MAX).toBe(25);
  });
});
