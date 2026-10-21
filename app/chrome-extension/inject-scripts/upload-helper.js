/* eslint-disable */
// upload-helper.js (v2, 2026-10-19)
// Injected into the page to put a FILE into it: assign to an input[type=file]
// via DataTransfer (primary), or simulate a drag-and-drop onto a drop zone
// (fallback). This helper never fetches anything; the OS file picker is
// unscriptable by design, and the whole point of this helper is that it is
// never opened.
//
// The bytes arrive from the background over a small session protocol (action
// 'uploadFileV2'), so a file of any size crosses extension messaging in pieces:
//   probe  {selector|ref, fileName, mimeType, sizeBytes}
//          → resolves the upload control NOW (nothing is set) and opens a
//            session: {success, session_id, method}
//   chunk  {session_id, index, base64}
//          → one piece, decoded and kept as a Blob: {success, received}
//   commit {session_id}
//          → File from the pieces, control resolved again, set or dropped:
//            {success, method, fileName, sizeBytes, ...}
//   abort  {session_id}
// The legacy single-shot message ('uploadFile' with base64Data) is still
// answered when no older copy of this helper is in the page.
//
// Coexistence: a page open across an extension update may still carry the
// pre-v2 helper (guard __UPLOAD_HELPER_INITIALIZED__, listener on 'uploadFile'
// and the old ping). This file uses its own guard, answers its own ping and
// action name, and leaves 'uploadFile' + the old ping to the old copy when one
// is present, so no message is ever answered twice.

