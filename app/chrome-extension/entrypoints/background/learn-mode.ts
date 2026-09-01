// ============================================================================
// Learn Mode — record a user demonstration and ship it upstream as a macro
// ============================================================================
// The user names a session in the popup ("how to post photo with text on
// linkedin"), performs the task by hand, and hits Stop & Save. We reuse the
// existing recorder stack (RecorderManager + inject-scripts/recorder.js —
// all-frames capture, multi-candidate selectors, fill coalescing, password
// redaction) and add only what Learn Mode needs:
//   * flatten the recorded Flow DAG into a linear, redacted step list (v1)
//   * queue it in a chrome.storage.local outbox (MV3 SW eviction / offline safe)
//   * send {type:'macro_recorded'} over the browser-channel socket; entries
//     leave the outbox only when the server answers {type:'macro_ack'}
// Agents later fetch the recipe by title (get_browser_macro) and replay it
// with the ordinary browser tools — this file never executes anything.
// ============================================================================

import type { Flow, VariableDef } from './record-replay/types';
import { RecorderManager } from './record-replay/recording/recorder-manager';
import { recordingSession } from './record-replay/recording/session-manager';
import { listFlows } from './record-replay/flow-store';
import { sendUpstreamFrame, getBrowserChannelState } from './browser-channel-client';

const LEARN_SESSION_KEY = 'kareenos_learn_session';
const OUTBOX_KEY = 'kareenos_macro_outbox';
const OUTBOX_MAX = 5;
const MAX_STEPS = 300;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_ANCHORS = 4;
const MAX_ANCHOR_CHARS = 300;
const TRIM_VALUE_CHARS = 2000;

interface LearnSession {
  title: string;
  startedAt: string; // ISO
}

interface MacroAnchor {
  type: string;
  value: string;
}

interface MacroStep {
  i: number;
  type: 'navigate' | 'click' | 'fill' | 'upload' | 'scroll' | 'key';
  anchors?: MacroAnchor[];
  frame_url?: string | null;
  value?: string | boolean | null;
  url?: string;
  file?: { name: string; mime: string; size: number };
  keys?: string;
  offset?: { x: number; y: number };
}

interface MacroV1 {
  v: 1;
  title: string;
  origin: string;
  start_url: string | null;
  recorded_at: string;
  truncated: boolean;
  steps: MacroStep[];
}

interface OutboxEntry {
  client_id: string;
  macro: MacroV1;
}

// ---------------------------------------------------------------------------
// storage helpers
// ---------------------------------------------------------------------------

async function getLearnSession(): Promise<LearnSession | null> {
  try {
    const r = await chrome.storage.local.get(LEARN_SESSION_KEY);
    return (r?.[LEARN_SESSION_KEY] as LearnSession) || null;
  } catch {
    return null;
  }
}

async function setLearnSession(s: LearnSession | null): Promise<void> {
  try {
    if (s) await chrome.storage.local.set({ [LEARN_SESSION_KEY]: s });
    else await chrome.storage.local.remove(LEARN_SESSION_KEY);
  } catch {}
}

async function getOutbox(): Promise<OutboxEntry[]> {
  try {
    const r = await chrome.storage.local.get(OUTBOX_KEY);
    return Array.isArray(r?.[OUTBOX_KEY]) ? (r[OUTBOX_KEY] as OutboxEntry[]) : [];
  } catch {
    return [];
  }
}

async function setOutbox(entries: OutboxEntry[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [OUTBOX_KEY]: entries });
  } catch {}
}

// ---------------------------------------------------------------------------
// flattener: Flow DAG -> MacroV1
// ---------------------------------------------------------------------------

/** Timeline derivation, same contract as session-manager.getTimelineSteps(): a
 * node is {id, type, config} where config carries the original step body. */
function nodesToSteps(flow: Flow): Array<Record<string, any>> {
  if (!Array.isArray(flow.nodes) || !flow.nodes.length) {
    return Array.isArray((flow as any).steps) ? ((flow as any).steps as any[]) : [];
  }
  return flow.nodes.map((n) => {
    const cfg = n && typeof n.config === 'object' && n.config != null ? n.config : {};
    return { ...(cfg as Record<string, any>), type: n.type };
  });
}

