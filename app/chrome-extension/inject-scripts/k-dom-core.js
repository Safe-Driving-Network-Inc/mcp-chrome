/* eslint-disable */
// k-dom-core.js — Kareenos Browser Channel v2: the ONE in-page core that every
// action shares. Injected per frame (ISOLATED world), idempotent. It owns:
//
//   * the document EPOCH (window.__kDocEpoch) + the shared ref map — refs are
//     `ref_<n>` in here and `f<frameId>e<n>` on the wire; a ref is only honoured
//     when the caller's expected epoch matches (a frame that navigated gets a new
//     epoch, so a stale ref is refused as STALE_REF instead of silently pointing
//     at whatever element got the same counter value);
//   * targeting: deep (open shadow root) queries, `text=` / `:has-text()` text
//     queries, accessible names, ranked candidates with tiers;
//   * probes: focus owner (activeElement chain — document.hasFocus() is false in
//     a background tab), open dialogs, quiet-wait (MutationObserver), iframe
//     rects, element rects in top-document coordinates;
//   * the compact accessibility SNAPSHOT (Playwright-style lines with refs);
//   * wait-for (text/selector/ref × visible/hidden/attached/detached);
//   * scroll (element, nearest scrollable ancestor, or the frame).
//
// Every reply carries `epoch`. Known failures come back as
// { error: { code, message, details } } — never a bare string — so the tool
// layer can surface a structured error code to the agent.
//
// The page is UNTRUSTED DATA: nothing here reads page state as an instruction,
// and the ref map stays in the isolated world (a MAIN-world map would be
// tamperable by the page).

