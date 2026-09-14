// Kareenos Browser Channel v2 — `run_steps` action → browser_run_steps.
//
// Executes an ordered list of steps INSIDE the extension, in the lane, with
// per-step settle and optional `expect` checks, in one round trip instead of N.
// A purpose-built runner: record-replay-v3 is ref-based too, but every node of
// it calls the unregistered `chrome_read_page` and drags flow/variable/trigger
// semantics along for a 150-line need.
//
//   { steps: [{ action, args, expect? }], stop_on_error }
//   expect = { text? | selector? | ref?, url_contains?, state?, timeout_ms? }
//
// Allowed step actions: navigate read snapshot click fill press scroll wait
// screenshot (no nested run_steps; no upload — its bytes must not ride a batch).
// Approval is decided SERVER-side before the batch is dispatched (gated when
// any step is side-effecting); the extension never self-approves.
import { BaseBrowserToolExecutor } from '../base-browser';
import type { ToolResult } from '@/common/tool-handler';
import { createStructuredError, parseStructuredError, structuredErrorFromException } from '@/common/browser-errors';
import { KAREENOS_TOOL_NAMES } from '@/common/kareenos-tool-names';
import { ACTION_DEFAULT_MS, resolveToolCall, toResultEnvelope, type BrowserAction, type CommandEnvelope } from '@/common/browser-channel-adapter';
import { snapshotTool } from './snapshot';
import { waitTool } from './wait';

export const RUN_STEPS_ALLOWED: BrowserAction[] = ['navigate', 'read', 'snapshot', 'click', 'fill', 'press', 'scroll', 'wait', 'screenshot'];
export const RUN_STEPS_MAX = 25;

export interface StepExpect {
  text?: string;
  selector?: string;
  ref?: string;
  url_contains?: string;
  state?: 'visible' | 'hidden' | 'attached' | 'detached';
  timeout_ms?: number;
}

export interface RunStep {
  action: BrowserAction;
  args?: Record<string, any>;
  expect?: StepExpect | null;
}

export interface RunStepsParams {
  steps: RunStep[];
  stop_on_error?: boolean;
  laneId?: string;
  tabId?: number;
  windowId?: number;
  timeoutMs?: number;
}

function compactData(action: string, data: any): any {
  if (!data || typeof data !== 'object') return data;
  if (action === 'screenshot') return { captured: !!(data.base64 || data.media_url) };
  const clone: Record<string, any> = {};
  Object.keys(data).forEach((k) => {
    if (k === 'text' && action === 'snapshot') return; // the batch carries its own snapshot diff
    if (k === 'textContent' && typeof data[k] === 'string') clone[k] = data[k].length > 600 ? data[k].slice(0, 597) + '...' : data[k];
    else clone[k] = data[k];
  });
  let s = JSON.stringify(clone);
  if (s.length > 900) {
    // keep the keys that matter for the agent's next decision
    const keep: Record<string, any> = {};
    ['message', 'settle', 'frame', 'selector_matched', 'matched', 'state', 'target', 'transport', 'scrolled', 'atBottom', 'url'].forEach((k) => {
      if (clone[k] !== undefined) keep[k] = clone[k];
    });
    s = JSON.stringify(keep);
    if (s.length > 900) return { message: clone.message, settle: clone.settle };
    return keep;
  }
  return clone;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`step timed out after ${ms} ms`)), ms);
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

function lineDiff(before: string, after: string): { added: number; removed: number; sample: string } {
  const a = new Set(before.split('\n').map((l) => l.trim()).filter(Boolean));
  const b = new Set(after.split('\n').map((l) => l.trim()).filter(Boolean));
  const added: string[] = [];
  const removed: string[] = [];
  b.forEach((l) => {
    if (!a.has(l) && !l.startsWith('# snapshot')) added.push(l);
  });
  a.forEach((l) => {
    if (!b.has(l) && !l.startsWith('# snapshot')) removed.push(l);
  });
  let sample = '';
  for (const l of added) {
    if (sample.length > 2000) break;
    sample += '+ ' + l + '\n';
  }
  for (const l of removed) {
    if (sample.length > 3000) break;
    sample += '- ' + l + '\n';
  }
  return { added: added.length, removed: removed.length, sample: sample.trim() };
}

async function takeSnapshotText(laneId: string): Promise<string> {
  try {
    const r = await snapshotTool.execute({ mode: 'interactive', maxChars: 8000, laneId });
    const text = r.content && r.content[0] && (r.content[0] as any).text;
    if (r.isError) return '';
    const parsed = JSON.parse(text || '{}');
    return String(parsed.text || '');
  } catch (e) {
    return '';
  }
}

class RunStepsTool extends BaseBrowserToolExecutor {
  name = KAREENOS_TOOL_NAMES.RUN_STEPS;

