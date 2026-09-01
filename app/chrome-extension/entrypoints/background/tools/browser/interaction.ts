import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';

interface Coordinates {
  x: number;
  y: number;
}

interface ClickToolParams {
  selector?: string; // CSS selector or XPath for the element to click
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree (window.__claudeElementMap)
  coordinates?: Coordinates; // Coordinates to click at (x, y relative to viewport)
  waitForNavigation?: boolean; // Whether to wait for navigation to complete after click
  timeout?: number; // Timeout in milliseconds for waiting for the element or navigation
  frameId?: number; // Target frame for ref/selector resolution
  double?: boolean; // Perform double click when true
  button?: 'left' | 'right' | 'middle';
  bubbles?: boolean;
  cancelable?: boolean;
  modifiers?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  laneId?: string; // which lane's tab to click in
}

/**
 * Tool for clicking elements on web pages
 */
class ClickTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLICK;

  /**
   * Execute click operation
   */
  async execute(args: ClickToolParams): Promise<ToolResult> {
    const {
      selector,
      selectorType = 'css',
      coordinates,
      waitForNavigation = false,
      timeout = TIMEOUTS.DEFAULT_WAIT * 5,
      frameId,
      button,
      bubbles,
      cancelable,
      modifiers,
    } = args;

    console.log(`Starting click operation with options:`, args);

    if (!selector && !coordinates && !args.ref) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide ref or selector or coordinates',
      );
    }

    try {
      // Resolve tab
      // Target the single channel tab the agent drives (same tab navigate steers).
      const tab = await this.resolveTargetTab(args);
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      let finalRef = args.ref;
      let finalSelector = selector;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
        try {
          const resolved = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            frameId,
          );
          if (resolved && resolved.success && resolved.ref) {
            finalRef = resolved.ref;
            finalSelector = undefined; // Use ref instead of selector
          } else {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
            );
          }
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Search every frame — dialogs/editors (and their buttons) commonly live
      // in a same-origin child frame that a top-frame-only click never sees.
      const frameIds = await this.listFrameIds(tab.id, frameId);
      let result: any = null;
      let lastError = '';
      for (const fid of frameIds) {
        try {
          await this.injectContentScript(
            tab.id,
            ['inject-scripts/click-helper.js'],
            false,
            'ISOLATED',
            false,
            fid === undefined ? undefined : [fid],
          );
          const r = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.CLICK_ELEMENT,
              selector: finalSelector,
              coordinates,
              ref: finalRef,
              waitForNavigation,
              timeout,
              double: args.double === true,
              button,
              bubbles,
              cancelable,
              modifiers,
            },
            fid,
          );
          if (r && !r.error) {
            result = r;
            break;
          }
          lastError = (r && r.error) || lastError;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      }

      if (!result) {
        return createErrorResponse(lastError || 'No frame on this page contained that element');
      }

      // Determine actual click method used
      let clickMethod: string;
      if (coordinates) {
        clickMethod = 'coordinates';
      } else if (finalRef) {
        clickMethod = 'ref';
      } else if (finalSelector) {
        clickMethod = 'selector';
      } else {
        clickMethod = 'unknown';
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Click operation successful',
              elementInfo: result.elementInfo,
              navigationOccurred: result.navigationOccurred,
              clickMethod,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in click operation:', error);
      return createErrorResponse(
        `Error performing click: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const clickTool = new ClickTool();

interface FillToolParams {
  selector?: string;
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree
  // Accept string | number | boolean for broader form input coverage
  value: string | number | boolean;
  frameId?: number;
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  laneId?: string; // which lane's tab to fill in
}

/**
 * Tool for filling form elements on web pages
 */
class FillTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL;

  /**
   * Execute fill operation
   */
  async execute(args: FillToolParams): Promise<ToolResult> {
    const { selector, selectorType = 'css', ref, value, frameId } = args;

    console.log(`Starting fill operation with options:`, args);

    // NOTE: selector/ref are OPTIONAL by design. With neither, fill-helper's
    // __kResolveFillTarget targets the focused editable element (else the single
    // visible editable box) — the auto-focused compose field case, which is how
    // rich-text composers (LinkedIn, Gmail) are actually filled since their real
    // editors are hashed-class contenteditables no selector can name. Guarding
    // on selector here made that path unreachable dead code.

    if (value === undefined || value === null) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': Value must be provided');
    }

    try {
      // Target the single channel tab the agent drives (same tab navigate steers).
      const tab = await this.resolveTargetTab(args);
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      let finalRef = ref;
      let finalSelector = selector;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
        try {
          const resolved = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            frameId,
          );
          if (resolved && resolved.success && resolved.ref) {
            finalRef = resolved.ref;
            finalSelector = undefined; // Use ref instead of selector
          } else {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
            );
          }
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Search every frame — rich-text composers commonly live in a same-origin
      // child frame, where a top-frame-only fill finds no editable at all.
      const frameIds = await this.listFrameIds(tab.id, frameId);
      let result: any = null;
      let lastError = '';
      for (const fid of frameIds) {
        try {
          await this.injectContentScript(
            tab.id,
            ['inject-scripts/fill-helper.js'],
            false,
            'ISOLATED',
            false,
            fid === undefined ? undefined : [fid],
          );
          const r = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.FILL_ELEMENT,
              selector: finalSelector,
              ref: finalRef,
              value,
            },
            fid,
          );
          if (r && !r.error) {
            result = r;
            break;
          }
          lastError = (r && r.error) || lastError;
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
        }
      }

      if (!result) {
        return createErrorResponse(
          lastError || 'No frame on this page contained a fillable element',
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Fill operation successful',
              elementInfo: result.elementInfo,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in fill operation:', error);
      return createErrorResponse(
        `Error filling element: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const fillTool = new FillTool();