function anchorsFromTarget(target: any): MacroAnchor[] {
  const out: MacroAnchor[] = [];
  const cands = target && Array.isArray(target.candidates) ? target.candidates : [];
  for (const c of cands) {
    if (!c || typeof c.value !== 'string' || !c.value) continue;
    out.push({
      type: String(c.type || 'css').slice(0, 20),
      value: c.value.slice(0, MAX_ANCHOR_CHARS),
    });
    if (out.length >= MAX_ANCHORS) break;
  }
  if (!out.length && target && typeof target.selector === 'string' && target.selector) {
    out.push({ type: 'css', value: target.selector.slice(0, MAX_ANCHOR_CHARS) });
  }
  return out;
}

function anchorsLookSensitive(anchors: MacroAnchor[]): boolean {
  const s = JSON.stringify(anchors).toLowerCase();
  return (
    s.includes('type=password') ||
    s.includes('type="password"') ||
    s.includes('autocomplete=cc-') ||
    s.includes('autocomplete="cc-')
  );
}

/** The recorder substitutes `{var_xxxx}` / `{<inputName>}` placeholders for
 * sensitive and file inputs; the variable defs say which is which. */
function resolveFillValue(
  value: any,
  vars: Map<string, VariableDef>,
  anchors: MacroAnchor[],
): string | boolean | null {
  if (typeof value === 'boolean') return value; // checkbox / radio
  if (value == null) return null;
  const str = String(value);
  const m = /^\{([^{}]+)\}$/.exec(str);
  if (m) {
    const def = vars.get(m[1]);
    if (def && def.sensitive) return '{{secret}}';
    return '{{' + m[1] + '}}'; // parameterized (non-sensitive) variable
  }
  if (anchorsLookSensitive(anchors)) return '{{secret}}';
  return str;
}

