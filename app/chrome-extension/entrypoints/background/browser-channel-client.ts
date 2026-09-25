// ============================================================================
// Kareenos Browser Channel — outbound wss client (P1.3)
// ============================================================================
// The ONLY new subsystem in the extension and the ONLY command source. It makes
// a single OUTBOUND wss://<server>/browser-channel connection — no listener, no
// localhost port, no native bridge. It binds identity with a channel token, then
// dispatches the bounded actions to handleCallTool and returns result envelopes.
//
// Security spine:
//  * outbound only; no inbound command path other than this socket.
//  * page content is never interpreted as a command (we only run commands that
//    arrive as {type:'command'} frames over this socket).
//  * unknown/unsupported actions return status:'failed', never a guess.
//
// Lifecycle (rewritten 2026-08-31 — "signed in but agents say offline"):
//  * The token is DURABLE: chrome.storage.local, re-issued by the server in every
//    bind_ack (sliding renewal), revocable server-side (Sign out / admin). The
//    old design kept a 1h token in storage.session, which Chrome wipes on exit —
//    every remote user was silently signed out daily.
//  * The background is the SOLE writer of the token record. There is deliberately
//    NO storage.onChanged → reconnect trigger: persisting the token the server
//    just handed back must never itself cause a reconnect (that is a loop).
//  * The MV3 service worker is kept alive by the socket itself: a JSON ping every
//    20s (any WebSocket traffic resets the worker's idle timer on Chrome ≥116) with
//    a 10s pong deadline. A silent socket after laptop sleep is DETACHED and
//    replaced immediately — we never wait for a half-open socket's onclose.
//  * Reconnect = exponential backoff (1s→30s) + a 30s chrome.alarms backstop (which
//    also resurrects the worker after eviction) + opportunistic nudges from the
//    user's own browsing (tab activation / navigation), onStartup, onInstalled,
//    and the `online` event.
//  * Every socket has its own handle; each handler checks it is still the current
//    socket before touching module state (a stale onclose used to null a newer
//    socket's bookkeeping).
//  * bind_ack ok:false with a terminal reason, or close 4000/4003, clears the
//    token and parks in `signed_out` — no retry storm with a dead token.
//    Close 4001 (another browser took over) parks in `superseded` with NO
//    automatic reconnect, so two Chrome profiles never flap. Close 1000
//    ('replaced') is the SAME session's older socket being retired after a
//    re-bind elsewhere — a plain reconnectable close, never a park.
//  * The token also slides WHILE CONNECTED (2026-09-14): the server pushes a
//    `token` frame from its heartbeat when less than half the TTL is left, and
//    answers a `renew` frame on demand. Before this, renewal happened only at
//    bind, so a browser that stayed connected past the TTL held an EXPIRED token
//    by the time it finally reconnected — the "signed out after a few hours"
//    that survived the 08-31 rewrite (together with a 1 h TTL left in the
//    server's config file).
// initBrowserChannelClient() is called on every SW spin-up (background/index.ts).
// ============================================================================

import { handleCallTool } from './tools';
import {
  isSupportedAction,
  resolveToolCall,
  toResultEnvelope,
  failureEnvelope,
  type CommandEnvelope,
} from '@/common/browser-channel-adapter';

const ALARM_NAME = 'kareenos-browser-channel-heartbeat';
// storage.local: { token, exp, session_id, renewable } — written ONLY by this module.
const CHANNEL_KEY = 'kareenos_channel';
// Pre-2026-08-31 location (storage.session) — migrated once, then removed.
const LEGACY_SESSION_TOKEN_KEY = 'kareenos_channel_token';
const BOUND_KEY = 'kareenos_bound';
const SERVER_URL_KEY = 'kareenos_server_url';
const API_URL_KEY = 'kareenos_api_url';
// Build-time default server (white-label override via .env; runtime override via
// chrome.storage.local 'kareenos_server_url'). Must include the /browser-channel path.
const DEFAULT_SERVER_URL =
  import.meta.env.VITE_BROWSER_CHANNEL_URL || 'wss://ap4.sdnvision.services:8092/browser-channel';
// REST base used ONLY for the sign-out fallback when the socket is down. Defaults
// to https://<wss host>/api derived from the server URL.
const DEFAULT_API_URL = (import.meta.env.VITE_KAREENOS_API_URL as string) || '';

const PING_INTERVAL_MS = 20_000; // < 30s MV3 idle timer
const PONG_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// Ask the server for a fresh token when the one we hold expires within this
// window and the bind_ack did not already renew it (older server / no exp).
const RENEW_MARGIN_SEC = 7 * 86_400;

