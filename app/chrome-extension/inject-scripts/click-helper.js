/* eslint-disable */
// click-helper.js
// This script is injected into the page to handle click operations

if (window.__CLICK_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__CLICK_HELPER_INITIALIZED__ = true;

  // --- Kareenos: text-based element targeting ---------------------------------
  // LinkedIn (and most modern apps) ship hashed/dynamic class names, so the agent
  // cannot know a stable CSS selector. Let it target by VISIBLE TEXT / aria-label,
  // which is what a human reads. Supported selector forms (resolved here, before
  // querySelector): text=Message | text="Message" | :has-text("Message") |
  // :contains("Message"). Anything else is treated as a normal CSS selector.
  function __kStripQuotes(s) {
    s = String(s).trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  }
  function __kParseTextQuery(sel) {
    if (typeof sel !== 'string') return null;
    let m = sel.match(/^\s*text\s*=\s*(.+)$/i);
    if (m) return __kStripQuotes(m[1]);
    m = sel.match(/:(?:has-text|contains)\(\s*(.+?)\s*\)\s*$/i);
    if (m) return __kStripQuotes(m[1]);
    return null;
  }
  // Renderable = will actually be clickable once scrolled into view. Stricter than
  // a size check (the previous bug): a hidden duplicate "Message" in a collapsed
  // menu passed the old test, got picked, then the click step rejected it as "not
  // visible" — wasting many turns. We do NOT require in-viewport here because the
  // click step scrolls the element into view first.
  function __kRenderable(el) {
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
  function __kInViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
  }
  function __kName(el) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    return (aria && aria.trim()) || (el.textContent || '').trim();
  }
  // From candidates, return the BEST clickable one: prefer those already in the
  // viewport, then the smallest (most specific) — so we click the button, not a
  // wrapper, and never a hidden duplicate.
  function __kPickBest(els) {
    const vis = els.filter(__kRenderable);
    if (!vis.length) return null;
    vis.sort((a, b) => {
      const av = __kInViewport(a) ? 0 : 1;
      const bv = __kInViewport(b) ? 0 : 1;
      if (av !== bv) return av - bv;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
    return vis[0];
  }
  function __kFindByText(query) {
    const q = String(query).trim().toLowerCase();
    if (!q) return null;
    const interactive =
      'a,button,[role="button"],[role="link"],[role="menuitem"],[role="tab"],' +
      'input[type="submit"],input[type="button"],[onclick],[tabindex]';
    const candidates = Array.from(document.querySelectorAll(interactive));
    const exact = __kPickBest(candidates.filter((el) => __kName(el).toLowerCase() === q));
    if (exact) return exact;
    const contains = __kPickBest(candidates.filter((el) => __kName(el).toLowerCase().includes(q)));
    if (contains) return contains;
    // Fallback: any element whose own text matches → climb to a clickable ancestor.
    const all = Array.from(document.querySelectorAll('*')).filter(
      (el) => (el.textContent || '').trim().toLowerCase() === q,
    );
    const ancestors = [];
    for (const el of all) {
      const c = el.closest('a,button,[role="button"],[role="link"],[onclick]');
      if (c) ancestors.push(c);
    }
    return __kPickBest(ancestors);
  }
  // Ranked candidate LIST for a selector. The click step tries them in order and
  // clicks the first that is genuinely clickable — so a single bad/hidden match
  // (e.g. a "Message" duplicate) no longer dead-ends the action. For a text query
  // we rank by match quality + visibility; for a CSS selector we return ALL
  // matches (querySelectorAll) so an ambiguous selector also gets iterated.
  function __kFindCandidates(query) {
    const q = String(query).trim().toLowerCase();
    if (!q) return [];
    const interactive =
      'a,button,[role="button"],[role="link"],[role="menuitem"],[role="tab"],' +
      'input[type="submit"],input[type="button"],[onclick],[tabindex]';
    const all = Array.from(document.querySelectorAll(interactive));
    const exact = all.filter((el) => __kName(el).toLowerCase() === q);
    const contains = all.filter(
      (el) => __kName(el).toLowerCase() !== q && __kName(el).toLowerCase().includes(q),
    );
    const rank = (els) =>
      els.filter(__kRenderable).sort((a, b) => {
        const av = __kInViewport(a) ? 0 : 1;
        const bv = __kInViewport(b) ? 0 : 1;
        if (av !== bv) return av - bv;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      });
    let list = rank(exact).concat(rank(contains));
    if (!list.length) {
      // Fallback: any element whose own text matches → nearest clickable ancestor.
      const textEls = Array.from(document.querySelectorAll('*')).filter(
        (el) => (el.textContent || '').trim().toLowerCase() === q,
      );
      const anc = [];
      for (const el of textEls) {
        const c = el.closest('a,button,[role="button"],[role="link"],[onclick]');
        if (c && anc.indexOf(c) === -1) anc.push(c);
      }
      list = rank(anc);
    }
    return list;
  }
  function __kResolveCandidates(sel) {
    const tq = __kParseTextQuery(sel);
    if (tq != null) return __kFindCandidates(tq);
    try {
      return Array.from(document.querySelectorAll(sel));
    } catch (e) {
      return [];
    }
  }
  window.__kResolveCandidates = __kResolveCandidates;
  // Single-element resolve (used by fill-helper). First clickable candidate.
  function __kResolveElement(sel) {
    const list = __kResolveCandidates(sel);
    if (!list.length) return null;
    const vis = list.filter(__kRenderable);
    return (vis.length ? vis : list)[0];
  }
  window.__kResolveElement = __kResolveElement;
  // ---------------------------------------------------------------------------

  /**
   * Click on an element matching the selector or at specific coordinates
   * @param {string} selector - CSS selector for the element to click
   * @param {boolean} waitForNavigation - Whether to wait for navigation to complete after click
   * @param {number} timeout - Timeout in milliseconds for waiting for the element or navigation
   * @param {Object} coordinates - Optional coordinates for clicking at a specific position
   * @param {number} coordinates.x - X coordinate relative to the viewport
   * @param {number} coordinates.y - Y coordinate relative to the viewport
   * @returns {Promise<Object>} - Result of the click operation
   */
  async function clickElement(
    selector,
    waitForNavigation = false,
    timeout = 5000,
    coordinates = null,
    ref = null,
    double = false,
    options = {},
  ) {
    try {
      let element = null;
      let elementInfo = null;
      let clickX, clickY;

      if (ref && typeof ref === 'string') {
        // Resolve element from weak map
        let target = null;
        try {
          const map = window.__claudeElementMap;
          const weak = map && map[ref];
          target = weak && typeof weak.deref === 'function' ? weak.deref() : null;
        } catch (e) {
          // ignore
        }

        if (!target || !(target instanceof Element)) {
          return {
            error: `Element ref "${ref}" not found. Please call chrome_read_page first and ensure the ref is still valid.`,
          };
        }

        element = target;
        element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
        await new Promise((resolve) => setTimeout(resolve, 80));

        const rect = element.getBoundingClientRect();
        clickX = rect.left + rect.width / 2;
        clickY = rect.top + rect.height / 2;
        elementInfo = {
          tagName: element.tagName,
          id: element.id,
          className: element.className,
          text: element.textContent?.trim().substring(0, 100) || '',
          href: element.href || null,
          type: element.type || null,
          isVisible: true,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            left: rect.left,
          },
          clickMethod: 'ref',
          ref,
        };
      } else if (
        coordinates &&
        typeof coordinates.x === 'number' &&
        typeof coordinates.y === 'number'
      ) {
        clickX = coordinates.x;
        clickY = coordinates.y;

        element = document.elementFromPoint(clickX, clickY);

        if (element) {
          const rect = element.getBoundingClientRect();
          elementInfo = {
            tagName: element.tagName,
            id: element.id,
            className: element.className,
            text: element.textContent?.trim().substring(0, 100) || '',
            href: element.href || null,
            type: element.type || null,
            isVisible: true,
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              left: rect.left,
            },
            clickMethod: 'coordinates',
            clickPosition: { x: clickX, y: clickY },
          };
        } else {
          elementInfo = {
            clickMethod: 'coordinates',
            clickPosition: { x: clickX, y: clickY },
            warning: 'No element found at the specified coordinates',
          };
        }
      } else {
        // Try every matching candidate (text= ranked list, or all CSS matches)
        // and click the FIRST that is actually clickable after scrolling it into
        // view. One hidden/covered match no longer fails the whole action.
        const candidates = __kResolveCandidates(selector);
        if (!candidates.length) {
          return {
            error: `Element with selector "${selector}" not found`,
          };
        }

        for (const candidate of candidates) {
          candidate.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!isElementVisible(candidate)) continue; // try the next match

          element = candidate;
          const rect = element.getBoundingClientRect();
          elementInfo = {
            tagName: element.tagName,
            id: element.id,
            className: element.className,
            text: element.textContent?.trim().substring(0, 100) || '',
            href: element.href || null,
            type: element.type || null,
            isVisible: true,
            rect: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              left: rect.left,
            },
            clickMethod: 'selector',
          };
          clickX = rect.left + rect.width / 2;
          clickY = rect.top + rect.height / 2;
          break;
        }

        if (!element) {
          return {
            error: `Element with selector "${selector}" is not visible`,
          };
        }
      }

      let navigationPromise;
      if (waitForNavigation) {
        navigationPromise = new Promise((resolve) => {
          const beforeUnloadListener = () => {
            window.removeEventListener('beforeunload', beforeUnloadListener);
            resolve(true);
          };
          window.addEventListener('beforeunload', beforeUnloadListener);

          setTimeout(() => {
            window.removeEventListener('beforeunload', beforeUnloadListener);
            resolve(false);
          }, timeout);
        });
      }

      if (
        element &&
        (elementInfo.clickMethod === 'selector' || elementInfo.clickMethod === 'ref')
      ) {
        if (double) {
          dispatchClickSequence(element, clickX, clickY, options, true);
        } else {
          dispatchClickSequence(element, clickX, clickY, options, false);
        }
      } else {
        if (double) simulateDoubleClick(clickX, clickY, options);
        else simulateClick(clickX, clickY, options);
      }

      // Wait for navigation if needed
      let navigationOccurred = false;
      if (waitForNavigation) {
        navigationOccurred = await navigationPromise;
      }

      return {
        success: true,
        message: 'Element clicked successfully',
        elementInfo,
        navigationOccurred,
      };
    } catch (error) {
      return {
        error: `Error clicking element: ${error.message}`,
      };
    }
  }

  /**
   * Simulate a mouse click at specific coordinates
   * @param {number} x - X coordinate relative to the viewport
   * @param {number} y - Y coordinate relative to the viewport
   */
  function simulateClick(x, y, options = {}) {
    const element = document.elementFromPoint(x, y);
    if (!element) return;
    dispatchClickSequence(element, x, y, options, false);
  }

  /**
   * Simulate a double click sequence at specific coordinates
   */
  function simulateDoubleClick(x, y, options = {}) {
    const element = document.elementFromPoint(x, y);
    if (!element) return;
    dispatchClickSequence(element, x, y, options, true);
  }

  /**
   * Simulate double click using element when available
   */
  function simulateDomDoubleClick(element, x, y, options) {
    dispatchClickSequence(element, x, y, options, true);
  }

  function normalizeMouseOpts(x, y, options = {}) {
    const bubbles = options.bubbles !== false; // default true
    const cancelable = options.cancelable !== false; // default true
    const altKey = !!(options.modifiers && options.modifiers.altKey);
    const ctrlKey = !!(options.modifiers && options.modifiers.ctrlKey);
    const metaKey = !!(options.modifiers && options.modifiers.metaKey);
    const shiftKey = !!(options.modifiers && options.modifiers.shiftKey);
    const btn = String(options.button || 'left');
    const button = btn === 'right' ? 2 : btn === 'middle' ? 1 : 0;
    const buttons = btn === 'right' ? 2 : btn === 'middle' ? 4 : 1;
    return {
      bubbles,
      cancelable,
      altKey,
      ctrlKey,
      metaKey,
      shiftKey,
      button,
      buttons,
      clientX: x,
      clientY: y,
      view: window,
    };
  }

  function dispatchClickSequence(element, x, y, options = {}, isDouble = false) {
    const base = normalizeMouseOpts(x, y, options);
    const down = new MouseEvent('mousedown', base);
    const up = new MouseEvent('mouseup', base);
    const click = new MouseEvent('click', base);
    try {
      element.dispatchEvent(down);
    } catch {}
    try {
      element.dispatchEvent(up);
    } catch {}
    try {
      element.dispatchEvent(click);
    } catch {}
    if (base.button === 2) {
      // right button contextmenu
      const ctx = new MouseEvent('contextmenu', base);
      try {
        element.dispatchEvent(ctx);
      } catch {}
    }
    if (isDouble) {
      // second sequence + dblclick
      setTimeout(() => {
        try {
          element.dispatchEvent(new MouseEvent('mousedown', base));
        } catch {}
        try {
          element.dispatchEvent(new MouseEvent('mouseup', base));
        } catch {}
        try {
          element.dispatchEvent(new MouseEvent('click', base));
        } catch {}
        try {
          element.dispatchEvent(new MouseEvent('dblclick', base));
        } catch {}
      }, 30);
    }
  }

  /**
   * Check if an element is visible
   * @param {Element} element - The element to check
   * @returns {boolean} - Whether the element is visible
   */
  function isElementVisible(element) {
    if (!element) return false;

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }

    if (
      rect.bottom < 0 ||
      rect.top > window.innerHeight ||
      rect.right < 0 ||
      rect.left > window.innerWidth
    ) {
      return false;
    }

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const elementAtPoint = document.elementFromPoint(centerX, centerY);
    if (!elementAtPoint) return false;

    return element === elementAtPoint || element.contains(elementAtPoint);
  }

  // Listen for messages from the extension
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'clickElement') {
      clickElement(
        request.selector,
        request.waitForNavigation,
        request.timeout,
        request.coordinates,
        request.ref,
        !!request.double,
        {
          button: request.button,
          bubbles: request.bubbles,
          cancelable: request.cancelable,
          modifiers: request.modifiers,
        },
      )
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            error: `Unexpected error: ${error.message}`,
          });
        });
      return true; // Indicates async response
    } else if (request.action === 'chrome_click_element_ping') {
      sendResponse({ status: 'pong' });
      return false;
    }
  });
}
