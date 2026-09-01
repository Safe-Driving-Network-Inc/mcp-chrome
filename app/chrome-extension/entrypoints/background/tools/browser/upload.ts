import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { ERROR_MESSAGES } from '@/common/constants';

interface UploadFileToolParams {
  selector?: string; // CSS selector or text= / :has-text() for the upload control
  base64Data?: string; // File bytes, base64 (provided by the caller — never fetched here)
  fileName?: string; // Filename presented to the website
  mimeType?: string; // MIME type of the file
  frameId?: number; // Target frame (uploads inside same-origin iframes)
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  laneId?: string; // which lane's tab to upload into
}

/**
 * Tool for putting a file into the page: assigns it to an input[type=file] via
 * DataTransfer (primary) or simulates a drag-and-drop on a drop zone (fallback).
 * The bytes always arrive as base64 in the args — this tool never fetches URLs
 * (server-side resolution is the channel's doctrine: storage URLs may be minted
 * on an internal endpoint unreachable from the user's machine).
 */
class UploadFileTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILE_UPLOAD;

  async execute(args: UploadFileToolParams): Promise<ToolResult> {
    const { selector, base64Data, fileName, mimeType, frameId } = args;

    console.log(`Starting upload operation for selector:`, selector);

    if (!selector) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': selector is required');
    }
    if (!base64Data) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': base64Data is required');
    }

    try {
      // Target the single channel tab the agent drives (same tab navigate steers).
      const tab = await this.resolveTargetTab(args);
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      // Check URL restrictions
      if (
        tab.url?.startsWith('chrome://') ||
        tab.url?.startsWith('edge://') ||
        tab.url?.startsWith('https://chrome.google.com/webstore') ||
        tab.url?.startsWith('https://microsoftedge.microsoft.com/')
      ) {
        return createErrorResponse(
          'Cannot upload to special browser pages or web store pages due to security restrictions.',
        );
      }

      // FRAMES MATTER. Real composers (LinkedIn's post box, many editors) render
      // inside a same-origin CHILD frame — the top document then holds no editor
      // and no file input at all, so a top-frame-only search always reports
      // "nothing found" on a page that visibly has an uploader. Try the caller's
      // frame if given, else every frame in the tab, and keep the first frame
      // that actually accepts the file.
      let frameIds: (number | undefined)[] = [frameId];
      if (frameId === undefined) {
        try {
          const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
          frameIds = frames && frames.length ? frames.map((f) => f.frameId) : [undefined];
        } catch (e) {
          frameIds = [undefined];
        }
      }

      let result: any = null;
      let lastError = '';
      for (const fid of frameIds) {
        try {
          await this.injectContentScript(
            tab.id,
            ['inject-scripts/upload-helper.js'],
            false,
            'ISOLATED',
            false,
            fid === undefined ? undefined : [fid],
          );
          const r = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.UPLOAD_FILE,
              selector,
              base64Data,
              fileName,
              mimeType,
            },
            fid,
          );
          if (r && r.success) {
            result = r;
            (result as any).frameId = fid ?? 0;
            break;
          }
          lastError = (r && r.error) || lastError;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      }

      if (!result) {
        return createErrorResponse(
          `Error uploading file: ${lastError || 'no frame accepted the file'}` +
            (frameIds.length > 1 ? ` (searched ${frameIds.length} frames)` : ''),
        );
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
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in upload operation:', error);
      return createErrorResponse(
        `Error uploading file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const uploadFileTool = new UploadFileTool();
