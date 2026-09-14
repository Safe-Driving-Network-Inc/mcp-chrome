// Kareenos Browser Channel v2 — `snapshot` action → browser_snapshot (read-class).
//
// A compact accessibility snapshot of EVERY frame of the lane's tab, with
// frame-aware refs (f<frame>e<n>) the agent acts on directly. This replaces
// guessing `text=` labels from prose: snapshot → act by ref → read data.settle
// → snapshot again.
import { BaseBrowserToolExecutor } from '../base-browser';
import type { ToolResult } from '@/common/tool-handler';
import { createStructuredError, structuredErrorFromException, toBrowserError, BrowserActionError } from '@/common/browser-errors';
import { KAREENOS_TOOL_NAMES, K_MSG } from '@/common/kareenos-tool-names';
import { parseRef, formatRef, rewriteHelperRefs, isRef } from '@/common/browser-refs';
import { listFrames, coreCall, noteFrameEpoch, expectedEpoch } from './core-bridge';
import { frameMatches } from './target-resolver';
import { formatSnapshot, type FrameSnapshot } from './snapshot-format';

export interface SnapshotToolParams {
  mode?: 'interactive' | 'full';
  selector?: string; // scope: CSS / text= / a ref
  maxChars?: number;
  includeText?: boolean;
  frame?: string | number | null;
  laneId?: string;
  tabId?: number;
  windowId?: number;
  timeoutMs?: number;
}

export const SNAPSHOT_DEFAULT_CHARS = 30000;
export const SNAPSHOT_MIN_CHARS = 2000;
export const SNAPSHOT_MAX_CHARS = 60000;

class SnapshotTool extends BaseBrowserToolExecutor {
  name = KAREENOS_TOOL_NAMES.SNAPSHOT;

  async execute(args: SnapshotToolParams): Promise<ToolResult> {
    const mode = args.mode === 'full' ? 'full' : 'interactive';
    const maxChars = Math.max(SNAPSHOT_MIN_CHARS, Math.min(Number(args.maxChars) || SNAPSHOT_DEFAULT_CHARS, SNAPSHOT_MAX_CHARS));
    const includeText = args.includeText === true;
    const laneId = args.laneId || 'default';
    const scope = (args.selector || '').trim();
    const started = Date.now();
    try {
      const tab = await this.resolveTargetTab(args);
      if (!tab.id) return createStructuredError('NO_FRAME_ACCESS', 'The channel tab has no id');
      const tabId = tab.id;
      let frames = await listFrames(tabId);
      let scopeRefParsed = scope && isRef(scope) ? parseRef(scope) : null;
      if (scopeRefParsed) frames = frames.filter((f) => f.frameId === scopeRefParsed!.frameId);
      else frames = frames.filter((f) => frameMatches(f, args.frame));
      if (!frames.length) {
        return createStructuredError('NO_FRAME_ACCESS', `No frame matches "${args.frame ?? scope}" on this page.`);
      }
      const maxLines = Math.max(80, Math.min(4000, Math.floor(maxChars / 12)));

      const results = await Promise.allSettled(
        frames.map(async (f) => {
          const msg: Record<string, any> = { action: K_MSG.SNAPSHOT, mode, includeText, maxLines };
          if (scopeRefParsed) {
            msg.scopeRef = scopeRefParsed.helperRef;
            msg.expect_epoch = await expectedEpoch(laneId, tabId, f.frameId);
          } else if (scope) {
            msg.scopeSelector = scope;
          }
          const r = await coreCall(tabId, f.frameId, msg);
          if (r && r.epoch) void noteFrameEpoch(laneId, tabId, f.frameId, r.epoch, r.url || f.url);
          return r;
        }),
      );

      const frameSnaps: FrameSnapshot[] = [];
      let scopeMisses = 0;
      results.forEach((res, i) => {
        const f = frames[i];
        if (res.status === 'fulfilled') {
          const r = res.value || {};
          frameSnaps.push({
            frameId: f.frameId,
            parentFrameId: f.parentFrameId,
            url: r.url || f.url,
            title: r.title,
            lines: (r.lines || []).map((l: string) => rewriteHelperRefs(l, f.frameId)),
            refs: Number(r.refs) || 0,
            truncated: !!r.truncated,
            dialogs: (r.dialogs || []).map((d: any) => ({ ref: formatRef(f.frameId, d.ref), name: d.name, modal: !!d.modal })),
            focus: r.focus ? { ref: formatRef(f.frameId, r.focus.ref), role: r.focus.role, name: r.focus.name, is_iframe: !!r.focus.is_iframe } : null,
            viewport: r.viewport,
          });
        } else {
          const be = toBrowserError(res.reason);
          if (scope && !scopeRefParsed && be.code === 'NOT_FOUND') {
            scopeMisses++;
            frameSnaps.push({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url, lines: [], refs: 0, truncated: false, dialogs: [], focus: null });
          } else {
            frameSnaps.push({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url, lines: [], refs: 0, truncated: false, dialogs: [], focus: null, error: { code: be.code, message: be.message } });
          }
        }
      });
      if (scope && !scopeRefParsed && scopeMisses === frames.length) {
        throw new BrowserActionError('NOT_FOUND', `Nothing matches scope "${scope}" in any frame. Take an unscoped snapshot first.`, { selector: scope });
      }

      const formatted = formatSnapshot({ url: tab.url || '', title: tab.title || '', frames: frameSnaps, maxChars, mode });
      console.log(`[BC] snapshot tab=${tabId} frames=${frames.length} included=${formatted.frames_included.length} skipped=${formatted.frames_skipped.length} refs=${formatted.refs} chars=${formatted.chars}/${maxChars} took=${Date.now() - started}ms`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              text: formatted.text,
              url: tab.url,
              title: tab.title,
              mode,
              refs: formatted.refs,
              chars: formatted.chars,
              max_chars: maxChars,
              truncated: formatted.truncated,
              frames: frameSnaps.map((f) => ({
                id: f.frameId,
                parent: f.parentFrameId,
                url: f.url,
                lines: f.lines.length,
                refs: f.refs,
                dialog: f.dialogs.length > 0,
                error: f.error ? f.error.code : undefined,
              })),
              frames_skipped: formatted.frames_skipped,
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

export const snapshotTool = new SnapshotTool();
