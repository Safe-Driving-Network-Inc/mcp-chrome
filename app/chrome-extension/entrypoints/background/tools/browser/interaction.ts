// Kareenos Browser Channel v2 — click + fill.
//
// Both go through the shared target resolver (ref | selector, frame, nth,
// strict) so the frame is KNOWN before anything is dispatched — no more
// "try every frame, first answer wins", which let a top-frame false positive
// beat the real control in a child frame (LinkedIn's composer, the search-bar
// incident). Both settle afterwards and report what the page did.
import type { ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { createStructuredError, structuredErrorFromException, BrowserActionError } from '@/common/browser-errors';
import { K_MSG } from '@/common/kareenos-tool-names';
import { formatRef } from '@/common/browser-refs';
import { listFrames, coreCall, ensureCore, noteFrameEpoch, expectedEpoch } from './core-bridge';
import { resolveTarget, frameMatches, describeCandidate, type ResolvedTarget, type Candidate } from './target-resolver';
import { withSettle } from '../settle';

interface TargetArgs {
  selector?: string;
  ref?: string;
  frame?: string | number | null;
  nth?: number | null;
  strict?: boolean | null;
  tabId?: number;
  windowId?: number;
  laneId?: string;
  timeoutMs?: number;
}

interface ClickToolParams extends TargetArgs {
  double?: boolean;
  button?: 'left' | 'right' | 'middle';
  modifiers?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
}

function frameInfo(target: ResolvedTarget) {
  return { id: target.frameId, url: target.frameUrl || undefined };
}

function altList(target: ResolvedTarget) {
  return target.alternatives.length ? target.alternatives.map((c: Candidate) => describeCandidate(c)) : undefined;
}

/**
 * Tool for clicking elements on web pages
 */
class ClickTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLICK;

  async execute(args: ClickToolParams): Promise<ToolResult> {
    if (!args.selector && !args.ref) {
      return createStructuredError('NOT_FOUND', 'Provide ref (from browser_snapshot, e.g. f0e12) or selector (text=Label / CSS).');
    }
    const laneId = args.laneId || 'default';
    const budget = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 14000;
    const started = Date.now();
    try {
      const tab = await this.resolveTargetTab(args);
      if (!tab.id) return createStructuredError('NO_FRAME_ACCESS', 'The channel tab has no id');
      const tabId = tab.id;

      const target = await resolveTarget(tabId, laneId, {
        ref: args.ref,
        selector: args.selector,
        frame: args.frame,
        nth: args.nth,
        strict: args.strict,
        kind: 'click',
      });
      console.log(`[BC] click resolve ${args.ref || args.selector} → ${target.ref} (${target.role} "${target.name}", frame f${target.frameId}, tier ${target.tier}, alternatives ${target.alternatives.length})`);

      await ensureCore(tabId, target.frameId); // click-helper resolves refs through the core
      await this.injectContentScript(tabId, ['inject-scripts/click-helper.js'], false, 'ISOLATED', false, [target.frameId]);

      const { result, settle } = await withSettle({ tabId, laneId, budgetMs: budget - 300 }, async () => {
        return this.sendMessageToTab(
          tabId,
          {
            action: TOOL_MESSAGE_TYPES.CLICK_ELEMENT,
            ref: target.helperRef,
            expect_epoch: target.expectEpoch,
            double: args.double === true,
            button: args.button,
            modifiers: args.modifiers,
          },
          target.frameId,
        );
      });
      console.log(`[BC] settle click ${target.ref} navigated=${settle.navigated ? 1 : 0} dialog_opened=${settle.dialog_opened ? 1 : 0} focus=${settle.focus ? settle.focus.ref : '-'} mutations=${settle.dom_mutations} quiet_ms=${settle.quiet_ms}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: (result && result.message) || 'Click operation successful',
              ref: target.ref,
              frame: frameInfo(target),
              target: { role: target.role, name: target.name, tier: target.tier },
              elementInfo: result && result.elementInfo,
              covered_by_overlay: !!(result && result.elementInfo && result.elementInfo.coveredByOverlay),
              alternatives: altList(target),
              navigationOccurred: settle.navigated,
              settle,
              took_ms: Date.now() - started,
            }),
          },
        ],
        isError: false,
      };
    } catch (e) {
      return structuredErrorFromException(e);
    }
  }
}

export const clickTool = new ClickTool();

interface FillToolParams extends TargetArgs {
  // Accept string | number | boolean for broader form input coverage
  value: string | number | boolean;
}

// No selector, no ref: the field that OWNS FOCUS, wherever it is. Ask every
// frame (document.hasFocus() is false in a background tab, so the
// activeElement chain is what counts): the deepest frame whose active element
// is editable and not an <iframe> wins. Failing that, the ONLY visible editable
// on the page. Several → AMBIGUOUS with refs — never "the top frame's first
// box", which is how a caption once landed in LinkedIn's global search bar.
async function resolveFocusedEditable(tabId: number, laneId: string, frame?: string | number | null): Promise<ResolvedTarget> {
  const frames = (await listFrames(tabId)).filter((f) => frameMatches(f, frame));
  if (!frames.length) throw new BrowserActionError('NO_FRAME_ACCESS', `No frame matches "${frame}" on this page.`);
  const probes = await Promise.allSettled(
    frames.map(async (f) => {
      const r = await coreCall(tabId, f.frameId, { action: K_MSG.FOCUS_PROBE });
      if (r && r.epoch) void noteFrameEpoch(laneId, tabId, f.frameId, r.epoch, f.url);
      return { frame: f, r };
    }),
  );
  let focused: { frame: any; el: any } | null = null;
  const editables: Candidate[] = [];
  probes.forEach((p) => {
    if (p.status !== 'fulfilled') return;
    const { frame: f, r } = p.value;
    if (r && r.active && r.active.editable && !r.active.is_iframe) {
      if (!focused || f.frameId > focused.frame.frameId) focused = { frame: f, el: r.active };
    }
    (r && r.editables ? r.editables : []).forEach((e: any) => {
      editables.push({ ref: formatRef(f.frameId, e.ref), frame: f.frameId, frame_url: f.url, role: e.role, name: e.name, tier: 'visible', in_viewport: !!e.in_viewport, area: 0, editable: true });
    });
  });
  const mk = async (f: any, el: any, tier: string): Promise<ResolvedTarget> => ({
    frameId: f.frameId,
    frameUrl: f.url,
    helperRef: el.ref,
    ref: formatRef(f.frameId, el.ref),
    expectEpoch: await expectedEpoch(laneId, tabId, f.frameId),
    role: el.role,
    name: el.name,
    tier,
    candidates: editables.slice(0, 8),
    alternatives: [],
  });
  if (focused) return mk((focused as any).frame, (focused as any).el, 'focused');
  if (editables.length === 1) {
    const only = editables[0];
    const f = frames.find((x) => x.frameId === only.frame)!;
    return mk(f, { ref: only.ref.replace(/^f\d+e/, 'ref_'), role: only.role, name: only.name }, 'only-editable');
  }
  if (!editables.length) {
    throw new BrowserActionError('NOT_FOUND', 'No focused or visible editable field on the page. Click the field first, or take a browser_snapshot and pass its ref.');
  }
  throw new BrowserActionError('AMBIGUOUS', `Nothing has focus and there are ${editables.length} editable fields — pass the ref of the one you mean: ${editables.slice(0, 8).map(describeCandidate).join(' | ')}`, {
    count: editables.length,
    candidates: editables.slice(0, 8),
  });
}

/**
 * Tool for filling form elements on web pages
 */
class FillTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL;

  async execute(args: FillToolParams): Promise<ToolResult> {
    const { value } = args;
    if (value === undefined || value === null) {
      return createStructuredError('EXECUTION_ERROR', 'value must be provided');
    }
    const laneId = args.laneId || 'default';
    const budget = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs : 14000;
    const started = Date.now();
    try {
      const tab = await this.resolveTargetTab(args);
      if (!tab.id) return createStructuredError('NO_FRAME_ACCESS', 'The channel tab has no id');
      const tabId = tab.id;

      const target =
        args.ref || args.selector
          ? await resolveTarget(tabId, laneId, { ref: args.ref, selector: args.selector, frame: args.frame, nth: args.nth, strict: args.strict, kind: 'fill' })
          : await resolveFocusedEditable(tabId, laneId, args.frame);
      console.log(`[BC] fill resolve ${args.ref || args.selector || '(focused)'} → ${target.ref} (${target.role} "${target.name}", frame f${target.frameId}, tier ${target.tier})`);

      await ensureCore(tabId, target.frameId);
      await this.injectContentScript(tabId, ['inject-scripts/fill-helper.js'], false, 'ISOLATED', false, [target.frameId]);

      const { result, settle } = await withSettle({ tabId, laneId, budgetMs: budget - 300, quietMs: 200, capMs: 1500 }, async () => {
        return this.sendMessageToTab(
          tabId,
          { action: TOOL_MESSAGE_TYPES.FILL_ELEMENT, ref: target.helperRef, expect_epoch: target.expectEpoch, value },
          target.frameId,
        );
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: (result && result.message) || 'Fill operation successful',
              ref: target.ref,
              frame: frameInfo(target),
              target: { role: target.role, name: target.name, tier: target.tier },
              elementInfo: result && result.elementInfo,
              alternatives: altList(target),
              settle,
              took_ms: Date.now() - started,
            }),
          },
        ],
        isError: false,
      };
    } catch (e) {
      return structuredErrorFromException(e);
    }
  }
}

export const fillTool = new FillTool();
