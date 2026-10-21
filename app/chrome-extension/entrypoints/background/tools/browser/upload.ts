// Kareenos Browser Channel v2 — upload (chrome_upload_file → platform "upload").
//
// Puts a file into the page: assigns it to an input[type=file] via DataTransfer
// (primary) or simulates a drag-and-drop on a drop zone (fallback). `ref` (from
// browser_snapshot) targets one exact element in one exact frame; `frame`
// restricts the frames searched by selector; the upload settles afterwards (a
// site's "Editor" dialog opening is reported as settle.dialog_opened).
//
// Two ways the bytes arrive (2026-10-19):
//   inline  — base64Data in the args (files up to ~20 MB, the server decides):
//             one message to the page, as before.
//   url     — sourceUrl + sizeBytes: the file's PUBLIC Kareenos link. This
//             worker downloads it as a stream and hands the page 4 MB pieces,
//             which the page helper assembles into the File. No message is
//             ever larger than a few MB, so a 1 GB video goes through the same
//             limits (Redis pub/sub, extension messaging) as a photo. Only
//             Kareenos' own public media links are fetched: the server builds
//             the URL, and an older server sends base64 instead.
// The page helper keeps the pieces as Blobs (Chrome pages large blobs to disk),
// so the renderer never holds a 1 GB array.
import type { ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import {
  createStructuredError,
  structuredErrorFromException,
  toBrowserError,
  errorFromResponse,
  type BrowserActionError,
} from '@/common/browser-errors';
import { parseRef } from '@/common/browser-refs';
import { listFrames, ensureCore, expectedEpoch, type FrameInfo } from './core-bridge';
import { frameMatches } from './target-resolver';
import { withSettle } from '../settle';

interface UploadFileToolParams {
  selector?: string; // CSS selector or text= / :has-text() for the upload control
  ref?: string; // f<frame>e<n> from browser_snapshot
  frame?: string | number | null;
  base64Data?: string; // File bytes, base64 — the inline transport
  sourceUrl?: string; // The file's public Kareenos link — the url transport
  sizeBytes?: number; // Expected size (url transport; checked after the download)
  fileName?: string; // Filename presented to the website
  mimeType?: string; // MIME type of the file
  frameId?: number; // Target frame (uploads inside same-origin iframes)
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  laneId?: string; // which lane's tab to upload into
  timeoutMs?: number;
}

// The page helper's message vocabulary (inject-scripts/upload-helper.js, v2).
const HELPER_ACTION = 'uploadFileV2';
const HELPER_PING = 'chrome_upload_file_ping2';
const HELPER_FILE = 'inject-scripts/upload-helper.js';
const HELPER_PING_TIMEOUT_MS = 400;

// Piece size handed to the page. 4 MiB of bytes = 5.6 MB of base64 per message,
// far under Chrome's extension message limit (64 MB) and quick to decode.
const CHUNK_BYTES = 4 * 1024 * 1024;
// A piece is also flushed on time, so a slow link still produces an extension
// API call (which resets the service worker's idle timer) every few seconds.
const FLUSH_INTERVAL_MS = 8000;
const KEEPALIVE_MS = 20000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
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

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP) as unknown as number[]);
  }
  return btoa(bin);
}