// bind_ack reasons after which retrying the SAME token can never succeed.
const TERMINAL_REASONS = new Set([
  'MISSING_TOKEN',
  'INVALID_TOKEN',
  'EXPIRED',
  'INCOMPLETE_TENANT',
  'REVOKED',
]);
// Server close codes (mirrored in browser_channel_server.js / browser-channel-envelope.md).
const CLOSE_SIGNED_OUT = 4000;
const CLOSE_SUPERSEDED = 4001;
const CLOSE_REVOKED = 4003;

export type ConnState = 'signed_out' | 'disconnected' | 'connecting' | 'bound' | 'superseded' | 'waiting_bootstrap';

interface ChannelRecord {
  token: string;
  exp?: number | null; // epoch seconds
  session_id?: string | null;
  renewable?: boolean;
  // Hosted kind (Kareenos Cloud Browser): the durable token is bound to ONE VM.
  kind?: 'attended' | 'hosted';
  vm_id?: string | null;
}

// One live socket + its private timers. Everything that can fire late is keyed on
// this object, never on module state.
interface Conn {
  ws: WebSocket;
  bound: boolean;
  pingTimer: ReturnType<typeof setInterval> | null;
  pongDeadline: ReturnType<typeof setTimeout> | null;
  connectTimer: ReturnType<typeof setTimeout> | null;
}

let current: Conn | null = null;
let state: ConnState = 'disconnected';
let lastError: string | null = null;
let boundSince: number | null = null;
let supersededBy: any = null;
let backoffMs = BACKOFF_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connectInFlight: Promise<void> | null = null;
let channelCache: ChannelRecord | null | undefined; // undefined = not read yet
let channelLoadInFlight: Promise<ChannelRecord | null> | null = null;
let channelLoadError: string | null = null; // last storage READ failure (not "no token")

function setState(s: ConnState) {
  state = s;
  // Surface to the popup / welcome page (best effort).
  try {
    chrome.runtime.sendMessage({ type: 'browser_channel_state', state: s }).catch?.(() => {});
  } catch (e) {
    /* no popup open */
  }
}

export function getBrowserChannelState(): ConnState {
  return state;
}

