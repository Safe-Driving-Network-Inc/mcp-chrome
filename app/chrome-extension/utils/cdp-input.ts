// Kareenos Browser Channel v2 — trusted keyboard input over CDP.
//
// Synthetic KeyboardEvents dispatched from a content script are UNTRUSTED:
// Enter does not submit a form, characters are not inserted, and most rich
// editors ignore them. Input.dispatchKeyEvent / Input.insertText through the
// debugger produce real input. Chord grammar: comma-separated chords, each
// `Mod+…+Key` — "Enter", "Ctrl+A, Delete", "Shift+Tab", "a".
import { cdpSessionManager } from './cdp-session-manager';

interface KeyDef {
  key: string;
  code: string;
  vk: number;
  text?: string;
}

const NAMED: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  del: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  insert: { key: 'Insert', code: 'Insert', vk: 45 },
};
for (let i = 1; i <= 12; i++) NAMED['f' + i] = { key: 'F' + i, code: 'F' + i, vk: 111 + i };

const MODIFIER_BITS: Record<string, number> = {
  alt: 1, option: 1,
  ctrl: 2, control: 2,
  meta: 4, cmd: 4, command: 4, win: 4, windows: 4,
  shift: 8,
};

export interface ParsedChord {
  raw: string;
  modifiers: string[];
  mask: number;
  def: KeyDef;
  printable: boolean; // a single printable char with no non-shift modifier
}

export function parseChord(raw: string): ParsedChord {
  const parts = String(raw || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('empty key chord');
  const modifiers: string[] = [];
  let keyToken = '';
  parts.forEach((p, i) => {
    const l = p.toLowerCase();
    if (MODIFIER_BITS[l] !== undefined && i < parts.length - 1) modifiers.push(l);
    else if (!keyToken) keyToken = p;
    else throw new Error(`invalid key chord "${raw}": more than one key`);
  });
  if (!keyToken) throw new Error(`invalid key chord "${raw}"`);
  let mask = 0;
  modifiers.forEach((m) => (mask |= MODIFIER_BITS[m]));
  const lower = keyToken.toLowerCase();
  let def: KeyDef;
  if (NAMED[lower]) def = NAMED[lower];
  else if (keyToken.length === 1) {
    const ch = keyToken;
    const upper = ch.toUpperCase();
    const isLetter = /^[a-z]$/i.test(ch);
    const isDigit = /^[0-9]$/.test(ch);
    const shifted = (mask & 8) !== 0;
    def = {
      key: isLetter ? (shifted ? upper : ch.toLowerCase()) : ch,
      code: isLetter ? 'Key' + upper : isDigit ? 'Digit' + ch : '',
      vk: isLetter ? upper.charCodeAt(0) : isDigit ? ch.charCodeAt(0) : ch.toUpperCase().charCodeAt(0),
      text: isLetter ? (shifted ? upper : ch.toLowerCase()) : ch,
    };
  } else {
    throw new Error(`unknown key "${keyToken}" in chord "${raw}" (use Enter, Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/Down, F1-F12, or single characters)`);
  }
  const nonShift = mask & ~8;
  return { raw, modifiers, mask, def, printable: keyToken.length === 1 && nonShift === 0 && !NAMED[lower] };
}

export function parseKeys(keys: string): ParsedChord[] {
  return String(keys || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseChord);
}

async function send(tabId: number, method: string, params: Record<string, any>) {
  await cdpSessionManager.sendCommand(tabId, method, params);
}

async function dispatchChord(tabId: number, chord: ParsedChord) {
  if (chord.printable) {
    await send(tabId, 'Input.insertText', { text: chord.def.text });
    return;
  }
  const d = chord.def;
  const nonShift = chord.mask & ~8;
  const text = nonShift === 0 && d.text ? d.text : '';
  const down: Record<string, any> = {
    type: text ? 'keyDown' : 'rawKeyDown',
    key: d.key,
    windowsVirtualKeyCode: d.vk,
    nativeVirtualKeyCode: d.vk,
    modifiers: chord.mask,
  };
  if (d.code) down.code = d.code;
  if (text) {
    down.text = text;
    down.unmodifiedText = text;
  }
  await send(tabId, 'Input.dispatchKeyEvent', down);
  const up: Record<string, any> = { type: 'keyUp', key: d.key, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk, modifiers: chord.mask };
  if (d.code) up.code = d.code;
  await send(tabId, 'Input.dispatchKeyEvent', up);
}

// Dispatch every chord in order inside ONE debugger session. Throws when the
// debugger cannot be attached (DevTools / another extension holds the tab).
export async function dispatchKeysCdp(tabId: number, keys: string, delayMs = 30): Promise<{ chords: string[] }> {
  const chords = parseKeys(keys);
  if (!chords.length) throw new Error('keys is empty');
  await cdpSessionManager.withSession(tabId, 'press', async () => {
    for (let i = 0; i < chords.length; i++) {
      await dispatchChord(tabId, chords[i]);
      if (delayMs > 0 && i < chords.length - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  });
  return { chords: chords.map((c) => c.raw) };
}
