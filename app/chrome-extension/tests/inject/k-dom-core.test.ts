/**
 * k-dom-core.js under jsdom. The script is loaded with a Function wrapper so it
 * runs against the test window; jsdom has no layout, so getBoundingClientRect is
 * stubbed to give every element a box unless it carries data-hidden.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Listener = (request: any, sender: any, sendResponse: (r: any) => void) => boolean | void;

let listener: Listener;

function call(message: Record<string, any>): Promise<any> {
  return new Promise((resolveP) => {
    const ret = listener(message, {}, (r) => resolveP(r));
    if (ret === false) {
      // synchronous responders already called sendResponse
    }
  });
}

beforeAll(() => {
  document.body.innerHTML = `
    <nav aria-label="Primary"><a href="/feed/" id="home">Home</a></nav>
    <h1>Feed</h1>
    <button id="post-btn"><span>Post</span></button>
    <button id="dup1">Duplicate</button>
    <button id="dup2">Duplicate</button>
    <button id="hidden-dup" data-hidden="1">Duplicate</button>
    <label for="cap">Caption</label><input id="cap" type="text" />
    <div role="dialog" aria-modal="true" aria-label="Create a post" id="dlg"><button id="close">Close</button></div>
    <input type="file" id="file" data-hidden="1" />
  `;
  // Layout stub: a box for everything except data-hidden elements.
  (Element.prototype as any).getBoundingClientRect = function () {
    const hidden = (this as Element).getAttribute && (this as Element).getAttribute('data-hidden') === '1';
    const w = hidden ? 0 : 100;
    const h = hidden ? 0 : 20;
    return { x: 10, y: 10, left: 10, top: 10, right: 10 + w, bottom: 10 + h, width: w, height: h, toJSON() {} } as DOMRect;
  };
  const src = readFileSync(resolve(__dirname, '../../inject-scripts/k-dom-core.js'), 'utf8');
  const addListener = (globalThis as any).chrome.runtime.onMessage.addListener;
  const before = addListener.mock.calls.length;
  new Function('window', 'document', 'chrome', 'location', src)(window, document, (globalThis as any).chrome, window.location);
  listener = addListener.mock.calls[before][0];
});

describe('k-dom-core', () => {
  it('answers the core ping with the document epoch', async () => {
    const r = await call({ action: 'k_dom_core_ping' });
    expect(r.status).toBe('pong');
    expect(typeof r.epoch).toBe('string');
    expect((window as any).__kDocEpoch).toBe(r.epoch);
  });

  it('computes accessible names through wrapper spans and labels', async () => {
    const r = await call({ action: 'kFindCandidates', selector: 'text=Post', kind: 'click' });
    expect(r.success).toBe(true);
    expect(r.candidates[0]).toMatchObject({ role: 'button', name: 'Post', tier: 'exact' });
    const f = await call({ action: 'kFindCandidates', selector: 'text=Caption', kind: 'fill' });
    expect(f.candidates[0]).toMatchObject({ role: 'textbox', name: 'Caption', editable: true });
  });

  it('ranks duplicates as exact matches and drops the hidden one', async () => {
    const r = await call({ action: 'kFindCandidates', selector: 'text=Duplicate', kind: 'click' });
    expect(r.total).toBe(3);
    expect(r.visible).toBe(2);
    expect(r.candidates.map((c: any) => c.tier)).toEqual(['exact', 'exact']);
    expect(r.candidates[0].ref).toMatch(/^ref_\d+$/);
  });

  it('resolves refs with the epoch and refuses stale ones', async () => {
    const f = await call({ action: 'kFindCandidates', selector: '#home', kind: 'any' });
    const ref = f.candidates[0].ref;
    const ok = await call({ action: 'kResolveRef', ref, expect_epoch: f.epoch });
    expect(ok.success).toBe(true);
    expect(ok.role).toBe('link');
    const stale = await call({ action: 'kResolveRef', ref, expect_epoch: 'old-epoch' });
    expect(stale.error.code).toBe('STALE_REF');
    const unknown = await call({ action: 'kResolveRef', ref: 'ref_999999' });
    expect(unknown.error.code).toBe('STALE_REF');
  });

  it('reports open dialogs and focus in the state probe', async () => {
    (document.getElementById('cap') as HTMLInputElement).focus();
    const s = await call({ action: 'kStateProbe' });
    expect(s.dialogs).toHaveLength(1);
    expect(s.dialogs[0]).toMatchObject({ name: 'Create a post', modal: true });
    expect(s.focus).toMatchObject({ role: 'textbox', name: 'Caption', editable: true, is_iframe: false });
    const fp = await call({ action: 'kFocusProbe' });
    expect(fp.active).toMatchObject({ editable: true, name: 'Caption' });
    expect(fp.editables_visible).toBeGreaterThanOrEqual(1);
  });

  it('emits a compact snapshot with refs, the dialog and the focused mark', async () => {
    const s = await call({ action: 'kSnapshot', mode: 'interactive', maxLines: 200 });
    expect(s.success).toBe(true);
    const text = s.lines.join('\n');
    expect(text).toMatch(/- button "Post" \[ref_\d+\]/);
    expect(text).toMatch(/- dialog "Create a post" \[ref_\d+\] modal/);
    expect(text).toMatch(/- textbox "Caption" \[ref_\d+\] \*focused\*/);
    expect(text).toMatch(/- filechooser \[ref_\d+\]/);
    expect(text).toMatch(/- heading "Feed" \[ref_\d+\] level=1/);
    expect(s.dialogs).toHaveLength(1);
    expect(s.refs).toBeGreaterThan(5);
  });

  it('scopes a snapshot to a subtree by selector', async () => {
    const s = await call({ action: 'kSnapshot', mode: 'interactive', scopeSelector: '#dlg' });
    const text = s.lines.join('\n');
    expect(text).toContain('button "Close"');
    expect(text).not.toContain('button "Post"');
  });

  it('waits for text to appear and times out honestly', async () => {
    setTimeout(() => {
      const p = document.createElement('p');
      p.textContent = 'Done!';
      document.body.appendChild(p);
    }, 50);
    const w = await call({ action: 'kWaitFor', text: 'Done!', state: 'visible', timeout: 2000 });
    expect(w.success).toBe(true);
    expect(w.matched).toMatchObject({ name: 'Done!' });
    const t = await call({ action: 'kWaitFor', text: 'never appears', state: 'visible', timeout: 150 });
    expect(t.success).toBe(false);
    expect(t.reason).toBe('timeout');
  });

  it('reports a NOT_FOUND scroll target instead of scrolling the page', async () => {
    const r = await call({ action: 'kScroll', selector: '#does-not-exist', direction: 'down' });
    expect(r.error.code).toBe('NOT_FOUND');
  });
});