  async execute(args: RunStepsParams): Promise<ToolResult> {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    const laneId = args.laneId || 'default';
    const stopOnError = args.stop_on_error !== false;
    if (!steps.length) return createStructuredError('EXECUTION_ERROR', 'steps must be a non-empty array of { action, args, expect? }');
    if (steps.length > RUN_STEPS_MAX) return createStructuredError('EXECUTION_ERROR', `At most ${RUN_STEPS_MAX} steps per batch (got ${steps.length}).`);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!s || !RUN_STEPS_ALLOWED.includes(s.action)) {
        return createStructuredError('UNSUPPORTED_ACTION', `Step ${i + 1}: action "${s && s.action}" is not allowed in a batch (allowed: ${RUN_STEPS_ALLOWED.join(', ')}).`, { step: i + 1 });
      }
    }
    const { handleCallTool } = await import('../index');
    const started = Date.now();
    const budget = args.timeoutMs && args.timeoutMs > 0 ? args.timeoutMs - 2000 : 280000;
    const remaining = () => Math.max(0, budget - (Date.now() - started));

    const before = await takeSnapshotText(laneId);
    const results: any[] = [];
    let completed = 0;
    let stoppedAt: number | null = null;
    let failureMessage = '';

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const defaultMs = ACTION_DEFAULT_MS[step.action] || 15000;
      if (remaining() < Math.min(1500, defaultMs)) {
        stoppedAt = i + 1;
        failureMessage = `batch budget exhausted before step ${i + 1}`;
        results.push({ i: i + 1, action: step.action, status: 'failed', message: failureMessage, error: { code: 'TIMEOUT', message: failureMessage } });
        break;
      }
      const stepBudget = Math.min(defaultMs, remaining());
      const cmd: CommandEnvelope = {
        command_id: `batch_${i + 1}`,
        correlation_id: `batch_${i + 1}`,
        lane_id: laneId,
        action: step.action,
        args: step.args || {},
        timeout_ms: stepBudget + 3000,
      };
      const call = resolveToolCall(cmd);
      let envelope: any;
      const stepStart = Date.now();
      try {
        const toolResult = await withTimeout(handleCallTool({ name: call.name, args: call.args }), stepBudget);
        envelope = toResultEnvelope(step.action, cmd, toolResult as any);
      } catch (e) {
        envelope = { status: 'failed', message: (e as Error).message, data: {}, errors: [{ code: 'TIMEOUT', message: (e as Error).message, severity: 'error' }] };
      }
      const entry: any = {
        i: i + 1,
        action: step.action,
        status: envelope.status,
        message: envelope.message,
        data: compactData(step.action, envelope.data),
        took_ms: Date.now() - stepStart,
      };
      if (envelope.data && envelope.data.settle) entry.settle = envelope.data.settle;
      if (envelope.status === 'failed') {
        const err0 = envelope.errors && envelope.errors[0];
        entry.error = err0 ? { code: err0.code, message: err0.message, details: err0.details } : { code: 'EXECUTION_ERROR', message: envelope.message };
      }

      if (envelope.status === 'success' && step.expect) {
        const ex = step.expect;
        const exStart = Date.now();
        let ok = true;
        let why = '';
        if (ex.url_contains) {
          try {
            const tab = await this.resolveTargetTab({ laneId });
            ok = !!tab.url && tab.url.toLowerCase().includes(String(ex.url_contains).toLowerCase());
            if (!ok) why = `url "${tab.url}" does not contain "${ex.url_contains}"`;
          } catch (e) {
            ok = false;
            why = (e as Error).message;
          }
        }
        if (ok && (ex.text || ex.selector || ex.ref)) {
          const w = await waitTool.execute({ text: ex.text, selector: ex.selector, ref: ex.ref, state: ex.state || 'visible', timeout_ms: Math.min(ex.timeout_ms || 3000, remaining()), laneId });
          if (w.isError) {
            ok = false;
            const se = parseStructuredError((w.content[0] as any).text);
            why = se ? `[${se.code}] ${se.message}` : 'expectation not met';
          }
        }
        entry.expect = { ok, took_ms: Date.now() - exStart, why: ok ? undefined : why };
        if (!ok) {
          entry.status = 'failed';
          entry.error = { code: 'EXPECT_FAILED', message: why };
        }
      }

      results.push(entry);
      if (entry.status === 'success') completed++;
      else if (stopOnError) {
        stoppedAt = i + 1;
        failureMessage = `step ${i + 1} ${step.action} failed: ${entry.error ? '[' + entry.error.code + '] ' + entry.error.message : entry.message}`;
        break;
      }
    }

    const after = await takeSnapshotText(laneId);
    const diff = before || after ? lineDiff(before, after) : { added: 0, removed: 0, sample: '' };
    const failed = stoppedAt !== null;
    const message = failed
      ? `${completed}/${steps.length} steps completed; ${failureMessage}`
      : `${completed}/${steps.length} steps completed${completed < steps.length ? ' (some steps failed; stop_on_error=false)' : ''}`;
    const payload = {
      success: !failed,
      message,
      total: steps.length,
      completed,
      stopped_at: stoppedAt,
      steps: results,
      snapshot: { text: after.length > 6000 ? after.slice(0, 6000) + '\n… (truncated)' : after, diff },
      took_ms: Date.now() - started,
    };
    if (failed) {
      const last = results[results.length - 1];
      return createStructuredError(last && last.error ? last.error.code : 'EXECUTION_ERROR', message, { ...payload });
    }
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
  }
}

export const runStepsTool = new RunStepsTool();

// Test seam for the pure helpers.
export const __test = { lineDiff, compactData };