(function () {
  if (window.__K_DOM_CORE__) return;
  var K = { version: 2 };
  window.__K_DOM_CORE__ = K;

  // ---------------------------------------------------------------------------
  // Epoch + shared ref map (interoperable with accessibility-tree-helper.js,
  // click-helper.js, fill-helper.js: all read window.__claudeElementMap).
  // ---------------------------------------------------------------------------
  if (!window.__kDocEpoch) {
    window.__kDocEpoch = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  if (!window.__claudeElementMap) window.__claudeElementMap = {};
  if (!window.__claudeRefCounter) window.__claudeRefCounter = 0;
  var EPOCH = window.__kDocEpoch;

  function err(code, message, details) {
    var e = { code: code, message: message };
    if (details) e.details = details;
    return { error: e, epoch: EPOCH };
  }

  function ensureRef(el) {
    var map = window.__claudeElementMap;
    for (var k in map) {
      var w = map[k];
      try {
        if (w && typeof w.deref === 'function' && w.deref() === el) return k;
      } catch (e) {}
    }
    var refId = 'ref_' + ++window.__claudeRefCounter;
    map[refId] = new WeakRef(el);
    return refId;
  }

  // Resolve a helper ref. expectEpoch (optional) must equal this document's
  // epoch, or the ref is from before a navigation and is refused.
  function resolveRef(ref, expectEpoch) {
    if (!ref || typeof ref !== 'string') return err('NOT_FOUND', 'ref is required');
    if (expectEpoch && expectEpoch !== EPOCH) {
      return err(
        'STALE_REF',
        'Ref ' + ref + ' belongs to a previous version of this frame (it navigated or reloaded). Take a new browser_snapshot and use a fresh ref.',
        { ref: ref },
      );
    }
    var map = window.__claudeElementMap || {};
    var w = map[ref];
    var el = null;
    try {
      el = w && typeof w.deref === 'function' ? w.deref() : null;
    } catch (e) {
      el = null;
    }
    if (!el || !(el instanceof Element)) {
      return err('STALE_REF', 'Ref ' + ref + ' is unknown in this frame (take a new browser_snapshot).', { ref: ref });
    }
    if (!el.isConnected) {
      return err('DETACHED', 'The element behind ref ' + ref + ' was removed from the page (take a new browser_snapshot).', { ref: ref });
    }
    return { el: el };
  }
  window.__kEnsureRef = ensureRef;
  window.__kResolveRef = resolveRef;

  // ---------------------------------------------------------------------------
  // Query primitives
  // ---------------------------------------------------------------------------
  var INTERACTIVE_SEL =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,label,' +
    '[contenteditable=""],[contenteditable="true"],[onclick],[tabindex],' +
    '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"],' +
    '[role="option"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="textbox"],' +
    '[role="searchbox"],[role="combobox"],[role="spinbutton"],[role="tab"],[role="treeitem"],' +
    '[role="gridcell"],[role="row"],[role="listbox"]';
  var EDITABLE_SEL =
    'textarea,input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=image]):not([type=reset]),' +
    'select,[contenteditable=""],[contenteditable="true"],[role="textbox"],[role="searchbox"],[role="combobox"]';
  var INTERACTIVE_ROLES = {
    button: 1, link: 1, checkbox: 1, radio: 1, switch: 1, slider: 1, option: 1, menuitem: 1,
    menuitemcheckbox: 1, menuitemradio: 1, textbox: 1, searchbox: 1, combobox: 1, spinbutton: 1,
    tab: 1, treeitem: 1, gridcell: 1, listbox: 1, filechooser: 1
  };

  function stripQuotes(s) {
    s = String(s).trim();
    if ((s.charAt(0) === '"' && s.slice(-1) === '"') || (s.charAt(0) === "'" && s.slice(-1) === "'")) return s.slice(1, -1);
    return s;
  }
  // text=Label | text="Label" | :has-text("Label") | :contains("Label") → the label; else null.
  function parseTextQuery(sel) {
    if (typeof sel !== 'string') return null;
    var m = sel.match(/^\s*text\s*=\s*(.+)$/i);
    if (m) return stripQuotes(m[1]);
    m = sel.match(/:(?:has-text|contains)\(\s*(.+?)\s*\)\s*$/i);
    if (m) return stripQuotes(m[1]);
    return null;
  }
  K.parseTextQuery = parseTextQuery;

  function deepQueryAll(selector, root, out, depth) {
    root = root || document;
    out = out || [];
    depth = depth || 0;
    if (depth > 12 || out.length > 6000) return out;
    var matches = [];
    try {
      matches = root.querySelectorAll(selector);
    } catch (e) {
      return out;
    }
    for (var i = 0; i < matches.length; i++) out.push(matches[i]);
    var all = [];
    try {
      all = root.querySelectorAll('*');
    } catch (e) {
      return out;
    }
    for (var j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) deepQueryAll(selector, all[j].shadowRoot, out, depth + 1);
    }
    return out;
  }
  K.deepQueryAll = deepQueryAll;

  function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function styleOf(el) {
    try {
      return window.getComputedStyle(el);
    } catch (e) {
      return null;
    }
  }

  // Renderable = not display:none / visibility:hidden / opacity 0 / aria-hidden,
  // and has a box. NOT viewport-gated: actions scroll into view themselves.
  function renderable(el) {
    if (!el || !el.getBoundingClientRect || el.nodeType !== 1) return false;
    var s = styleOf(el);
    if (!s || s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    if (el.getAttribute && (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden'))) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function inViewport(el) {
    var r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
  }
  function area(el) {
    var r = el.getBoundingClientRect();
    return r.width * r.height;
  }
  K.renderable = renderable;

  function isDisabled(el) {
    try {
      return !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
    } catch (e) {
      return false;
    }
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      return ['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'].indexOf(t) === -1;
    }
    if (el.isContentEditable) return true;
    var role = el.getAttribute('role');
    return role === 'textbox' || role === 'searchbox' || role === 'combobox';
  }
  K.isEditable = isEditable;

  var TAG_ROLE = {
    a: 'link', button: 'button', textarea: 'textbox', select: 'combobox', summary: 'button', option: 'option',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', aside: 'complementary',
    form: 'form', dialog: 'dialog', img: 'img', li: 'listitem', ul: 'list', ol: 'list', table: 'table',
    tr: 'row', td: 'cell', th: 'columnheader', label: 'label', iframe: 'iframe', frame: 'iframe',
    section: 'region', article: 'article', fieldset: 'group', details: 'group', progress: 'progressbar',
    menu: 'menu', video: 'video', audio: 'audio'
  };
  function roleOf(el) {
    var role = el.getAttribute && el.getAttribute('role');
    if (role) return String(role).trim().split(/\s+/)[0].toLowerCase();
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      if (t === 'file') return 'filechooser';
      if (t === 'search') return 'searchbox';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      return 'textbox';
    }
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (el.isContentEditable && tag !== 'body') return 'textbox';
    return TAG_ROLE[tag] || 'generic';
  }
  K.roleOf = roleOf;

  function isInteractive(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href');
    if (['button', 'select', 'textarea', 'summary', 'label'].indexOf(tag) !== -1) return true;
    if (tag === 'input') return (el.getAttribute('type') || '').toLowerCase() !== 'hidden';
    if (el.isContentEditable && tag !== 'body') return true;
    if (el.getAttribute('onclick') != null) return true;
    var ti = el.getAttribute('tabindex');
    if (ti != null && String(ti).trim() !== '' && !String(ti).trim().startsWith('-')) return true;
    var role = (el.getAttribute('role') || '').toLowerCase();
    return !!(role && INTERACTIVE_ROLES[role]);
  }
  K.isInteractive = isInteractive;

  // Accessible name: aria-labelledby → aria-label → label[for] / wrapping label
  // → placeholder → title → alt → own text → value. The upstream tree helper
  // read only DIRECT text nodes for buttons, so <button><span>Post</span></button>
  // (how LinkedIn wraps every label) came out nameless.
  function accessibleName(el) {
    if (!el || el.nodeType !== 1) return '';
    var v;
    try {
      var lb = el.getAttribute('aria-labelledby');
      if (lb) {
        var parts = [];
        lb.split(/\s+/).forEach(function (id) {
          var n = (el.getRootNode && el.getRootNode().getElementById ? el.getRootNode().getElementById(id) : null) || document.getElementById(id);
          if (n) parts.push(norm(n.textContent));
        });
        v = norm(parts.join(' '));
        if (v) return v.slice(0, 80);
      }
      v = norm(el.getAttribute('aria-label'));
      if (v) return v.slice(0, 80);
      var tag = el.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        if (el.id) {
          var root = el.getRootNode && el.getRootNode() ? el.getRootNode() : document;
          var lab = null;
          try {
            lab = root.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
          } catch (e) {}
          if (lab) {
            v = norm(lab.textContent);
            if (v) return v.slice(0, 80);
          }
        }
        var wrap = el.closest && el.closest('label');
        if (wrap) {
          v = norm(wrap.textContent);
          if (v) return v.slice(0, 80);
        }
      }
      v = norm(el.getAttribute('placeholder'));
      if (v) return v.slice(0, 80);
      if (tag === 'img' || tag === 'area') {
        v = norm(el.getAttribute('alt'));
        if (v) return v.slice(0, 80);
      }
      v = norm(el.getAttribute('title'));
      if (v && (tag === 'iframe' || tag === 'img' || tag === 'svg')) return v.slice(0, 80);
      if (tag === 'iframe' || tag === 'frame') {
        v = norm(el.getAttribute('name') || el.getAttribute('title'));
        if (v) return v.slice(0, 80);
        return '';
      }
      if (tag === 'select') {
        var opt = el.options && el.options[el.selectedIndex];
        if (opt) {
          v = norm(opt.textContent);
          if (v) return v.slice(0, 80);
        }
      }
      if (tag !== 'input' && tag !== 'textarea') {
        v = norm(el.textContent);
        if (v) return v.slice(0, 80);
      }
      if (tag === 'input') {
        var t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'submit' || t === 'button' || t === 'reset') {
          v = norm(el.value || el.getAttribute('value'));
          if (v) return v.slice(0, 80);
          return t === 'submit' ? 'Submit' : '';
        }
      }
      v = norm(el.getAttribute('title'));
      if (v) return v.slice(0, 80);
      v = norm(el.getAttribute('name'));
      if (v && (tag === 'input' || tag === 'textarea' || tag === 'select')) return v.slice(0, 80);
    } catch (e) {}
    return '';
  }
  K.accessibleName = accessibleName;

  // ---------------------------------------------------------------------------
  // Candidates (targeting). kind: click | fill | upload | any
  // ---------------------------------------------------------------------------
  function poolFor(kind) {
    if (kind === 'fill') return deepQueryAll(EDITABLE_SEL);
    if (kind === 'upload') return deepQueryAll('input[type=file],label,button,[role="button"],[id*="drop" i],[id*="upload" i],[id*="attach" i],[class*="drop" i],[class*="upload" i],[class*="attach" i]');
    return deepQueryAll(INTERACTIVE_SEL);
  }

  function rankSort(a, b) {
    if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank;
    if (a.in_viewport !== b.in_viewport) return a.in_viewport ? -1 : 1;
    return a.area - b.area;
  }
  var TIER_RANK = { exact: 0, contains: 1, css: 2, ancestor: 3 };

  function describe(el) {
    return { role: roleOf(el), name: accessibleName(el), tag: el.tagName.toLowerCase(), editable: isEditable(el), disabled: isDisabled(el) };
  }

  function findCandidates(selector, kind, limit) {
    kind = kind || 'any';
    limit = Math.max(1, Math.min(Number(limit) || 10, 50));
    var q = parseTextQuery(selector);
    var list = [];
    var total = 0;
    var seen = new Set();
    function push(el, tier) {
      if (!el || seen.has(el)) return;
      seen.add(el);
      total++;
      if (!renderable(el)) return;
      list.push({
        el: el, tier: tier, tierRank: TIER_RANK[tier], in_viewport: inViewport(el), area: area(el)
      });
    }
    if (q != null) {
      var needle = norm(q).toLowerCase();
      if (!needle) return { total: 0, candidates: [] };
      var pool = poolFor(kind);
      var i;
      for (i = 0; i < pool.length; i++) {
        var n = accessibleName(pool[i]).toLowerCase();
        if (!n) continue;
        if (n === needle) push(pool[i], 'exact');
      }
      for (i = 0; i < pool.length; i++) {
        var n2 = accessibleName(pool[i]).toLowerCase();
        if (n2 && n2 !== needle && n2.indexOf(needle) !== -1) push(pool[i], 'contains');
      }
      if (!list.length && (kind === 'click' || kind === 'any' || kind === 'upload')) {
        // Fallback: any element whose own text equals the label → nearest
        // clickable ancestor (hashed-class UIs wrap labels in bare spans).
        var textEls = deepQueryAll('*').filter(function (el) {
          if (el.children && el.children.length > 3) return false;
          return norm(el.textContent).toLowerCase() === needle;
        });
        for (i = 0; i < textEls.length; i++) {
          var c = textEls[i].closest('a,button,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[onclick],label,[tabindex]');
          if (c) push(c, 'ancestor');
          else if (kind === 'any' || kind === 'upload') push(textEls[i], 'ancestor');
        }
      }
    } else {
      var css = deepQueryAll(selector);
      for (var j = 0; j < css.length; j++) push(css[j], 'css');
    }
    list.sort(rankSort);
    var out = list.slice(0, limit).map(function (c) {
      var d = describe(c.el);
      return {
        ref: ensureRef(c.el), tier: c.tier, in_viewport: c.in_viewport, area: Math.round(c.area),
        role: d.role, name: d.name, tag: d.tag, editable: d.editable, disabled: d.disabled
      };
    });
    return { total: total, visible: list.length, candidates: out };
  }
  K.findCandidates = findCandidates;
  K.bestElement = bestElement;

  // Single best element for a selector (used by helpers that take a selector
  // directly, e.g. kElementRect / kScroll / kWaitFor).
  function bestElement(selector, kind) {
    var r = findCandidates(selector, kind || 'any', 1);
    if (!r.candidates.length) return null;
    var res = resolveRef(r.candidates[0].ref);
    return res.el || null;
  }

  // ---------------------------------------------------------------------------
  // Focus / dialogs / probes
  // ---------------------------------------------------------------------------
  function deepActiveElement() {
    var a = document.activeElement;
    var guard = 0;
    while (a && a.shadowRoot && a.shadowRoot.activeElement && guard++ < 20) a = a.shadowRoot.activeElement;
    return a && a !== document.body && a !== document.documentElement ? a : null;
  }
  K.deepActiveElement = deepActiveElement;

  function focusInfo() {
    var a = deepActiveElement();
    if (!a) return null;
    var d = describe(a);
    return {
      ref: ensureRef(a), role: d.role, name: d.name, tag: d.tag, editable: d.editable,
      is_iframe: a.tagName === 'IFRAME' || a.tagName === 'FRAME'
    };
  }

  function dialogs() {
    var els = deepQueryAll('[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]');
    var out = [];
    var seen = new Set();
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (seen.has(el) || !renderable(el)) continue;
      seen.add(el);
      var modal = el.getAttribute('aria-modal') === 'true' || (el.tagName === 'DIALOG' && el.hasAttribute('open'));
      out.push({ ref: ensureRef(el), name: accessibleName(el).slice(0, 80), modal: modal });
      if (out.length >= 5) break;
    }
    return out;
  }

  function stateProbe() {
    return {
      success: true, epoch: EPOCH, url: location.href, title: document.title || '',
      dialogs: dialogs(), focus: focusInfo()
    };
  }

  function focusProbe() {
    var a = deepActiveElement();
    var editables = deepQueryAll(EDITABLE_SEL).filter(function (el) { return renderable(el) && !isDisabled(el); });
    return {
      success: true, epoch: EPOCH, url: location.href,
      active: a ? (function () {
        var d = describe(a);
        return { ref: ensureRef(a), role: d.role, name: d.name, tag: d.tag, editable: d.editable, is_iframe: a.tagName === 'IFRAME' || a.tagName === 'FRAME' };
      })() : null,
      editables_visible: editables.length,
      editables: editables.slice(0, 10).map(function (el) {
        var d = describe(el);
        return { ref: ensureRef(el), role: d.role, name: d.name, tag: d.tag, in_viewport: inViewport(el) };
      })
    };
  }

  function quietWait(quietMs, capMs) {
    quietMs = Math.max(50, Math.min(Number(quietMs) || 300, 2000));
    capMs = Math.max(quietMs, Math.min(Number(capMs) || 3000, 30000));
    return new Promise(function (resolve) {
      var start = Date.now();
      var mutations = 0;
      var last = Date.now();
      var done = false;
      var obs = null;
      function finish(capped) {
        if (done) return;
        done = true;
        try { if (obs) obs.disconnect(); } catch (e) {}
        clearInterval(tick);
        resolve({ success: true, epoch: EPOCH, mutations: mutations, waited_ms: Date.now() - start, capped: !!capped });
      }
      try {
        obs = new MutationObserver(function (list) {
          mutations += list.length;
          last = Date.now();
        });
        obs.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch (e) {
        finish(false);
        return;
      }
      var tick = setInterval(function () {
        var now = Date.now();
        if (now - last >= quietMs) finish(false);
        else if (now - start >= capMs) finish(true);
      }, 50);
    });
  }

  function listIframes() {
    var frames = deepQueryAll('iframe,frame');
    return frames.map(function (f, i) {
      var r = f.getBoundingClientRect();
      return {
        index: i, src: f.getAttribute('src') || '', name: f.getAttribute('name') || '', title: f.getAttribute('title') || '',
        rect: { x: r.left, y: r.top, width: r.width, height: r.height }, visible: renderable(f)
      };
    });
  }

  // Element rect in this frame + translated to the TOP document's page
  // coordinates through same-origin frame elements (chain_complete=false when
  // a cross-origin ancestor blocks the walk — the caller falls back).
  function elementRect(msg) {
    var el = null;
    if (msg.ref) {
      var r0 = resolveRef(msg.ref, msg.expect_epoch);
      if (r0.error) return r0;
      el = r0.el;
    } else if (msg.selector) {
      el = bestElement(msg.selector, 'any');
      if (!el) return err('NOT_FOUND', 'No element matches "' + msg.selector + '" in this frame.', { selector: msg.selector });
    } else {
      return err('NOT_FOUND', 'ref or selector is required');
    }
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    return new Promise(function (resolve) {
      setTimeout(function () {
        var r = el.getBoundingClientRect();
        var x = r.left, y = r.top, complete = true;
        var win = window;
        try {
          var guard = 0;
          while (win !== win.top && guard++ < 20) {
            var fe = win.frameElement;
            if (!fe) { complete = false; break; }
            var fr = fe.getBoundingClientRect();
            x += fr.left + (fe.clientLeft || 0);
            y += fr.top + (fe.clientTop || 0);
            win = win.parent;
          }
          if (complete) { x += win.scrollX || 0; y += win.scrollY || 0; }
        } catch (e) { complete = false; }
        var d = describe(el);
        resolve({
          success: true, epoch: EPOCH,
          x: r.left, y: r.top, width: r.width, height: r.height,
          page_x: complete ? x : null, page_y: complete ? y : null, chain_complete: complete,
          dpr: window.devicePixelRatio || 1, target: { ref: ensureRef(el), role: d.role, name: d.name }
        });
      }, 80);
    });
  }

  function focusRef(msg) {
    var r0 = resolveRef(msg.ref, msg.expect_epoch);
    if (r0.error) return r0;
    var el = r0.el;
    try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
    try { if (typeof el.focus === 'function') el.focus({ preventScroll: true }); } catch (e) {}
    var d = describe(el);
    return { success: true, epoch: EPOCH, focused: deepActiveElement() === el, target: { ref: ensureRef(el), role: d.role, name: d.name } };
  }

  // ---------------------------------------------------------------------------
  // Scroll
  // ---------------------------------------------------------------------------
  function isScrollable(el) {
    if (!el || el.nodeType !== 1) return false;
    var s = styleOf(el);
    if (!s) return false;
    var oy = s.overflowY;
    return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 1;
  }
  function nearestScrollable(el) {
    var cur = el;
    var guard = 0;
    while (cur && guard++ < 60) {
      if (isScrollable(cur)) return cur;
      var p = cur.parentElement;
      if (!p) {
        var root = cur.getRootNode && cur.getRootNode();
        p = root && root.host ? root.host : null;
      }
      cur = p;
    }
    return null;
  }
  function doScroll(msg) {
    var el = null;
    if (msg.ref) {
      var r0 = resolveRef(msg.ref, msg.expect_epoch);
      if (r0.error) return r0;
      el = r0.el;
    } else if (msg.selector) {
      el = bestElement(msg.selector, 'any');
      if (!el) return err('NOT_FOUND', 'No element matches "' + msg.selector + '" in this frame.', { selector: msg.selector });
    }
    var dir = String(msg.direction || 'down');
    if (dir === 'into_view') {
      if (!el) return err('NOT_FOUND', 'direction "into_view" needs a ref or selector');
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
      var d0 = describe(el);
      return { success: true, epoch: EPOCH, scrolled: true, direction: dir, target: { ref: ensureRef(el), role: d0.role, name: d0.name }, in_viewport: inViewport(el) };
    }
    var scroller = el ? (isScrollable(el) ? el : nearestScrollable(el)) : null;
    if (!scroller) scroller = document.scrollingElement || document.documentElement || document.body;
    if (!scroller) return err('NOT_FOUND', 'No scrollable element found');
    var amt = Number(msg.amount);
    var step = amt > 0 ? amt : Math.floor(scroller.clientHeight * 0.85) || Math.floor(window.innerHeight * 0.85);
    var before = scroller.scrollTop;
    if (dir === 'top') scroller.scrollTop = 0;
    else if (dir === 'bottom') scroller.scrollTop = scroller.scrollHeight;
    else if (dir === 'up') scroller.scrollTop = Math.max(0, before - step);
    else scroller.scrollTop = before + step;
    var atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    var atTop = scroller.scrollTop <= 0;
    var out = {
      success: true, epoch: EPOCH, scrolled: scroller.scrollTop !== before, direction: dir,
      scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
      atBottom: atBottom, atTop: atTop,
      container: scroller === (document.scrollingElement || document.documentElement) ? 'page' : (roleOf(scroller) + (accessibleName(scroller) ? ' "' + accessibleName(scroller).slice(0, 40) + '"' : ''))
    };
    if (el) {
      var d = describe(el);
      out.target = { ref: ensureRef(el), role: d.role, name: d.name };
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Wait-for
  // ---------------------------------------------------------------------------
  function findForWait(msg) {
    if (msg.ref) {
      var r0 = resolveRef(msg.ref, msg.expect_epoch);
      return r0.el || null;
    }
    if (msg.selector) {
      var q = parseTextQuery(msg.selector);
      if (q != null) return bestElement(msg.selector, 'any');
      var all = deepQueryAll(msg.selector);
      for (var i = 0; i < all.length; i++) if (renderable(all[i])) return all[i];
      return all[0] || null;
    }
    if (msg.text) {
      var needle = norm(msg.text).toLowerCase();
      if (!needle) return null;
      var pool = deepQueryAll('a,button,input,textarea,select,label,summary,h1,h2,h3,h4,h5,h6,p,span,div,li,td,th,dt,dd,[role]');
      var best = null, bestArea = Infinity;
      for (var j = 0; j < pool.length; j++) {
        var el = pool[j];
        if (el.children && el.children.length > 12) continue;
        var t = norm(el.textContent || '').toLowerCase();
        var nm = accessibleName(el).toLowerCase();
        if (t.indexOf(needle) === -1 && nm.indexOf(needle) === -1) continue;
        if (!renderable(el)) continue;
        var a = area(el);
        if (a < bestArea) { best = el; bestArea = a; }
      }
      return best;
    }
    return null;
  }
  function waitFor(msg) {
    var state = String(msg.state || 'visible');
    var timeout = Math.max(0, Math.min(Number(msg.timeout) || 10000, 120000));
    return new Promise(function (resolve) {
      var start = Date.now();
      var done = false;
      var obs = null;
      function finish(res) {
        if (done) return;
        done = true;
        try { if (obs) obs.disconnect(); } catch (e) {}
        clearInterval(tick);
        clearTimeout(timer);
        resolve(res);
      }
      function check() {
        var el = null;
        try { el = findForWait(msg); } catch (e) { el = null; }
        var attached = !!(el && el.isConnected);
        var visible = attached && renderable(el);
        var ok = false;
        if (state === 'attached') ok = attached;
        else if (state === 'visible') ok = visible;
        else if (state === 'hidden') ok = !visible;
        else if (state === 'detached') ok = !attached;
        if (ok) {
          var matched = null;
          if (el && attached) {
            var d = describe(el);
            matched = { ref: ensureRef(el), role: d.role, name: d.name, in_viewport: inViewport(el) };
          }
          finish({ success: true, epoch: EPOCH, state: state, matched: matched, took_ms: Date.now() - start });
        }
      }
      try {
        obs = new MutationObserver(function () { check(); });
        obs.observe(document.documentElement || document, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch (e) {}
      var tick = setInterval(check, 250);
      var timer = setTimeout(function () {
        finish({ success: false, epoch: EPOCH, reason: 'timeout', state: state, took_ms: Date.now() - start });
      }, timeout);
      check();
    });
  }

  // ---------------------------------------------------------------------------
  // Snapshot
  // ---------------------------------------------------------------------------
  var STRUCT_ROLES = { navigation: 1, main: 1, banner: 1, contentinfo: 1, complementary: 1, form: 1, dialog: 1, alertdialog: 1, region: 1, article: 1, group: 1, list: 1, table: 1, menu: 1, tablist: 1, toolbar: 1, search: 1, listbox: 1, tree: 1, grid: 1, feed: 1 };
  var SKIP_TAGS = { script: 1, style: 1, noscript: 1, template: 1, meta: 1, link: 1, title: 1, head: 1, svg: 1, path: 1, canvas: 1 };

  function quote(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  function attrsFor(el, role) {
    var a = [];
    var tag = el.tagName.toLowerCase();
    try {
      if (tag === 'a') {
        var href = el.getAttribute('href');
        if (href && href !== '#' && !/^javascript:/i.test(href)) a.push('href=' + quote(href.length > 60 ? href.slice(0, 57) + '...' : href));
      }
      if (tag === 'input' || tag === 'textarea') {
        var t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'password') a.push('value="•••"');
        else if (t !== 'checkbox' && t !== 'radio' && t !== 'submit' && t !== 'button' && t !== 'file' && t !== 'hidden') {
          var val = norm(el.value);
          if (val) a.push('value=' + quote(val.length > 40 ? val.slice(0, 37) + '...' : val));
        }
        if (t === 'checkbox' || t === 'radio') a.push(el.checked ? 'checked' : 'unchecked');
        var ph = norm(el.getAttribute('placeholder'));
        if (ph && accessibleName(el) !== ph) a.push('placeholder=' + quote(ph.slice(0, 40)));
        if (el.required) a.push('required');
      } else if (el.isContentEditable && role === 'textbox') {
        var cv = norm(el.textContent);
        a.push('editable');
        if (cv) a.push('value=' + quote(cv.length > 40 ? cv.slice(0, 37) + '...' : cv));
      }
      if (tag === 'select') {
        a.push('options=' + (el.options ? el.options.length : 0));
      }
      if (isDisabled(el)) a.push('disabled');
      var exp = el.getAttribute('aria-expanded');
      if (exp === 'true' || exp === 'false') a.push('expanded=' + exp);
      var chk = el.getAttribute('aria-checked');
      if (chk === 'true' || chk === 'false' || chk === 'mixed') a.push('checked=' + chk);
      var sel = el.getAttribute('aria-selected');
      if (sel === 'true') a.push('selected');
      var prs = el.getAttribute('aria-pressed');
      if (prs === 'true' || prs === 'false') a.push('pressed=' + prs);
      if (role === 'heading') {
        var lvl = el.getAttribute('aria-level') || (/^h([1-6])$/i.exec(tag) || [])[1];
        if (lvl) a.push('level=' + lvl);
      }
      if (role === 'dialog' || role === 'alertdialog') {
        if (el.getAttribute('aria-modal') === 'true' || (tag === 'dialog' && el.hasAttribute('open'))) a.push('modal');
      }
      if (tag === 'iframe' || tag === 'frame') {
        var src = el.getAttribute('src') || '';
        if (src) a.push('src=' + quote(src.length > 60 ? src.slice(0, 57) + '...' : src));
      }
      if (el.id && el.id.length <= 24 && /^[A-Za-z][\w-]*$/.test(el.id)) a.push('id=' + el.id);
    } catch (e) {}
    return a;
  }

  function snapshot(msg) {
    var mode = msg.mode === 'full' ? 'full' : 'interactive';
    var includeText = !!msg.includeText;
    var maxLines = Math.max(50, Math.min(Number(msg.maxLines) || 1500, 5000));
    var MAX_NODES = 8000;
    var root = document.body || document.documentElement;
    if (msg.scopeRef) {
      var r0 = resolveRef(msg.scopeRef, msg.expect_epoch);
      if (r0.error) return r0;
      root = r0.el;
    } else if (msg.scopeSelector) {
      var scoped = bestElement(msg.scopeSelector, 'any');
      if (!scoped) return err('NOT_FOUND', 'No element matches scope "' + msg.scopeSelector + '" in this frame.', { selector: msg.scopeSelector });
      root = scoped;
    }
    var active = deepActiveElement();
    var lines = []; // {depth, text}
    var stats = { processed: 0, included: 0, truncated: false };
    var refsCount = 0;
    var start = Date.now();

    function hiddenSubtree(el) {
      var tag = el.tagName.toLowerCase();
      if (SKIP_TAGS[tag]) return true;
      if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return true;
      var s = styleOf(el);
      if (s && (s.display === 'none' || s.visibility === 'hidden')) return true;
      return false;
    }

    function walk(el, depth, out) {
      if (stats.processed >= MAX_NODES) { stats.truncated = true; return; }
      if (!el || el.nodeType !== 1) return;
      if (hiddenSubtree(el)) return;
      stats.processed++;
      var role = roleOf(el);
      var interactive = isInteractive(el);
      var isHeading = role === 'heading';
      var isDialog = role === 'dialog' || role === 'alertdialog';
      var isFrame = role === 'iframe';
      var structural = !!STRUCT_ROLES[role] || isDialog;
      var name = '';
      var childOut = [];
      var childDepth = depth + 1;
      // children: light DOM + open shadow root + (includeText) text leaves
      var kids = el.children || [];
      var i;
      if (includeText) {
        for (i = 0; i < el.childNodes.length; i++) {
          var n = el.childNodes[i];
          if (n.nodeType === 3) {
            var tx = norm(n.textContent);
            if (tx.length >= 2 && !interactive) childOut.push({ depth: childDepth, text: '- text ' + quote(tx.length > 120 ? tx.slice(0, 117) + '...' : tx) });
          }
        }
      }
      if (!isFrame) {
        for (i = 0; i < kids.length; i++) walk(kids[i], childDepth, childOut);
        try {
          if (el.shadowRoot && el.shadowRoot.children) {
            var sk = el.shadowRoot.children;
            for (i = 0; i < sk.length; i++) walk(sk[i], childDepth, childOut);
          }
        } catch (e) {}
      }
      var include = false;
      if (interactive || isHeading || isDialog || isFrame) include = true;
      else if (structural && (childOut.length > 0 || mode === 'full')) include = true;
      else if (mode === 'full') {
        name = accessibleName(el);
        include = !!name && el.children.length === 0;
      }
      if (include && !renderable(el) && !isFrame && !isDialog) {
        // zero-size interactive wrappers (e.g. hidden file inputs) are still
        // listed for filechooser/upload targeting, everything else needs a box
        include = role === 'filechooser';
      }
      if (include) {
        if (!name) name = accessibleName(el);
        var ref = ensureRef(el);
        refsCount++;
        var text = '- ' + role;
        if (name) text += ' ' + quote(name);
        text += ' [' + ref + ']';
        if (el === active) text += ' *focused*';
        var attrs = attrsFor(el, role);
        if (attrs.length) text += ' ' + attrs.join(' ');
        if (text.length > 220) text = text.slice(0, 217) + '...';
        out.push({ depth: depth, text: text });
        stats.included++;
        for (i = 0; i < childOut.length; i++) out.push(childOut[i]);
      } else {
        // excluded node: hoist its children one level up
        for (i = 0; i < childOut.length; i++) {
          childOut[i].depth = Math.max(depth, childOut[i].depth - 1);
          out.push(childOut[i]);
        }
      }
    }
    walk(root, 0, lines);
    var truncated = stats.truncated;
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      truncated = true;
    }
    var se = document.scrollingElement || document.documentElement;
    return {
      success: true, epoch: EPOCH, url: location.href, title: document.title || '',
      lines: lines.map(function (l) { return '  '.repeat(l.depth) + l.text; }),
      refs: refsCount, truncated: truncated, dialogs: dialogs(), focus: focusInfo(),
      viewport: { w: window.innerWidth, h: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY, scrollW: se ? se.scrollWidth : 0, scrollH: se ? se.scrollHeight : 0 },
      stats: { processed: stats.processed, included: stats.included, duration_ms: Date.now() - start }
    };
  }

  // ---------------------------------------------------------------------------
  // Message bridge
  // ---------------------------------------------------------------------------
  function reply(sendResponse, value) {
    Promise.resolve(value).then(
      function (v) { sendResponse(v); },
      function (e) { sendResponse(err('EXECUTION_ERROR', (e && e.message) || String(e))); },
    );
  }

  chrome.runtime.onMessage.addListener(function (request, _sender, sendResponse) {
    if (!request || typeof request.action !== 'string') return false;
    var a = request.action;
    try {
      if (a === 'k_dom_core_ping' || /^kareenos_[a-z_]+_ping$/.test(a)) {
        sendResponse({ status: 'pong', epoch: EPOCH, version: K.version });
        return false;
      }
      switch (a) {
        case 'kFindCandidates':
          reply(sendResponse, (function () {
            if (!request.selector) return err('NOT_FOUND', 'selector is required');
            var r = findCandidates(request.selector, request.kind, request.limit);
            r.success = true;
            r.epoch = EPOCH;
            return r;
          })());
          return true;
        case 'kResolveRef':
          reply(sendResponse, (function () {
            var r = resolveRef(request.ref, request.expect_epoch);
            if (r.error) return r;
            var d = describe(r.el);
            return { success: true, epoch: EPOCH, ref: request.ref, role: d.role, name: d.name, tag: d.tag, editable: d.editable, disabled: d.disabled, renderable: renderable(r.el), in_viewport: inViewport(r.el) };
          })());
          return true;
        case 'kFocusProbe':
          reply(sendResponse, focusProbe());
          return true;
        case 'kStateProbe':
          reply(sendResponse, stateProbe());
          return true;
        case 'kQuietWait':
          reply(sendResponse, quietWait(request.quiet_ms, request.cap_ms));
          return true;
        case 'kListIframes':
          reply(sendResponse, { success: true, epoch: EPOCH, iframes: listIframes() });
          return true;
        case 'kElementRect':
          reply(sendResponse, elementRect(request));
          return true;
        case 'kFocus':
          reply(sendResponse, focusRef(request));
          return true;
        case 'kScroll':
          reply(sendResponse, doScroll(request));
          return true;
        case 'kWaitFor':
          reply(sendResponse, waitFor(request));
          return true;
        case 'kSnapshot':
          reply(sendResponse, snapshot(request));
          return true;
        default:
          return false;
      }
    } catch (e) {
      sendResponse(err('EXECUTION_ERROR', (e && e.message) || String(e)));
      return false;
    }
  });
})();