export function flattenFlowToMacro(flow: Flow, title: string): { macro?: MacroV1; error?: string } {
  const rawSteps = nodesToSteps(flow);
  if (!rawSteps.length) return { error: 'Recording is empty — no steps captured' };

  const vars = new Map<string, VariableDef>();
  for (const v of flow.variables || []) if (v && v.key) vars.set(v.key, v);

  const steps: MacroStep[] = [];
  let origin = '';
  let startUrl: string | null = null;
  let frameCtx: string | null = null;

  for (const raw of rawSteps) {
    if (steps.length >= MAX_STEPS) break;
    const t = String(raw.type || '');
    const frameUrl: string | null =
      typeof raw.frameHref === 'string' && raw.frameHref ? raw.frameHref : frameCtx;

    if (t === 'navigate' || t === 'openTab') {
      const url = typeof raw.url === 'string' ? raw.url : '';
      if (!url) continue;
      frameCtx = null;
      if (!startUrl) {
        startUrl = url;
        try {
          origin = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        } catch {}
      }
      // collapse consecutive navigates to the same URL (initial nav often repeats)
      const prev = steps[steps.length - 1];
      if (prev && prev.type === 'navigate' && prev.url === url) continue;
      steps.push({ i: steps.length + 1, type: 'navigate', url: url.slice(0, TRIM_VALUE_CHARS) });
      continue;
    }

    if (t === 'switchFrame') {
      // consumed: sets frame context for subsequent steps, not emitted
      frameCtx = raw.frame && raw.frame.urlContains ? String(raw.frame.urlContains) : frameCtx;
      continue;
    }

    if (t === 'click' || t === 'dblclick') {
      const anchors = anchorsFromTarget(raw.target);
      if (!anchors.length) continue;
      // consecutive clicks on the same target are recording noise (double-fired
      // handlers, shadow-host retargeting) — one is enough for the recipe
      const prev = steps[steps.length - 1];
      if (prev && prev.type === 'click' && JSON.stringify(prev.anchors) === JSON.stringify(anchors))
        continue;
      steps.push({ i: steps.length + 1, type: 'click', anchors, frame_url: frameUrl });
      continue;
    }

    if (t === 'fill') {
      const anchors = anchorsFromTarget(raw.target);
      if (raw.file && typeof raw.file === 'object') {
        // file input — becomes an upload step; metadata only, replay supplies a real file
        steps.push({
          i: steps.length + 1,
          type: 'upload',
          anchors: anchors.length ? anchors : [{ type: 'css', value: 'input[type=file]' }],
          file: {
            name: String(raw.file.name || '').slice(0, 255),
            mime: String(raw.file.mime || '').slice(0, 100),
            size: Number(raw.file.size) || 0,
          },
          value: '{{file}}',
          frame_url: frameUrl,
        });
        continue;
      }
      if (!anchors.length) continue;
      const value = resolveFillValue(raw.value, vars, anchors);
      const fillValue = typeof value === 'string' ? value.slice(0, 4000) : value;
      // re-fills of the same field carry the FINAL text — collapse onto the
      // earlier step instead of replaying partial values ("FleetX", "FleetXPro")
      const prevFill = steps[steps.length - 1];
      if (
        prevFill &&
        prevFill.type === 'fill' &&
        JSON.stringify(prevFill.anchors) === JSON.stringify(anchors)
      ) {
        prevFill.value = fillValue;
        continue;
      }
      steps.push({
        i: steps.length + 1,
        type: 'fill',
        anchors,
        value: fillValue,
        frame_url: frameUrl,
      });
      continue;
    }

    if (t === 'scroll') {
      const off = raw.offset || {};
      // only keep meaningful scrolls; micro-scrolls are noise for replay
      if (Math.abs(Number(off.y) || 0) < 200 && Math.abs(Number(off.x) || 0) < 200) continue;
      steps.push({
        i: steps.length + 1,
        type: 'scroll',
        offset: { x: Number(off.x) || 0, y: Number(off.y) || 0 },
      });
      continue;
    }

    if (t === 'keypress' || t === 'key') {
      const keys = String(raw.keys || raw.key || '');
      if (!keys) continue;
      // typing artifacts are noise: capitals record as Shift+F etc. while the
      // fill step already carries the final text — keep only named keys
      // (Enter/Tab/Escape/arrows...) and real Ctrl/Meta/Alt shortcuts
      const named = /(Enter|Tab|Escape|Arrow|Page(Up|Down)|Home|End|Delete)/i.test(keys);
      const combo = /(Ctrl|Control|Meta|Cmd|Alt)\s*\+/i.test(keys);
      if (!named && !combo) continue;
      steps.push({
        i: steps.length + 1,
        type: 'key',
        keys: keys.slice(0, 60),
        frame_url: frameUrl,
      });
      continue;
    }

    // triggerEvent / screenshot / waitFor / switchTab / script / etc: dropped
  }

  if (!steps.length) return { error: 'Recording contained no replayable steps' };
  if (!origin) return { error: 'Could not determine the site origin from the recording' };

  const macro: MacroV1 = {
    v: 1,
    title,
    origin,
    start_url: startUrl,
    recorded_at: new Date().toISOString(),
    truncated: rawSteps.length > MAX_STEPS,
    steps,
  };

  // size cap: first trim long values, then drop trailing steps
  let json = JSON.stringify(macro);
  if (json.length > MAX_JSON_BYTES) {
    for (const s of macro.steps) {
      if (typeof s.value === 'string' && s.value.length > TRIM_VALUE_CHARS) {
        s.value = s.value.slice(0, TRIM_VALUE_CHARS);
        macro.truncated = true;
      }
    }
    json = JSON.stringify(macro);
    while (json.length > MAX_JSON_BYTES && macro.steps.length > 1) {
      macro.steps.pop();
      macro.truncated = true;
      json = JSON.stringify(macro);
    }
  }

  return { macro };
}

// ---------------------------------------------------------------------------
// outbox: queue + drain over the browser channel
// ---------------------------------------------------------------------------