function describeState() {
  const rec = channelCache || null;
  let version: string | null = null;
  try {
    version = chrome.runtime.getManifest().version || null;
  } catch (e) {
    version = null;
  }
  return {
    state,
    has_token: !!(rec && rec.token),
    exp: (rec && rec.exp) || null,
    renewable: rec ? rec.renewable !== false : false,
    bound_since: boundSince,
    last_error: lastError,
    superseded_by: supersededBy,
    version,
    hosted: isHosted(),
    vm_id: (rec && rec.vm_id) || hostedVmId || null,
  };
}
let hostedVmId: string | null = null;
const BOOTSTRAP_USED_KEY = 'kareenos_bootstrap_used';
// A bootstrap token is single-use on the server; remember which issue we spent
// so a policy refresh that repeats the same object does not trigger a replay.
async function bootstrapUsedAt(): Promise<number | null> {
  try {
    const got = await chrome.storage.local.get(BOOTSTRAP_USED_KEY);
    const v = got && got[BOOTSTRAP_USED_KEY];
    return v && typeof v.issued_at === 'number' ? v.issued_at : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Token record (storage.local) — this module is the only writer.
// ---------------------------------------------------------------------------
async function getChannel(): Promise<ChannelRecord | null> {
  if (channelCache !== undefined) return channelCache;
  if (channelLoadInFlight) return channelLoadInFlight;
  channelLoadInFlight = (async () => {
    let rec: ChannelRecord | null = null;
    let readFailed = false;
    try {
      const r = await chrome.storage.local.get(CHANNEL_KEY);
      const v = r?.[CHANNEL_KEY];
      if (v && typeof v.token === 'string' && v.token) rec = v as ChannelRecord;
    } catch (e: any) {
      // A storage READ failure is not "no token". Caching null here made one
      // transient error a sticky "Signed out" for the worker's whole life.
      readFailed = true;
      channelLoadError = 'token read failed: ' + (e?.message || e);
      lastError = channelLoadError;
    }
    if (!rec && !readFailed) {
      // One-time migration from the pre-2026-08-31 session-storage slot (only
      // present if Chrome has not restarted since that build signed in).
      try {
        const r = await chrome.storage.session.get(LEGACY_SESSION_TOKEN_KEY);
        const t = r?.[LEGACY_SESSION_TOKEN_KEY];
        if (typeof t === 'string' && t) {
          rec = { token: t, exp: null, session_id: null, renewable: true };
          await chrome.storage.local.set({ [CHANNEL_KEY]: rec });
          await chrome.storage.session.remove(LEGACY_SESSION_TOKEN_KEY);
        }
      } catch (e) {
        /* ignore */
      }
    }
    if (readFailed) return null; // leave channelCache undefined: retry next time
    channelLoadError = null;
    channelCache = rec;
    return rec;
  })().finally(() => {
    channelLoadInFlight = null;
  });
  return channelLoadInFlight;
}

// Persist a (new) token record. On storage failure the in-memory copy is kept —
// the previous token stays valid until its own exp, so nothing is lost.
async function persistChannel(rec: ChannelRecord): Promise<void> {
  channelCache = rec;
  try {
    await chrome.storage.local.set({ [CHANNEL_KEY]: rec });
  } catch (e: any) {
    lastError = 'token persist failed: ' + (e?.message || e);
  }
}

async function clearSignIn(): Promise<void> {
  channelCache = null;
  boundSince = null;
  try {
    await chrome.storage.local.remove([CHANNEL_KEY, BOUND_KEY]);
  } catch (e) {
    /* ignore */
  }
  try {
    await chrome.storage.session.remove(LEGACY_SESSION_TOKEN_KEY);
  } catch (e) {
    /* ignore */
  }
}

async function getServerUrl(): Promise<string> {
  try {
    const r = await chrome.storage.local.get(SERVER_URL_KEY);
    return r?.[SERVER_URL_KEY] || DEFAULT_SERVER_URL;
  } catch (e) {
    return DEFAULT_SERVER_URL;
  }
}

async function getApiUrl(): Promise<string> {
  try {
    const r = await chrome.storage.local.get(API_URL_KEY);
    if (r?.[API_URL_KEY]) return String(r[API_URL_KEY]).replace(/\/+$/, '');
  } catch (e) {
    /* ignore */
  }
  if (DEFAULT_API_URL) return DEFAULT_API_URL.replace(/\/+$/, '');
  try {
    const u = new URL(await getServerUrl());
    return (u.protocol === 'ws:' ? 'http://' : 'https://') + u.hostname + '/api';
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
function send(obj: any) {
  const ws = current?.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      /* ignore */
    }
  }
}

// Upstream frames that are NOT command results (today: Learn Mode's
// 'macro_recorded'). Unlike send(), reports whether the frame actually left —
// callers keep their payload queued (outbox) when the socket isn't bound yet.
export function sendUpstreamFrame(obj: any): boolean {
  const c = current;
  if (!c || !c.bound || c.ws.readyState !== WebSocket.OPEN) return false;
  try {
    c.ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Command execution (unchanged semantics)
// ---------------------------------------------------------------------------
// A tool that overruns its budget is answered with TIMEOUT right away (the
// server's await would expire anyway) but the lane still waits for it to finish
// (capped) before the next command, so a runaway action can never interleave
// with the command that follows it.
const OVERRUN_WAIT_CAP_MS = 60_000;

async function executeCommand(cmd: CommandEnvelope) {
  const startedAt = Date.now();
  let call: { name: string; args: Record<string, any> };
  try {
    call = resolveToolCall(cmd);
  } catch (e: any) {
    send({ type: 'result', ...failureEnvelope(cmd, 'EXECUTION_ERROR', (e && e.message) || 'Could not resolve the action') });
    return;
  }
  const budget = Number(call.args.timeoutMs) || 15_000;
  console.log(
    `[BC] cmd ${cmd.command_id} lane=${cmd.lane_id || 'default'} action=${cmd.action} timeout_ms=${cmd.timeout_ms ?? 'n/a'} budget_ms=${budget}`,
  );
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const run = handleCallTool({ name: call.name, args: call.args });
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('budget exceeded'));
    }, budget + 500);
  });
  try {
    const toolResult = await Promise.race([run, guard]);
    const envelope = toResultEnvelope(cmd.action, cmd, toolResult as any);
    console.log(
      `[BC] result ${cmd.command_id} status=${envelope.status}` +
        (envelope.status === 'failed' ? ` code=${envelope.errors[0] ? envelope.errors[0].code : 'n/a'}` : '') +
        ` took=${Date.now() - startedAt}ms`,
    );
    send({ type: 'result', ...envelope });
  } catch (e: any) {
    if (timedOut) {
      console.warn(`[BC] timeout ${cmd.command_id} after ${Date.now() - startedAt}ms (tool still running)`);
      send({
        type: 'result',
        ...failureEnvelope(cmd, 'TIMEOUT', `The ${cmd.action} action did not finish within ${budget} ms in the browser.`, {
          budget_ms: budget,
          action: cmd.action,
        }),
      });
      // keep the lane serialized: let the overrunning tool finish (capped)
      await Promise.race([run.catch(() => undefined), new Promise((r) => setTimeout(r, OVERRUN_WAIT_CAP_MS))]);
    } else {
      send({
        type: 'result',
        ...failureEnvelope(cmd, 'EXECUTION_ERROR', (e && e.message) || 'Tool execution failed'),
      });
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Per-lane serialization: commands WITHIN one lane run strictly in order (a
// lane's click must see its own navigate's page), while different lanes run
// CONCURRENTLY — that is the whole point of multi-lane. The map holds each
// lane's tail promise; in-memory only (in-flight commands don't survive an MV3
// SW eviction anyway — the server times out and tells the agent).
const laneTails = new Map<string, Promise<void>>();

function handleCommand(cmd: CommandEnvelope) {
  if (!cmd || !cmd.command_id) return;
  if (!isSupportedAction(cmd.action)) {
    send({
      type: 'result',
      ...failureEnvelope(cmd, 'UNSUPPORTED_ACTION', 'Unsupported action: ' + cmd.action),
    });
    return;
  }
  const laneId = cmd.lane_id || 'default';
  const tail = (laneTails.get(laneId) || Promise.resolve()).then(() => executeCommand(cmd));
  laneTails.set(laneId, tail);
  tail.finally(() => {
    if (laneTails.get(laneId) === tail) laneTails.delete(laneId);
  });
}

// ---------------------------------------------------------------------------
// Socket lifecycle
// ---------------------------------------------------------------------------
function clearConnTimers(c: Conn) {
  if (c.pingTimer) clearInterval(c.pingTimer);
  if (c.pongDeadline) clearTimeout(c.pongDeadline);
  if (c.connectTimer) clearTimeout(c.connectTimer);
  c.pingTimer = null;
  c.pongDeadline = null;
  c.connectTimer = null;
}

// Forget a socket NOW: strip its handlers so nothing it does later can touch
// module state, close it best-effort, and drop it. Used for pong timeout,
// connect timeout, sign-in replacement and sign-out — half-open sockets after a
// laptop sleep may not deliver onclose for minutes, and we will not wait.
function detach(c: Conn) {
  clearConnTimers(c);
  c.bound = false;
  try {
    c.ws.onopen = null;
    c.ws.onmessage = null;
    c.ws.onclose = null;
    c.ws.onerror = null;
  } catch (e) {
    /* ignore */
  }
  try {
    c.ws.close();
  } catch (e) {
    /* ignore */
  }
  if (current === c) current = null;
}

function cancelReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (state === 'signed_out' || state === 'superseded') return;
  const jitter = Math.floor(Math.random() * backoffMs * 0.3);
  const delay = backoffMs + jitter;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect('backoff');
  }, delay);
}

