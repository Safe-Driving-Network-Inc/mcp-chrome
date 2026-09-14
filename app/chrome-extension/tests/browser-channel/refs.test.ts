import { describe, it, expect } from 'vitest';
import { parseRef, formatRef, isRef, rewriteHelperRefs } from '@/common/browser-refs';

describe('browser-refs', () => {
  it('parses f<frame>e<n>', () => {
    expect(parseRef('f0e12')).toEqual({ frameId: 0, n: 12, helperRef: 'ref_12' });
    expect(parseRef(' f3e7 ')).toEqual({ frameId: 3, n: 7, helperRef: 'ref_7' });
  });
  it('rejects anything else', () => {
    expect(parseRef('ref_12')).toBeNull();
    expect(parseRef('f3')).toBeNull();
    expect(parseRef('e12')).toBeNull();
    expect(parseRef('f3e0')).toBeNull();
    expect(parseRef(12 as any)).toBeNull();
    expect(isRef('text=Post')).toBe(false);
    expect(isRef('f1e1')).toBe(true);
  });
  it('formats helper refs per frame', () => {
    expect(formatRef(3, 'ref_12')).toBe('f3e12');
    expect(formatRef(0, 'bogus')).toBe('');
  });
  it('rewrites every helper ref in a snapshot line', () => {
    expect(rewriteHelperRefs('- button "Post" [ref_12] [ref_13]', 3)).toBe('- button "Post" [f3e12] [f3e13]');
  });
});
