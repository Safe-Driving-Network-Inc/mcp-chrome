import { describe, it, expect } from 'vitest';
import {
  resolveToolCall,
  toResultEnvelope,
  failureEnvelope,
  isSupportedAction,
  budgetFor,
  ACTION_DEFAULT_MS,
  type CommandEnvelope,
} from '@/common/browser-channel-adapter';
import { createStructuredError } from '@/common/browser-errors';

const cmd = (action: any, args: any, extra: Partial<CommandEnvelope> = {}): CommandEnvelope => ({
  command_id: 'c1',
  correlation_id: 'r1',
  lane_id: 'lane-a',
  action,
  args,
  ...extra,
});

describe('browser-channel-adapter', () => {
  it('passes the v2 targeting vocabulary through for click/fill', () => {
    const c = resolveToolCall(cmd('click', { selector: 'text=Post', ref: 'f3e7', frame: 'f3', nth: 1, strict: true, junk: 'dropped' }, { timeout_ms: 17000 }));
    expect(c.name).toBe('chrome_click_element');
    expect(c.args).toMatchObject({ selector: 'text=Post', ref: 'f3e7', frame: 'f3', nth: 1, strict: true, laneId: 'lane-a', timeoutMs: 14000 });
    expect('junk' in c.args).toBe(false);
    const f = resolveToolCall(cmd('fill', { ref: 'f0e2', value: 'hello' }));
    expect(f.args).toMatchObject({ ref: 'f0e2', value: 'hello', timeoutMs: ACTION_DEFAULT_MS.fill - 3000 });
  });
  it('budgets from timeout_ms with a margin and a floor', () => {
    expect(budgetFor('read', 15000)).toBe(12000);
    expect(budgetFor('read', 1000)).toBe(1000);
    expect(budgetFor('upload', null)).toBe(ACTION_DEFAULT_MS.upload - 3000);
  });
  it('maps the new actions to the kareenos tools', () => {
    expect(resolveToolCall(cmd('snapshot', { mode: 'full', max_chars: 5000, include_text: true })).args).toMatchObject({ mode: 'full', maxChars: 5000, includeText: true });
    expect(resolveToolCall(cmd('wait', { text: 'Done', state: 'visible', timeout_ms: 3000 })).name).toBe('kareenos_wait');
    expect(resolveToolCall(cmd('press', { keys: 'Enter', ref: 'f0e1' })).name).toBe('kareenos_press');
    const b = resolveToolCall(cmd('run_steps', { steps: [{ action: 'click', args: { ref: 'f0e1' } }] }));
    expect(b.name).toBe('kareenos_run_steps');
    expect(b.args.steps).toHaveLength(1);
    expect(b.args.stop_on_error).toBe(true);
    expect(isSupportedAction('run_steps')).toBe(true);
    expect(isSupportedAction('execute_js')).toBe(false);
  });
  it('surfaces structured errors with code, details and candidates', () => {
    const env = toResultEnvelope('click', cmd('click', {}), createStructuredError('AMBIGUOUS', '2 matches', { candidates: [{ ref: 'f0e1' }, { ref: 'f0e2' }] }));
    expect(env.status).toBe('failed');
    expect(env.message).toBe('[AMBIGUOUS] 2 matches');
    expect(env.errors[0].code).toBe('AMBIGUOUS');
    expect(env.errors[0].details?.candidates).toHaveLength(2);
    expect(env.data.candidates).toHaveLength(2);
  });
  it('keeps legacy prose errors as BROWSER_ACTION_FAILED', () => {
    const env = toResultEnvelope('read', cmd('read', {}), { content: [{ type: 'text', text: 'old style' }], isError: true } as any);
    expect(env.errors[0].code).toBe('BROWSER_ACTION_FAILED');
    expect(env.message).toBe('old style');
  });
  it('keeps the screenshot base64 path and adds clip metadata', () => {
    const env = toResultEnvelope('screenshot', cmd('screenshot', {}), {
      content: [{ type: 'text', text: JSON.stringify({ base64Data: 'AAA', mimeType: 'image/jpeg', clip: 'element', target: { ref: 'f0e1' } }) }],
      isError: false,
    } as any);
    expect(env.data).toMatchObject({ base64: 'AAA', media_type: 'image/jpeg', clip: 'element', target: { ref: 'f0e1' } });
  });
  it('passes settle through the generic path', () => {
    const env = toResultEnvelope('click', cmd('click', {}), {
      content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'ok', settle: { navigated: false, dialog_opened: true } }) }],
      isError: false,
    } as any);
    expect(env.status).toBe('success');
    expect(env.data.settle.dialog_opened).toBe(true);
  });
  it('builds failure envelopes with details', () => {
    const env = failureEnvelope(cmd('click', {}), 'TIMEOUT', 'too slow', { budget_ms: 14000 });
    expect(env.message).toBe('[TIMEOUT] too slow');
    expect(env.errors[0].details).toEqual({ budget_ms: 14000 });
  });
});