if (window.__UPLOAD_HELPER_V2__) {
  // Already initialized, skip
} else {
  window.__UPLOAD_HELPER_V2__ = true;
  const __upLegacyPresent = !!window.__UPLOAD_HELPER_INITIALIZED__;
  window.__UPLOAD_HELPER_INITIALIZED__ = true;

  // Same selector conventions as click-helper (text= / :has-text() / CSS), kept
  // self-contained so upload works even when click-helper was never injected.
  function __upStripQuotes(s) {
    s = String(s).trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  }
  function __upParseTextQuery(sel) {
    if (typeof sel !== 'string') return null;
    let m = sel.match(/^\s*text\s*=\s*(.+)$/i);
    if (m) return __upStripQuotes(m[1]);
    m = sel.match(/:(?:has-text|contains)\(\s*(.+?)\s*\)\s*$/i);
    if (m) return __upStripQuotes(m[1]);
    return null;
  }
  function __upRenderable(el) {
    if (!el || !el.getBoundingClientRect) return false;
    let style;
    try {
      style = window.getComputedStyle(el);
    } catch (e) {
      return false;
    }
    if (
      !style ||
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0'
    )
      return false;
    if (el.getAttribute && (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')))
      return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function __upName(el) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    return (aria && aria.trim()) || (el.textContent || '').trim();
  }
  // Candidates for a text query: things a human would read as the upload control —
  // buttons/links like click-helper, PLUS labels (the styled-button-over-hidden-
  // input pattern) and elements that smell like a drop zone (by class OR id).
  function __upFindByText(query) {
    const q = String(query).trim().toLowerCase();
    if (!q) return [];
    const sel =
      'a,button,label,[role="button"],[role="link"],[onclick],[tabindex],' +
      '[class*="upload" i],[class*="drop" i],[class*="attach" i],' +
      '[id*="upload" i],[id*="drop" i],[id*="attach" i],[data-testid*="upload" i]';
    const all = Array.from(document.querySelectorAll(sel));
    const exact = all.filter((el) => __upName(el).toLowerCase() === q);
    const contains = all.filter(
      (el) => __upName(el).toLowerCase() !== q && __upName(el).toLowerCase().includes(q),
    );
    const rank = (els) =>
      els.filter(__upRenderable).sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      });
    let list = rank(exact).concat(rank(contains));
    if (!list.length) {
      // Generic fallback (mirrors click-helper): a drop zone is often a bare
      // <div> with no upload-ish class/id at all — its visible TEXT is the only
      // handle the agent has (browser_read returns text, not ids). Scan every
      // element whose OWN text matches and keep the smallest renderable ones
      // (innermost match, not a page-wide wrapper).
      const textEls = Array.from(document.querySelectorAll('div,span,section,p,td,li')).filter(
        (el) => {
          const t = (el.textContent || '').trim().toLowerCase();
          return t === q || (t.length <= q.length + 80 && t.includes(q));
        },
      );
      list = rank(textEls);
    }
    return list;
  }
  function __upResolveCandidates(sel) {
    const tq = __upParseTextQuery(sel);
    if (tq != null) return __upFindByText(tq);
    // Deep query so a selector like input[type=file] also matches inside shadow
    // roots; falls back to the plain query for selectors it can't handle.
    try {
      return __upDeepQueryAll(sel);
    } catch (e) {
      try {
        return Array.from(document.querySelectorAll(sel));
      } catch (e2) {
        return [];
      }
    }
  }

  function __upIsFileInput(el) {
    return el && el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'file';
  }

  // querySelectorAll that also descends into OPEN shadow roots. Component-based
  // sites (and anything using web components) hide their real file input inside
  // a shadow tree, where document.querySelectorAll cannot see it at all — the
  // plain query then reports "no file input" on a page that clearly has one.
  function __upDeepQueryAll(selector, root, out, depth) {
    out = out || [];
    root = root || document;
    depth = depth || 0;
    if (depth > 12) return out;
    try {
      var direct = root.querySelectorAll(selector);
      for (var i = 0; i < direct.length; i++) {
        if (out.indexOf(direct[i]) === -1) out.push(direct[i]);
      }
    } catch (e) {
      /* invalid selector for this root */
    }
    var all;
    try {
      all = root.querySelectorAll('*');
    } catch (e) {
      return out;
    }
    for (var j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) __upDeepQueryAll(selector, all[j].shadowRoot, out, depth + 1);
    }
    return out;
  }

  // Every file input on the page, shadow trees included.
  function __upAllFileInputs() {
    return __upDeepQueryAll('input[type="file"]');
  }

  // Given a candidate element, locate the actual input[type=file] it stands for.
  // Hidden inputs count: assigning .files works on display:none inputs, which is
  // the common real-world pattern (styled button + invisible input).
  function __upFindFileInput(candidate) {
    if (!candidate) return null;
    if (__upIsFileInput(candidate)) return candidate;
    let input = candidate.querySelector && candidate.querySelector('input[type="file"]');
    if (input) return input;
    // <label for=X>
    if (candidate.tagName === 'LABEL') {
      const forId = candidate.getAttribute('for');
      if (forId) {
        const el = document.getElementById(forId);
        if (__upIsFileInput(el)) return el;
      }
      if (candidate.control && __upIsFileInput(candidate.control)) return candidate.control;
    }
    // Inside a label wrapping the input
    const label = candidate.closest && candidate.closest('label');
    if (label) {
      if (label.control && __upIsFileInput(label.control)) return label.control;
      input = label.querySelector('input[type="file"]');
      if (input) return input;
    }
    // Nearest upload-ish container
    const container =
      candidate.closest &&
      candidate.closest(
        'form,[class*="upload" i],[class*="drop" i],[class*="attach" i],[data-testid*="upload" i]',
      );
    if (container) {
      input = container.querySelector('input[type="file"]');
      if (input) return input;
    }
    return null;
  }

  function __upDecodeBytes(base64Data) {
    const bin = atob(base64Data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function __upDecode(base64Data, fileName, mimeType) {
    return new File([__upDecodeBytes(base64Data)], fileName, { type: mimeType });
  }

  // ── upload sessions (the v2 piece protocol) ────────────────────────────
  // Each piece becomes its own Blob at once: Chrome's blob storage pages large
  // blobs to disk, so the page never holds the whole file as a typed array.
  const __upSessions = {};
  const __UP_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
  let __upSessionSeq = 0;

  function __upDropSession(id) {
    const s = __upSessions[id];
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    s.parts = [];
    delete __upSessions[id];
  }

  function __upOpenSession(spec) {
    const id = 'u' + Date.now().toString(36) + '_' + ++__upSessionSeq;
    const s = Object.assign({ id, parts: [], bytes: 0, nextIndex: 0, timer: null }, spec);
    s.timer = setTimeout(() => __upDropSession(id), __UP_SESSION_TTL_MS);
    __upSessions[id] = s;
    return s;
  }

  function __upElementInfo(el) {
    if (!el) return null;
    return {
      tagName: el.tagName,
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className.substring(0, 200) : null,
      name: el.getAttribute ? el.getAttribute('name') : null,
    };
  }

  function __upAssignToInput(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }

  function __upSimulateDrop(target, file) {
    try {
      target.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
    } catch (e) {}
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      const ev = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
        clientX: x,
        clientY: y,
      });
      target.dispatchEvent(ev);
    }
  }

  // Where the file goes: the real file input behind the selector / ref, else
  // the page's single file input, else the first that accepts the mime, else a
  // drop target. Shared by the legacy single-shot path, the probe and the
  // commit, so what the probe found is what the commit sets.
  function __upResolveTarget(selector, ref, expectEpoch, name, mime) {
    // A ref (from browser_snapshot) names ONE element in this frame — it may
    // be the file input itself, the button that owns it, or a drop zone.
    let candidates;
    if (ref && typeof window.__kResolveRef === 'function') {
      const res = window.__kResolveRef(ref, expectEpoch);
      if (res && res.error) return { error: res.error };
      candidates = [res.el];
    } else {
      candidates = __upResolveCandidates(selector);
    }

    // 1) PRIMARY — find the real file input behind the selector.
    let input = null;
    for (const candidate of candidates) {
      input = __upFindFileInput(candidate);
      if (input) break;
    }
    // Fallbacks that ignore the selector entirely, in order of confidence:
    // the page's single file input, else the first one that accepts our mime
    // (a composer often has several: image, video, document).
    if (!input) {
      const allInputs = __upAllFileInputs();
      if (allInputs.length === 1) {
        input = allInputs[0];
      } else if (allInputs.length > 1) {
        const kind = String(mime).split('/')[0];
        input =
          allInputs.find((el) => {
            const acc = (el.getAttribute('accept') || '').toLowerCase();
            return acc.includes(mime) || acc.includes(kind + '/');
          }) || allInputs[0];
      }
    }
    if (input) {
      let warning = null;
      const accept = (input.getAttribute('accept') || '').trim();
      if (accept && mime) {
        const ok = accept.split(',').some((a) => {
          a = a.trim().toLowerCase();
          if (!a) return false;
          if (a.startsWith('.')) return name.toLowerCase().endsWith(a);
          if (a.endsWith('/*')) return mime.toLowerCase().startsWith(a.slice(0, -1));
          return mime.toLowerCase() === a;
        });
        if (!ok) warning = `input accepts "${accept}" but file is ${mime}; proceeding anyway`;
      }
      return { input, warning };
    }

    // 2) FALLBACK — a drop on the first renderable candidate.
    const dropTarget = candidates.filter(__upRenderable)[0] || candidates[0];
    if (dropTarget) return { dropTarget };

    // Report what the PAGE actually contains, so the caller can tell
    // "wrong selector" apart from "the input does not exist yet".
    const total = __upAllFileInputs().length;
    const message =
      total === 0
        ? `This page currently has NO file input anywhere (shadow DOM included), so there is nothing to upload into yet. ` +
          `Most sites create it only when you open their media/attachment step: click the composer's photo / attach / "Add media" button ONCE (a synthetic click cannot open the OS file dialog, so this is safe and just reveals the picker), then take a browser_snapshot and upload into the filechooser ref, or call browser_upload again with selector "input[type=file]". ` +
          `If the upload area is a drop zone with no input, target its visible text instead (text=Drag and drop).`
        : `${ref ? 'Ref ' + ref : 'Selector "' + selector + '"'} matched no upload control, but this page has ${total} file input(s). ` +
          `Retry with selector "input[type=file]", or take a browser_snapshot and use the filechooser ref.`;
    return {
      error: {
        code: 'NOT_FOUND',
        message,
        details: { selector: selector || null, ref: ref || null, file_inputs: total },
      },
    };
  }

  // Set the resolved File on the resolved target; the result both paths return.
  function __upDeliver(target, file, name) {
    if (target.input) {
      __upAssignToInput(target.input, file);
      return {
        success: true,
        message:
          `File "${name}" (${file.size} bytes) set on file input; input+change dispatched` +
          (target.warning ? ` — WARNING: ${target.warning}` : ''),
        method: 'input',
        fileName: name,
        sizeBytes: file.size,
        targetTagName: 'INPUT',
        elementInfo: __upElementInfo(target.input),
      };
    }
    const dropTarget = target.dropTarget;
    __upSimulateDrop(dropTarget, file);
    return {
      success: true,
      message:
        `File "${name}" (${file.size} bytes) dropped on <${dropTarget.tagName.toLowerCase()}> ` +
        '(no file input found — simulated drag-and-drop; if the page did not react, target its file input directly)',
      method: 'drop',
      fileName: name,
      sizeBytes: file.size,
      targetTagName: dropTarget.tagName,
      elementInfo: __upElementInfo(dropTarget),
    };
  }

  // Legacy single-shot: the whole file in one message.
  async function uploadFile(selector, base64Data, fileName, mimeType, ref, expectEpoch) {
    try {
      if (!selector && !ref)
        return { error: { code: 'NOT_FOUND', message: 'ref or selector is required' } };
      if (!base64Data) return { error: 'base64Data is required' };
      const name = fileName || 'uploaded-file';
      const mime = mimeType || 'application/octet-stream';

      let file;
      try {
        file = __upDecode(base64Data, name, mime);
      } catch (e) {
        return {
          error: { code: 'EXECUTION_ERROR', message: `Could not decode file data: ${e.message}` },
        };
      }
      const target = __upResolveTarget(selector, ref, expectEpoch, name, mime);
      if (target.error) return { error: target.error };
      return __upDeliver(target, file, name);
    } catch (error) {
      return {
        error: { code: 'EXECUTION_ERROR', message: `Error uploading file: ${error.message}` },
      };
    }
  }

  // The v2 piece protocol (see the header).
  async function uploadFileV2(request) {
    try {
      const mode = request.mode || 'probe';
      if (mode === 'probe') {
        if (!request.selector && !request.ref)
          return { error: { code: 'NOT_FOUND', message: 'ref or selector is required' } };
        const name = request.fileName || 'uploaded-file';
        const mime = request.mimeType || 'application/octet-stream';
        const target = __upResolveTarget(
          request.selector,
          request.ref,
          request.expect_epoch,
          name,
          mime,
        );
        if (target.error) return { error: target.error };
        const s = __upOpenSession({
          selector: request.selector || null,
          ref: request.ref || null,
          expectEpoch: request.expect_epoch,
          name,
          mime,
          expected: Number(request.sizeBytes) || 0,
        });
        return {
          success: true,
          session_id: s.id,
          method: target.input ? 'input' : 'drop',
          targetTagName: target.input ? 'INPUT' : target.dropTarget.tagName,
          elementInfo: __upElementInfo(target.input || target.dropTarget),
          file_inputs: __upAllFileInputs().length,
        };
      }
      const s = __upSessions[request.session_id];
      if (!s)
        return {
          error: {
            code: 'EXECUTION_ERROR',
            message:
              'unknown upload session ' +
              request.session_id +
              ' (the page may have reloaded) — start the upload again',
          },
        };
      if (mode === 'abort') {
        __upDropSession(s.id);
        return { success: true };
      }
      if (mode === 'chunk') {
        const index = Number(request.index);
        if (index !== s.nextIndex) {
          return {
            error: {
              code: 'EXECUTION_ERROR',
              message: `upload piece ${index} arrived out of order (expected ${s.nextIndex})`,
            },
          };
        }
        let bytes;
        try {
          bytes = __upDecodeBytes(String(request.base64 || ''));
        } catch (e) {
          return {
            error: {
              code: 'EXECUTION_ERROR',
              message: `Could not decode upload piece ${index}: ${e.message}`,
            },
          };
        }
        s.parts.push(new Blob([bytes]));
        s.bytes += bytes.length;
        s.nextIndex++;
        return { success: true, received: s.bytes, index };
      }
      if (mode === 'commit') {
        if (!s.bytes) {
          __upDropSession(s.id);
          return {
            error: { code: 'EXECUTION_ERROR', message: 'no bytes were received for this upload' },
          };
        }
        if (s.expected && s.bytes !== s.expected) {
          __upDropSession(s.id);
          return {
            error: {
              code: 'EXECUTION_ERROR',
              message: `received ${s.bytes} bytes but the file is ${s.expected} bytes`,
            },
          };
        }
        const file = new File(s.parts, s.name, { type: s.mime });
        // The control is resolved again: the download may have taken minutes
        // and the site may have re-rendered. A ref that went stale in the
        // meantime falls back to the page's file inputs (by mime).
        let target = __upResolveTarget(s.selector, s.ref, s.expectEpoch, s.name, s.mime);
        if (target.error && s.ref)
          target = __upResolveTarget(s.selector, null, undefined, s.name, s.mime);
        if (target.error) {
          __upDropSession(s.id);
          return { error: target.error };
        }
        const out = __upDeliver(target, file, s.name);
        __upDropSession(s.id);
        return out;
      }
      return { error: { code: 'EXECUTION_ERROR', message: 'unknown upload mode ' + mode } };
    } catch (error) {
      return {
        error: { code: 'EXECUTION_ERROR', message: `Error uploading file: ${error.message}` },
      };
    }
  }

  // Listen for messages from the extension
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'uploadFileV2') {
      uploadFileV2(request)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({ error: `Unexpected error: ${error.message}` });
        });
      return true; // async response
    } else if (request.action === 'chrome_upload_file_ping2') {
      sendResponse({ status: 'pong', version: 2 });
      return false;
    } else if (request.action === 'uploadFile' && !__upLegacyPresent) {
      uploadFile(
        request.selector,
        request.base64Data,
        request.fileName,
        request.mimeType,
        request.ref,
        request.expect_epoch,
      )
        .then(sendResponse)
        .catch((error) => {
          sendResponse({ error: `Unexpected error: ${error.message}` });
        });
      return true; // async response
    } else if (request.action === 'chrome_upload_file_ping' && !__upLegacyPresent) {
      sendResponse({ status: 'pong' });
      return false;
    }
  });
}