function startPing(c: Conn) {
  if (c.pingTimer) clearInterval(c.pingTimer);
  c.pingTimer = setInterval(() => {
    if (current !== c) {
      clearConnTimers(c);
      return;
    }
    if (c.ws.readyState !== WebSocket.OPEN) {
      // CLOSING/CLOSED with no onclose delivered (seen after sleep): the old code
      // returned here and left the client pinned at `bound` forever — popup said
      // Connected while every agent saw the browser offline.
      lastError = 'socket not open at ping (readyState ' + c.ws.readyState + ')';
      detach(c);
      setState('disconnected');
      connect('ping-not-open');
      return;
    }
    try {
      c.ws.send(JSON.stringify({ type: 'ping' }));
    } catch (e) {
      /* handled by the pong deadline */
    }
    if (!c.pongDeadline) {
      c.pongDeadline = setTimeout(() => {
        if (current !== c) return;
        lastError = 'no pong within ' + PONG_TIMEOUT_MS / 1000 + 's — socket presumed dead';
        detach(c);
        setState('disconnected');
        connect('pong-timeout');
      }, PONG_TIMEOUT_MS);
    }
  }, PING_INTERVAL_MS);
}

// Persist a server-issued token — from a bind_ack renewal, from the server's
// heartbeat (`token` frame, pushed when < half the TTL is left) or in answer to
// our `renew`. Never triggers a reconnect: the background is the sole writer and
// the socket that delivered it is the one we keep using. A frame without a token
// still updates exp/renewable (renewable:false = past the absolute max age).
async function persistRenewal(frame: any): Promise<void> {
  const hosted = frame.kind === 'hosted' || isHosted();
  const vmId = frame.vm_id || hostedVmId || channelCache?.vm_id || null;
  if (typeof frame.token === 'string' && frame.token) {
    await persistChannel({
      token: frame.token,
      exp: typeof frame.exp === 'number' ? frame.exp : channelCache?.exp || null,
      session_id: hosted ? 'hosted:' + (vmId || '') : channelCache?.session_id || null,
      renewable: frame.renewable !== false,
      kind: hosted ? 'hosted' : 'attended',
      vm_id: hosted ? vmId : null,
    });
  } else if (channelCache) {
    channelCache = {
      ...channelCache,
      exp: typeof frame.exp === 'number' ? frame.exp : channelCache.exp || null,
      renewable: frame.renewable !== false,
    };
    try {
      await chrome.storage.local.set({ [CHANNEL_KEY]: channelCache });
    } catch (e) {
      /* ignore */
    }
  }
}