function mb(n: number): string {
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

class UploadFileTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILE_UPLOAD;

  // The v2 helper answers its own ping with {version: 2}. Anything else (no
  // helper, or the pre-1.3.5 helper left in a page that was open across the
  // update) gets the file injected; the v2 file knows how to coexist with the
  // old one (see the guard at the top of upload-helper.js).
  private async ensureHelper(tabId: number, frameId: number): Promise<void> {
    try {
      const r: any = await withTimeout(
        chrome.tabs.sendMessage(tabId, { action: HELPER_PING }, { frameId }),
        HELPER_PING_TIMEOUT_MS,
        'upload helper ping',
      );
      if (r && r.status === 'pong' && Number(r.version) >= 2) return;
    } catch (e) {
      /* not injected yet, or an old helper: inject below */
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: [HELPER_FILE],
        world: 'ISOLATED',
      } as any);
    } catch (e) {
      throw toBrowserError(e, 'NO_FRAME_ACCESS');
    }
  }

  private async helperCall(
    tabId: number,
    frameId: number,
    message: Record<string, any>,
  ): Promise<any> {
    let response: any;
    try {
      response = await chrome.tabs.sendMessage(
        tabId,
        { action: HELPER_ACTION, ...message },
        { frameId },
      );
    } catch (e) {
      throw toBrowserError(e);
    }
    const structured = errorFromResponse(response);
    if (structured) throw structured;
    if (response && response.error) throw new Error(String(response.error));
    if (!response || !response.success)
      throw new Error((response && response.message) || 'upload helper answered without a result');
    return response;
  }

  async execute(args: UploadFileToolParams): Promise<ToolResult> {
    const { selector, base64Data, sourceUrl, fileName, mimeType } = args;
    const laneId = args.laneId || 'default';
    if (!selector && !args.ref) {
      return createStructuredError(
        'NOT_FOUND',
        'Provide ref (from browser_snapshot — a filechooser or the upload button) or selector (input[type=file], text=Add photo, or the drop zone text).',
      );
    }
    if (!base64Data && !sourceUrl)
      return createStructuredError('EXECUTION_ERROR', 'base64Data is required');
    if (sourceUrl && !/^https:\/\//i.test(String(sourceUrl))) {
      return createStructuredError('EXECUTION_ERROR', 'sourceUrl must be an https link');
    }
    const budget = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 110000;
    const started = Date.now();
    const deadline = started + budget - 2500;

    try {
      const tab = await this.resolveTargetTab(args);
      if (!tab.id) return createStructuredError('NO_FRAME_ACCESS', 'The channel tab has no id');
      const tabId = tab.id;

      if (
        tab.url?.startsWith('chrome://') ||
        tab.url?.startsWith('edge://') ||
        tab.url?.startsWith('https://chrome.google.com/webstore') ||
        tab.url?.startsWith('https://microsoftedge.microsoft.com/')
      ) {
        return createStructuredError(
          'NO_FRAME_ACCESS',
          'Cannot upload to special browser pages or web store pages due to security restrictions.',
        );
      }

      // Frames to try: the ref's frame, an explicit frame, or every frame (a
      // composer's file input commonly lives in a same-origin child frame).
      let frames: FrameInfo[] = await listFrames(tabId);
      let helperRef: string | undefined;
      const parsed = args.ref ? parseRef(args.ref) : null;
      if (args.ref && !parsed)
        return createStructuredError(
          'NOT_FOUND',
          `"${args.ref}" is not a ref (refs look like f0e12).`,
        );
      if (parsed) {
        frames = frames.filter((f) => f.frameId === parsed.frameId);
        helperRef = parsed.helperRef;
        if (!frames.length)
          return createStructuredError(
            'STALE_REF',
            `Ref ${args.ref} points at a frame that no longer exists — take a new browser_snapshot.`,
          );
      } else if (typeof args.frameId === 'number') {
        frames = frames.filter((f) => f.frameId === args.frameId);
      } else {
        frames = frames.filter((f) => frameMatches(f, args.frame));
      }
      if (!frames.length)
        return createStructuredError(
          'NO_FRAME_ACCESS',
          `No frame matches "${args.frame}" on this page.`,
        );

      const name = fileName || 'uploaded-file';
      const mime = mimeType || 'application/octet-stream';

      // 1. Find the frame that has the upload control (a probe sets nothing),
      //    so a missing input is reported before any byte is downloaded.
      let target: { frame: FrameInfo; sessionId: string; probe: any } | null = null;
      let lastErr: BrowserActionError | null = null;
      for (const f of frames) {
        try {
          await ensureCore(tabId, f.frameId); // upload-helper resolves refs through the core
          await this.ensureHelper(tabId, f.frameId);
          const r = await this.helperCall(tabId, f.frameId, {
            mode: 'probe',
            selector,
            ref: helperRef,
            expect_epoch: helperRef ? await expectedEpoch(laneId, tabId, f.frameId) : undefined,
            fileName: name,
            mimeType: mime,
            sizeBytes: args.sizeBytes || undefined,
          });
          target = { frame: f, sessionId: String(r.session_id), probe: r };
          break;
        } catch (e) {
          lastErr = toBrowserError(e);
        }
      }
      if (!target) {
        const err = lastErr || toBrowserError(new Error('no frame accepted the file'));
        return createStructuredError(
          err.code,
          `${err.message}${frames.length > 1 ? ` (searched ${frames.length} frames)` : ''}`,
          {
            ...(err.details || {}),
            frames_searched: frames.map((f) => f.frameId),
          },
        );
      }
      const { frame: usedFrame, sessionId } = target;

      // 2. Hand the bytes over: one piece (inline) or a streamed download (url).
      let transport: 'inline' | 'url' = 'inline';
      let bytes = 0;
      let downloadMs = 0;
      const abort = async () => {
        try {
          await this.helperCall(tabId, usedFrame.frameId, { mode: 'abort', session_id: sessionId });
        } catch (e) {
          /* best effort */
        }
      };
      if (base64Data) {
        const r = await this.helperCall(tabId, usedFrame.frameId, {
          mode: 'chunk',
          session_id: sessionId,
          index: 0,
          base64: base64Data,
        });
        bytes = Number(r.received) || 0;
      } else {
        transport = 'url';
        const t0 = Date.now();
        const controller = new AbortController();
        // An extension API call every 20 s keeps the MV3 worker alive on a link
        // too slow to fill a piece within its idle window.
        const keepAlive = setInterval(() => {
          chrome.runtime.getPlatformInfo().catch(() => undefined);
        }, KEEPALIVE_MS);
        let index = 0;
        let pending: Uint8Array[] = [];
        let pendingBytes = 0;
        let lastFlush = Date.now();
        let nextLog = 0.1;
        const expected = Number(args.sizeBytes) || 0;
        const flush = async () => {
          if (!pendingBytes) return;
          const piece = new Uint8Array(pendingBytes);
          let off = 0;
          for (const p of pending) {
            piece.set(p, off);
            off += p.length;
          }
          pending = [];
          pendingBytes = 0;
          const b64 = toBase64(piece);
          const r = await this.helperCall(tabId, usedFrame.frameId, {
            mode: 'chunk',
            session_id: sessionId,
            index: index++,
            base64: b64,
          });
          bytes = Number(r.received) || bytes + piece.length;
          lastFlush = Date.now();
          if (expected && bytes / expected >= nextLog) {
            console.log(`[upload] ${name}: ${mb(bytes)} of ${mb(expected)} handed to the page`);
            nextLog += 0.1;
          }
        };
        try {
          const res = await fetch(String(sourceUrl), {
            credentials: 'omit',
            cache: 'no-store',
            redirect: 'follow',
            signal: controller.signal,
          });
          if (!res.ok) {
            await abort();
            return createStructuredError(
              'EXECUTION_ERROR',
              `Could not download the file from Kareenos (HTTP ${res.status}). The link may have expired or the file was deleted; ask the agent to retry.`,
            );
          }
          if (!res.body) {
            await abort();
            return createStructuredError('EXECUTION_ERROR', 'The download had no body.');
          }
          const reader = res.body.getReader();
          for (;;) {
            if (Date.now() > deadline) {
              controller.abort();
              await abort();
              return createStructuredError(
                'TIMEOUT',
                `Downloading the file took longer than the ${Math.round(budget / 1000)} s allowed: ${mb(bytes + pendingBytes)}${expected ? ` of ${mb(expected)}` : ''} arrived in ${Math.round((Date.now() - t0) / 1000)} s. The user's connection is too slow for a file this size; try a smaller file.`,
                {
                  received_bytes: bytes + pendingBytes,
                  expected_bytes: expected || undefined,
                },
              );
            }
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length) {
              pending.push(value);
              pendingBytes += value.length;
            }
            if (
              pendingBytes >= CHUNK_BYTES ||
              (pendingBytes && Date.now() - lastFlush > FLUSH_INTERVAL_MS)
            )
              await flush();
          }
          await flush();
        } catch (e: any) {
          controller.abort();
          await abort();
          const err = toBrowserError(e);
          return createStructuredError(
            err.code === 'NO_FRAME_ACCESS' ? err.code : 'EXECUTION_ERROR',
            `Download or hand-off failed after ${mb(bytes)}: ${err.message}`,
            {
              received_bytes: bytes,
              expected_bytes: expected || undefined,
            },
          );
        } finally {
          clearInterval(keepAlive);
        }
        downloadMs = Date.now() - t0;
        if (expected && bytes !== expected) {
          await abort();
          return createStructuredError(
            'EXECUTION_ERROR',
            `The download ended at ${bytes} bytes but the file is ${expected} bytes; nothing was uploaded. Retry.`,
            {
              received_bytes: bytes,
              expected_bytes: expected,
            },
          );
        }
      }

      // 3. Build the File in the page and set it on the control; settle after.
      let result: any = null;
      let commitErr: BrowserActionError | null = null;
      const { settle } = await withSettle(
        { tabId, laneId, budgetMs: Math.max(5000, deadline - Date.now()), capMs: 4000 },
        async () => {
          try {
            result = await this.helperCall(tabId, usedFrame.frameId, {
              mode: 'commit',
              session_id: sessionId,
            });
          } catch (e) {
            commitErr = toBrowserError(e);
          }
        },
      );
      if (!result) {
        const err = commitErr || toBrowserError(new Error('the page did not accept the file'));
        return createStructuredError(err.code, err.message, {
          ...(err.details || {}),
          frameId: usedFrame.frameId,
          transport,
          received_bytes: bytes,
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'File upload successful',
              method: result.method,
              fileName: result.fileName,
              sizeBytes: result.sizeBytes,
              targetTagName: result.targetTagName,
              elementInfo: result.elementInfo,
              frame: { id: usedFrame.frameId, url: usedFrame.url },
              frameId: usedFrame.frameId,
              transport,
              download_ms: transport === 'url' ? downloadMs : undefined,
              settle,
              took_ms: Date.now() - started,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return structuredErrorFromException(error);
    }
  }
}

export const uploadFileTool = new UploadFileTool();
