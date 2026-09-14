// Kareenos Browser Channel v2 — background ⇄ k-dom-core bridge.
//
//   * listFrames(tabId): every frame of the tab (chrome.webNavigation), top first,
//     with parentFrameId + url, so tools can report and address frames.
//   * ensureCore(tabId, frameId): make sure inject-scripts/k-dom-core.js answers
//     in that frame (its OWN ping — the tool-name ping in injectContentScript
//     would be answered by whichever helper happens to be loaded).
//   * sendCore(tabId, frameId, message): message a frame; a structured helper
//     error becomes a thrown BrowserActionError.
//   * RefBook: per-lane record of each frame's document EPOCH, kept in
//     chrome.storage.session (survives MV3 worker eviction; a module-level map
//     would make every eviction look like a navigation → spurious STALE_REF).
import { BrowserActionError, errorFromResponse, toBrowserError } from '@/common/browser-errors';
import { K_DOM_CORE_PING, K_DOM_CORE_SCRIPT } from '@/common/kareenos-tool-names';

export interface FrameInfo {
  frameId: number;
  parentFrameId: number;
  url: string;
}

const PING_TIMEOUT_MS = 300;

export async function listFrames(tabId: number): Promise<FrameInfo[]> {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (frames && frames.length) {
      return frames
        .map((f) => ({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url || '' }))
        .sort((a, b) => a.frameId - b.frameId);
    }
  } catch (e) {
    /* fall through */
  }
  return [{ frameId: 0, parentFrameId: -1, url: '' }];
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + ' timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function ensureCore(tabId: number, frameId: number): Promise<void> {
  try {
    const r: any = await withTimeout(
      chrome.tabs.sendMessage(tabId, { action: K_DOM_CORE_PING }, { frameId }),
      PING_TIMEOUT_MS,
      'core ping',
    );
    if (r && r.status === 'pong') return;
  } catch (e) {
    /* not injected yet (or the frame is gone — injection below tells us) */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: [K_DOM_CORE_SCRIPT],
      world: 'ISOLATED',
    } as any);
  } catch (e) {
    throw toBrowserError(e, 'NO_FRAME_ACCESS');
  }
}

export async function sendCore(tabId: number, frameId: number, message: Record<string, any>): Promise<any> {
  let response: any;
  try {
    response = await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch (e) {
    throw toBrowserError(e);
  }
  const structured = errorFromResponse(response);
  if (structured) throw structured;
  if (response && typeof response.error === 'string') {
    throw new BrowserActionError('EXECUTION_ERROR', response.error);
  }
  return response;
}

// Convenience: ensure the core in a frame and send one message.
export async function coreCall(tabId: number, frameId: number, message: Record<string, any>): Promise<any> {
  await ensureCore(tabId, frameId);
  return sendCore(tabId, frameId, message);
}

// ---------------------------------------------------------------------------
// RefBook
// ---------------------------------------------------------------------------
export const REF_BOOK_PREFIX = 'kareenos:refBook:';

export interface RefBook {
  tabId: number;
  taken_at: number;
  frames: Record<string, { epoch: string; url: string }>;
}

let refBookChain: Promise<unknown> = Promise.resolve();
function withRefBookLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = refBookChain.then(fn);
  refBookChain = run.catch(() => undefined);
  return run;
}

export async function readRefBook(laneId: string): Promise<RefBook | null> {
  try {
    const key = REF_BOOK_PREFIX + (laneId || 'default');
    const o = await chrome.storage.session.get(key);
    const v = o?.[key];
    return v && typeof v === 'object' && typeof v.tabId === 'number' ? (v as RefBook) : null;
  } catch (e) {
    return null;
  }
}

export function noteFrameEpoch(
  laneId: string,
  tabId: number,
  frameId: number,
  epoch: string | undefined,
  url?: string,
): Promise<void> {
  if (!epoch) return Promise.resolve();
  return withRefBookLock(async () => {
    const key = REF_BOOK_PREFIX + (laneId || 'default');
    let book = await readRefBook(laneId);
    if (!book || book.tabId !== tabId) book = { tabId, taken_at: Date.now(), frames: {} };
    book.frames[String(frameId)] = { epoch, url: url || book.frames[String(frameId)]?.url || '' };
    book.taken_at = Date.now();
    try {
      await chrome.storage.session.set({ [key]: book });
    } catch (e) {
      /* storage.session unavailable — refs then rely on the in-page map only */
    }
  });
}

export async function expectedEpoch(laneId: string, tabId: number, frameId: number): Promise<string | undefined> {
  const book = await readRefBook(laneId);
  if (!book || book.tabId !== tabId) return undefined;
  return book.frames[String(frameId)]?.epoch;
}