// Ask for a fresh token when the one we hold is close to its expiry and the
// bind_ack did not already renew it (older server, or a record without exp).
function maybeRequestRenewal(c: Conn) {
  const rec = channelCache;
  if (!rec || rec.renewable === false) return;
  const nowSec = Math.floor(Date.now() / 1000);
  if (!rec.exp || rec.exp - nowSec < RENEW_MARGIN_SEC) {
    try {
      c.ws.send(JSON.stringify({ type: 'renew' }));
    } catch (e) {
      /* the heartbeat renewal covers it */
    }
  }
}

function handleBindAck(c: Conn, frame: any, boot: any) {
  if (c.connectTimer) {
    clearTimeout(c.connectTimer);
    c.connectTimer = null;
  }
  if (frame.ok) {
    // Sliding renewal — persist BEFORE declaring bound; a persist failure keeps
    // the old (still valid) token in memory. In hosted mode the first ack turns
    // the single-use bootstrap into the durable token, and the popup labels come
    // from the managed policy rather than a sign-in.
    if (frame.kind === 'hosted') {
      hostedVmId = frame.vm_id || hostedVmId;
      if (boot) {
        chrome.storage.local
          .set({
            [BOOTSTRAP_USED_KEY]: { issued_at: boot.issued_at || 0, at: Date.now() },
            [BOUND_KEY]: {
              projectid: (boot.label && boot.label.projectid) || null,
              accountid: (boot.label && boot.label.accountid) || null,
              userid: (boot.label && boot.label.userid) || null,
              session_id: 'hosted:' + (boot.vm_id || ''),
              project_name: (boot.label && boot.label.project_name) || null,
              account_name: (boot.label && boot.label.account_name) || null,
              user_name: (boot.label && boot.label.user_name) || null,
            },
          })
          .catch(() => {});
      }
    }
    const done = persistRenewal(frame);
    done.catch(() => {}).then(() => {
      if (current !== c) return;
      c.bound = true;
      boundSince = Date.now();
      backoffMs = BACKOFF_MIN_MS;
      lastError = null;
      setState('bound');
      startPing(c);
      maybeRequestRenewal(c);
      // We are live: flush any Learn Mode macros recorded while offline.
      // Dynamic import — learn-mode statically imports this module.
      import('./learn-mode')
        .then((m) => m.drainMacroOutbox())
        .catch(() => {});
    });
    return;
  }
  const reason = String(frame.reason || 'UNKNOWN');
  lastError = 'bind rejected: ' + reason;
  detach(c);
  if (isHosted()) {
    // Hosted: never park in signed_out (there is no user to sign in). A spent or
    // refused bootstrap waits for the runtime's next policy write; VM_MISMATCH /
    // TRY_LATER / maintenance retry with backoff.
    if (reason === 'BOOTSTRAP_REPLAYED' || TERMINAL_REASONS.has(reason)) {
      if (boot) chrome.storage.local.set({ [BOOTSTRAP_USED_KEY]: { issued_at: boot.issued_at || 0, at: Date.now() } }).catch(() => {});
      if (TERMINAL_REASONS.has(reason)) clearSignIn().catch(() => {});
      setState('waiting_bootstrap');
      return;
    }
    setState('disconnected');
    scheduleReconnect();
    return;
  }
  if (TERMINAL_REASONS.has(reason)) {
    // Retrying this token can never work — stop, clear it, tell the user.
    clearSignIn()
      .catch(() => {})
      .then(() => setState('signed_out'));
    return;
  }
  // maintenance / TRY_LATER / anything unknown: come back with backoff.
  setState('disconnected');
  scheduleReconnect();
}