async function enqueueMacro(macro: MacroV1): Promise<string> {
  const clientId =
    (globalThis.crypto && 'randomUUID' in globalThis.crypto && crypto.randomUUID()) ||
    `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outbox = await getOutbox();
  outbox.push({ client_id: clientId as string, macro });
  while (outbox.length > OUTBOX_MAX) outbox.shift();
  await setOutbox(outbox);
  return clientId as string;
}

/** Send every queued macro. Entries stay queued until the server acks — safe
 * to call repeatedly (on stop, on every bind_ack, on SW spin-up). */
export async function drainMacroOutbox(): Promise<void> {
  const outbox = await getOutbox();
  if (!outbox.length) return;
  for (const entry of outbox) {
    const sent = sendUpstreamFrame({
      type: 'macro_recorded',
      client_id: entry.client_id,
      title: entry.macro.title,
      origin: entry.macro.origin,
      start_url: entry.macro.start_url,
      recorded_at: entry.macro.recorded_at,
      truncated: entry.macro.truncated,
      step_count: entry.macro.steps.length,
      steps: entry.macro.steps,
      v: 1,
    });
    if (!sent) break; // socket not open — keep queued, next bind_ack retries
  }
}

/** Server verdict for one queued macro. Remove the entry either way (a NACK is
 * a validation failure — resending identical bytes cannot succeed) and let the
 * popup show the outcome. */
export async function handleMacroAck(frame: any): Promise<void> {
  const clientId = frame && frame.client_id;
  if (clientId) {
    const outbox = await getOutbox();
    const next = outbox.filter((e) => e.client_id !== clientId);
    if (next.length !== outbox.length) await setOutbox(next);
  }
  try {
    chrome.runtime
      .sendMessage({
        type: 'learn_macro_ack',
        ok: frame?.ok === true,
        macro_id: frame?.macro_id || null,
        client_id: clientId || null,
        reason: frame?.reason || null,
      })
      .catch?.(() => {});
  } catch {}
}

// ---------------------------------------------------------------------------
// start / stop / status
// ---------------------------------------------------------------------------

async function startLearn(title: string): Promise<{ success: boolean; error?: string }> {
  const t = String(title || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || t.length > 200)
    return { success: false, error: 'Give the session a short title first' };
  if (recordingSession.getStatus() !== 'idle') {
    return { success: false, error: 'A recording is already active' };
  }
  const res = await RecorderManager.start({ name: t });
  if (!res.success) return res;
  await setLearnSession({ title: t, startedAt: new Date().toISOString() });
  return { success: true };
}

/** If the recording was already stopped out-of-band (in-page HUD stop, SW
 * eviction), recover the flow from the store: newest flow named after the
 * session and updated since it started. */
async function recoverStoppedFlow(learn: LearnSession): Promise<Flow | null> {
  try {
    const flows = await listFlows();
    const startedMs = Date.parse(learn.startedAt) || 0;
    const candidates = flows.filter((f) => {
      const updated = Date.parse(f.meta?.updatedAt || '') || 0;
      return f.name === learn.title && updated >= startedMs - 60_000;
    });
    candidates.sort(
      (a, b) =>
        (Date.parse(b.meta?.updatedAt || '') || 0) - (Date.parse(a.meta?.updatedAt || '') || 0),
    );
    return candidates[0] || null;
  } catch {
    return null;
  }
}

async function stopLearn(): Promise<{
  success: boolean;
  error?: string;
  client_id?: string;
  step_count?: number;
}> {
  const learn = await getLearnSession();
  if (!learn) return { success: false, error: 'No Learn Mode session is active' };

  let flow: Flow | null = null;
  if (recordingSession.getStatus() !== 'idle') {
    const res = await RecorderManager.stop();
    flow = res.flow || null;
  }
  if (!flow) flow = await recoverStoppedFlow(learn);
  await setLearnSession(null);
  if (!flow) return { success: false, error: 'Recording not found — was anything captured?' };

  const { macro, error } = flattenFlowToMacro(flow, learn.title);
  if (!macro) return { success: false, error: error || 'Could not build the macro' };

  const clientId = await enqueueMacro(macro);
  await drainMacroOutbox();
  return { success: true, client_id: clientId, step_count: macro.steps.length };
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

export function initLearnMode(): void {
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'learn_start') {
        startLearn(msg.title)
          .then(sendResponse)
          .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
        return true;
      }
      if (msg.type === 'learn_stop') {
        stopLearn()
          .then(sendResponse)
          .catch((e) => sendResponse({ success: false, error: e?.message || String(e) }));
        return true;
      }
      if (msg.type === 'learn_status') {
        Promise.all([getLearnSession(), getOutbox()])
          .then(([learn, outbox]) =>
            sendResponse({
              success: true,
              learn,
              recording: recordingSession.getStatus(),
              pending: outbox.length,
              channel: getBrowserChannelState(),
            }),
          )
          .catch(() => sendResponse({ success: false }));
        return true;
      }
    });
  } catch {}

  // SW spin-up with a connected socket: flush anything still queued.
  drainMacroOutbox().catch(() => {});
}
