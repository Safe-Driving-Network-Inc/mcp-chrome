import { describe, it, expect } from 'vitest';
import { parseChord, parseKeys } from '@/utils/cdp-input';

describe('cdp-input chord grammar', () => {
  it('parses named keys, chords and printable characters', () => {
    expect(parseChord('Enter')).toMatchObject({ mask: 0, printable: false, def: { key: 'Enter', vk: 13, text: '\r' } });
    expect(parseChord('Ctrl+A')).toMatchObject({ mask: 2, printable: false, def: { key: 'a', code: 'KeyA', vk: 65 } });
    expect(parseChord('Shift+Tab')).toMatchObject({ mask: 8, def: { key: 'Tab', vk: 9 } });
    expect(parseChord('a')).toMatchObject({ printable: true, def: { text: 'a' } });
    expect(parseChord('Cmd+Shift+z')).toMatchObject({ mask: 12, def: { key: 'Z', vk: 90 } });
    expect(parseKeys('Ctrl+A, Delete, x').map((c) => c.raw)).toEqual(['Ctrl+A', 'Delete', 'x']);
  });
  it('rejects unknown keys and malformed chords', () => {
    expect(() => parseChord('Bogus')).toThrow(/unknown key/);
    expect(() => parseChord('Ctrl+A+B')).toThrow(/more than one key/);
    expect(parseKeys('')).toEqual([]);
  });
});