function handleClose(c: Conn, code: number, reason: string) {
  clearConnTimers(c);
  if (current === c) current = null;
  if (code === CLOSE_SIGNED_OUT || code === CLOSE_REVOKED) {
    lastError = code === CLOSE_REVOKED ? 'session revoked' : 'signed out';
    clearSignIn()
      .catch(() => {})
      .then(() => setState(isHosted() ? 'waiting_bootstrap' : 'signed_out'));
    return;
  }
  if (code === CLOSE_SUPERSEDED) {
    lastError = 'another browser took over this project';
    boundSince = null;
    setState('superseded');
    return; // NO automatic reconnect — see header
  }
  if (state === 'signed_out' || state === 'superseded' || state === 'waiting_bootstrap') return;
  lastError = 'socket closed' + (code ? ' (' + code + (reason ? ' ' + reason : '') + ')' : '');
  boundSince = null;
  setState('disconnected');
  scheduleReconnect();
}

async function connect(_why?: string): Promise<void> {
  if (state === 'superseded') return;
  if (current) {
    const rs = current.ws.readyState;
    if (rs === WebSocket.CONNECTING || rs === WebSocket.OPEN) return;
    detach(current); // CLOSING/CLOSED leftovers
  }
  if (connectInFlight) return connectInFlight;
  connectInFlight = (async () => {
    cancelReconnect();
    const rec = await getChannel();
    // Hosted kind: the K-Desktop runtime bootstraps us through managed storage.
    // Precedence: our stored durable token for the SAME vm → an unspent
    // bootstrap token → wait for the runtime to write a fresh one.
    const boot = await getManagedBootstrap();
    let bindToken: string | null = rec && rec.token ? rec.token : null;
    let bindKind: 'attended' | 'hosted' = 'attended';
    let bindVm: string | null = null;
    let bindingWithBootstrap = false;
    if (boot) {
      setChannelMode('hosted');
      hostedVmId = boot.vm_id || null;
      bindKind = 'hosted';
      bindVm = boot.vm_id || null;
      const nowSec = Math.floor(Date.now() / 1000);
      const durableOk = !!(rec && rec.token && rec.kind === 'hosted' && rec.vm_id === boot.vm_id && (!rec.exp || rec.exp > nowSec + 60));
      if (durableOk) {
        bindToken = rec!.token;
      } else if (boot.token && (await bootstrapUsedAt()) !== (boot.issued_at || 0)) {
        bindToken = boot.token;
        bindingWithBootstrap = true;
      } else {
        bindToken = null;
      }
      if (!bindToken) {
        // Nothing usable: the runtime rewrites the policy on the next start/resume
        // and the managed-storage change wakes us. No backoff needed.
        lastError = 'waiting for a Kareenos bootstrap token';
        setState('waiting_bootstrap');
        return;
      }
    } else {
      setChannelMode('attended');
    }
    const url = boot && boot.ws_url ? boot.ws_url : await getServerUrl();
    if (!bindToken || !url) {
      if (channelCache === undefined && channelLoadError) {
        // Storage could not be read — we do not KNOW there is no token. Stay
        // recoverable instead of declaring signed_out (which stops all retries).
        setState('disconnected');
        scheduleReconnect();
        return;
      }
      setState('signed_out');
      return;
    }
    if (current) return; // a sign-in raced us
    setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e: any) {
      lastError = 'WebSocket() failed: ' + (e?.message || e);
      setState('disconnected');
      scheduleReconnect();
      return;
    }
    const c: Conn = { ws, bound: false, pingTimer: null, pongDeadline: null, connectTimer: null };
    current = c;
    c.connectTimer = setTimeout(() => {
      if (current !== c || c.bound) return;
      lastError = 'connect/bind timeout';
      detach(c);
      setState('disconnected');
      scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (current !== c) return;
      try {
        // Attended: exactly the frame it always was. Hosted: kind + vm_id ride
        // along (advisory — the token is authoritative on the server).
        ws.send(
          JSON.stringify(
            bindKind === 'hosted'
              ? { type: 'bind', token: bindToken, kind: 'hosted', vm_id: bindVm }
              : { type: 'bind', token: bindToken },
          ),
        );
      } catch (e) {
        /* connect timer covers it */
      }
    };
    ws.onmessage = (ev) => {
      if (current !== c) return;
      let frame: any;
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch (e) {
        return;
      }
      switch (frame.type) {
        case 'bind_ack':
          handleBindAck(c, frame, bindingWithBootstrap ? boot : null);
          break;
        case 'command':
          if (c.bound) handleCommand(frame as CommandEnvelope);
          break;
        case 'macro_ack':
          // Server verdict for a Learn Mode macro: dequeue + notify the popup.
          import('./learn-mode')
            .then((m) => m.handleMacroAck(frame))
            .catch(() => {});
          break;
        case 'pong':
          if (c.pongDeadline) {
            clearTimeout(c.pongDeadline);
            c.pongDeadline = null;
          }
          break;
        case 'token':
          // Live sliding renewal (server heartbeat) or the answer to our `renew`.
          persistRenewal(frame).catch(() => {});
          break;
        case 'superseded':
          supersededBy = frame.by || {};
          break; // the 4001 close that follows parks us
        case 'revoked':
          break; // the 4003 close that follows clears us
        default:
          break; // never treat anything else as a command
      }
    };
    ws.onclose = (ev) => {
      if (current !== c) return;
      handleClose(c, ev.code, ev.reason || '');
    };
    ws.onerror = () => {
      if (current !== c) return;
      lastError = 'socket error';
      // onclose follows and drives the reconnect.
    };
  })().finally(() => {
    connectInFlight = null;
  });
  return connectInFlight;
}

