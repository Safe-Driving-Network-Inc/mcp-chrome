// Kareenos Browser Channel v2 — upload (chrome_upload_file → platform "upload").
//
// Puts a file into the page: assigns it to an input[type=file] via DataTransfer
// (primary) or simulates a drag-and-drop on a drop zone (fallback). The bytes
// always arrive as base64 in the args — this tool never fetches URLs (storage
// URLs may be minted on an internal endpoint unreachable from the user's
// machine). `ref` (from browser_snapshot) targets one exact element in one
// exact frame; `frame` restricts the frames searched by selector; the upload
// settles afterwards (a site's "Editor" dialog opening is reported as
// settle.dialog_opened).
import type { ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { createStructuredError, structuredErrorFromException, toBrowserError, type BrowserActionError } from '@/common/browser-errors';
import { parseRef } from '@/common/browser-refs';
import { listFrames, ensureCore, expectedEpoch, type FrameInfo } from './core-bridge';
import { frameMatches } from './target-resolver';
import { withSettle } from '../settle';

interface UploadFileToolParams {
  selector?: string; // CSS selector or text= / :has-text() for the upload control
  ref?: string; // f<frame>e<n> from browser_snapshot
  frame?: string | number | null;
  base64Data?: string; // File bytes, base64 (provided by the caller — never fetched here)
  fileName?: string; // Filename presented to the website
  mimeType?: string; // MIME type of the file
  frameId?: number; // Target frame (uploads inside same-origin iframes)
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  laneId?: string; // which lane's tab to upload into
  timeoutMs?: number;
}

class UploadFileTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILE_UPLOAD;

  async execute(args: UploadFileToolParams): Promise<ToolResult> {
    const { selector, base64Data, fileName, mimeType } = args;
    const laneId = args.laneId || 'default';
    if (!selector && !args.ref) {
      return createStructuredError('NOT_FOUND', 'Provide ref (from browser_snapshot — a filechooser or the upload button) or selector (input[type=file], text=Add photo, or the drop zone text).');
    }
    if (!base64Data) return createStructuredError('EXECUTION_ERROR', 'base64Data is required');
    const budget = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 110000;
    const started = Date.now();

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
        return createStructuredError('NO_FRAME_ACCESS', 'Cannot upload to special browser pages or web store pages due to security restrictions.');
      }

      // Frames to try: the ref's frame, an explicit frame, or every frame (a
      // composer's file input commonly lives in a same-origin child frame).
      let frames: FrameInfo[] = await listFrames(tabId);
      let helperRef: string | undefined;
      const parsed = args.ref ? parseRef(args.ref) : null;
      if (args.ref && !parsed) return createStructuredError('NOT_FOUND', `"${args.ref}" is not a ref (refs look like f0e12).`);
      if (parsed) {
        frames = frames.filter((f) => f.frameId === parsed.frameId);
        helperRef = parsed.helperRef;
        if (!frames.length) return createStructuredError('STALE_REF', `Ref ${args.ref} points at a frame that no longer exists — take a new browser_snapshot.`);
      } else if (typeof args.frameId === 'number') {
        frames = frames.filter((f) => f.frameId === args.frameId);
      } else {
        frames = frames.filter((f) => frameMatches(f, args.frame));
      }
      if (!frames.length) return createStructuredError('NO_FRAME_ACCESS', `No frame matches "${args.frame}" on this page.`);

      let result: any = null;
      let usedFrame: FrameInfo | null = null;
      let lastErr: BrowserActionError | null = null;

      const { settle } = await withSettle({ tabId, laneId, budgetMs: budget - 500, capMs: 4000 }, async () => {
        for (const f of frames) {
          try {
            await ensureCore(tabId, f.frameId); // upload-helper resolves refs through the core
            await this.injectContentScript(tabId, ['inject-scripts/upload-helper.js'], false, 'ISOLATED', false, [f.frameId]);
            const r = await this.sendMessageToTab(
              tabId,
              {
                action: TOOL_MESSAGE_TYPES.UPLOAD_FILE,
                selector,
                ref: helperRef,
                expect_epoch: helperRef ? await expectedEpoch(laneId, tabId, f.frameId) : undefined,
                base64Data,
                fileName,
                mimeType,
              },
              f.frameId,
            );
            if (r && r.success) {
              result = r;
              usedFrame = f;
              return;
            }
            lastErr = toBrowserError(new Error((r && r.error) || 'upload failed'));
          } catch (e) {
            lastErr = toBrowserError(e);
          }
        }
      });

      if (!result) {
        const err = lastErr || toBrowserError(new Error('no frame accepted the file'));
        return createStructuredError(err.code, `${err.message}${frames.length > 1 ? ` (searched ${frames.length} frames)` : ''}`, {
          ...(err.details || {}),
          frames_searched: frames.map((f) => f.frameId),
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
              frame: usedFrame ? { id: (usedFrame as FrameInfo).frameId, url: (usedFrame as FrameInfo).url } : undefined,
              frameId: usedFrame ? (usedFrame as FrameInfo).frameId : undefined,
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