// ---------------------------------------------------------------------------
// Sign-in / sign-out
// ---------------------------------------------------------------------------
// Persist a sign-in and connect. Payload comes from the Kareenos connect page
// (relayed by the content script or externally_connectable). A fresh sign-in
// always wins: it replaces any current socket and leaves `superseded`.
async function storeSignIn(msg: any): Promise<void> {
  if (isHosted()) {
    // A Cloud Browser is bound by the platform, never by a connect-page sign-in.
    console.warn('[Kareenos] sign-in ignored: this extension runs in a Kareenos Cloud Browser');
    return;
  }
  supersededBy = null;
  lastError = null;
  backoffMs = BACKOFF_MIN_MS;
  cancelReconnect();
  if (current) detach(current);
  await persistChannel({
    token: msg.token,
    exp: typeof msg.exp === 'number' ? msg.exp : null,
    session_id: msg.session_id || null,
    renewable: true,
  });
  try {
    await chrome.storage.local.set({
      [BOUND_KEY]: {
        projectid: msg.projectid || null,
        accountid: msg.accountid || null,
        userid: msg.userid || null,
        session_id: msg.session_id || null,
        // Readable labels for the popup (fall back to ids when absent).
        project_name: msg.project_name || null,
        account_name: msg.account_name || null,
        user_name: msg.user_name || null,
      },
    });
  } catch (e) {
    /* labels are cosmetic */
  }
  setState('disconnected');
  await connect('sign-in');
}

// Sign out: local state is cleared FIRST and unconditionally (the socket being
// down is the normal case for a user who wants out). Then revoke server-side —
// over the socket if it is open, else via the public token-authenticated
// /browserchannel.signout endpoint. Best effort either way.
async function signOut(): Promise<void> {
  const rec = channelCache || (await getChannel());
  const c = current;
  cancelReconnect();
  supersededBy = null;
  await clearSignIn();
  setState('signed_out');
  let sentOverSocket = false;
  if (c && c.bound && c.ws.readyState === WebSocket.OPEN) {
    try {
      c.ws.send(JSON.stringify({ type: 'sign_out' }));
      sentOverSocket = true;
    } catch (e) {
      /* fall through to HTTP */
    }
    // Queued data is flushed before the close handshake; strip handlers so the
    // 4000 close cannot re-enter handleClose.
    setTimeout(() => detach(c), 500);
  } else if (c) {
    detach(c);
  }
  if (!sentOverSocket && rec?.token) {
    try {
      const api = await getApiUrl();
      if (api) {
        await fetch(api + '/browserchannel.signout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: JSON.stringify({ token: rec.token }) }),
        });
      }
    } catch (e) {
      /* best effort — the token also dies at its own exp */
    }
  }
}

// Public: called by the popup after sign-in stores a fresh token, or on demand.
export async function reconnectBrowserChannel() {
  if (state === 'superseded') return; // popup must use take-over
  if (current) detach(current);
  cancelReconnect();
  backoffMs = BACKOFF_MIN_MS;
  setState('disconnected');
  await connect('manual');
}

// Leave `superseded` on explicit user intent (or a fresh browser launch).
async function takeOver(): Promise<void> {
  if (state !== 'superseded') return connect('take-over');
  supersededBy = null;
  backoffMs = BACKOFF_MIN_MS;
  setState('disconnected');
  await connect('take-over');
}

// ---------------------------------------------------------------------------
// Init — every listener registered synchronously (MV3 requirement)
// ---------------------------------------------------------------------------
export function initBrowserChannelClient() {
  const nudge = (why: string) => () => {
    // Idempotent: returns immediately when a socket is connecting/open, and does
    // nothing in signed_out (no token) or superseded (user decision pending).
    if (state === 'superseded') return;
    connect(why);
  };

  // Backstop: fires even after the worker was evicted (which kills the ping loop
  // and the backoff timer). 0.5 = 30s on Chrome ≥120; older Chrome clamps to 1 min.
  try {
    // create() replaces the alarm and restarts its period; on a machine that wakes
    // the worker often, re-creating on every spin-up starved the backstop.
    Promise.resolve(chrome.alarms.get(ALARM_NAME))
      .then((existing) => {
        if (!existing) chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
      })
      .catch(() => {
        try {
          chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
        } catch (e) {
          /* ignore */
        }
      });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === ALARM_NAME) nudge('alarm')();
    });
  } catch (e) {
    /* alarms unavailable in some contexts */
  }

  // Browser launch: a fresh Chrome start is also the one signal strong enough to
  // leave `superseded` — the user is evidently using THIS profile now.
  try {
    chrome.runtime.onStartup.addListener(() => {
      if (state === 'superseded') {
        takeOver().catch(() => {});
      } else {
        connect('startup');
      }
    });
  } catch (e) {
    /* ignore */
  }
  try {
    chrome.runtime.onInstalled.addListener(() => connect('installed'));
  } catch (e) {
    /* ignore */
  }
  // Network back (weak signal — only flips for "no interface at all", but free).
  try {
    self.addEventListener('online', nudge('online'));
  } catch (e) {
    /* ignore */
  }
  // The user's own browsing wakes the worker; piggyback to re-bind within seconds
  // of them returning to the machine — exactly when an agent will be asked to act.
  try {
    chrome.tabs.onActivated.addListener(nudge('tab-activated'));
  } catch (e) {
    /* ignore */
  }
  try {
    chrome.webNavigation.onCommitted.addListener((d) => {
      if (d.frameId === 0) nudge('navigation')();
    });
  } catch (e) {
    /* ignore */
  }

  // Control + sign-in messages. `browser_channel_signin` is sent either by the
  // popup, by a content script relaying a window postMessage from the Kareenos
  // connect page, or directly by that page via externally_connectable — whichever
  // capture mechanism the deployment chooses (the connect-page origin is the open
  // config; see P1.4). Payload: { token, session_id?, projectid?, accountid?, … }.
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'browser_channel_get_state') {
        // Make sure the token record is loaded so has_token is truthful even on a
        // freshly spun-up worker.
        getChannel()
          .catch(() => null)
          .then(() => sendResponse(describeState()));
        return true;
      }
      if (msg.type === 'browser_channel_reconnect') {
        reconnectBrowserChannel().catch(() => {});
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'browser_channel_take_over') {
        takeOver().catch(() => {});
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'browser_channel_sign_out') {
        signOut()
          .catch(() => {})
          .then(() => sendResponse({ ok: true }));
        return true;
      }
      if (msg.type === 'browser_channel_signin' && msg.token) {
        storeSignIn(msg)
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: e?.message }));
        return true; // async response
      }
    });
  } catch (e) {
    /* ignore */
  }

  // Direct sign-in from the Kareenos connect page via externally_connectable
  // (parallel to the content-script relay). Same payload, same handler.
  try {
    chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === 'browser_channel_signin' && msg.token) {
        storeSignIn(msg)
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: e?.message }));
        return true;
      }
    });
  } catch (e) {
    /* ignore */
  }

  // Hosted kind: the K-Desktop runtime (re)writes our managed policy at every
  // start/resume and scrubs the token after we bound. Only a change while we are
  // NOT bound matters (a spent token is replaced by a fresh one). Listening on
  // the `managed` area only — the no-onChanged rule above is about `local`.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'managed' || !changes || !changes.kareenos_bootstrap) return;
      if (current && current.bound) return;
      cancelReconnect();
      backoffMs = BACKOFF_MIN_MS;
      if (state === 'waiting_bootstrap' || state === 'signed_out') setState('disconnected');
      connect('managed-change');
    });
  } catch (e) {
    /* ignore */
  }
  getManagedBootstrap()
    .then((b) => {
      setChannelMode(b ? 'hosted' : 'attended');
      if (b) hostedVmId = b.vm_id || null;
    })
    .catch(() => {});

  // Attempt an initial connection on spin-up (also covers the post-eviction wake:
  // whatever woke the worker, we re-bind right away instead of waiting for the alarm).
  connect('spin-up');
}
