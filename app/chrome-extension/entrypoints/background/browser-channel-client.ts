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
//    automatic reconnect, so two Chrome profiles never flap.
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

// bind_ack reasons after which retrying the SAME token can never succeed.
const TERMINAL_REASONS = new Set([
  'MISSING_TOKEN',
  'INVALID_TOKEN',
  'EXPIRED',
  'INCOMPLETE_TENANT',
  'REVOKED',
  'MAX_AGE',
]);
// Server close codes (mirrored in browser_channel_server.js / browser-channel-envelope.md).
const CLOSE_SIGNED_OUT = 4000;
const CLOSE_SUPERSEDED = 4001;
const CLOSE_REVOKED = 4003;

export type ConnState = 'signed_out' | 'disconnected' | 'connecting' | 'bound' | 'superseded';

interface ChannelRecord {
  token: string;
  exp?: number | null; // epoch seconds
  session_id?: string | null;
  renewable?: boolean;
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
  return {
    state,
    has_token: !!(rec && rec.token),
    exp: (rec && rec.exp) || null,
    renewable: rec ? rec.renewable !== false : false,
    bound_since: boundSince,
    last_error: lastError,
    superseded_by: supersededBy,
  };
}

// ---------------------------------------------------------------------------
// Token record (storage.local) — this module is the only writer.
// ---------------------------------------------------------------------------
async function getChannel(): Promise<ChannelRecord | null> {
  if (channelCache !== undefined) return channelCache;
  let rec: ChannelRecord | null = null;
  try {
    const r = await chrome.storage.local.get(CHANNEL_KEY);
    const v = r?.[CHANNEL_KEY];
    if (v && typeof v.token === 'string' && v.token) rec = v as ChannelRecord;
  } catch (e) {
    /* ignore */
  }
  if (!rec) {
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
  channelCache = rec;
  return rec;
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
async function executeCommand(cmd: CommandEnvelope) {
  try {
    const call = resolveToolCall(cmd);
    const toolResult = await handleCallTool({ name: call.name, args: call.args });
    send({ type: 'result', ...toResultEnvelope(cmd.action, cmd, toolResult as any) });
  } catch (e: any) {
    send({
      type: 'result',
      ...failureEnvelope(cmd, 'EXECUTION_ERROR', (e && e.message) || 'Tool execution failed'),
    });
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
    if (c.ws.readyState !== WebSocket.OPEN) return;
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

function handleBindAck(c: Conn, frame: any) {
  if (c.connectTimer) {
    clearTimeout(c.connectTimer);
    c.connectTimer = null;
  }
  if (frame.ok) {
    const done = (async () => {
      if (typeof frame.token === 'string' && frame.token) {
        // Sliding renewal — persist BEFORE declaring bound; a persist failure keeps
        // the old (still valid) token in memory.
        await persistChannel({
          token: frame.token,
          exp: typeof frame.exp === 'number' ? frame.exp : null,
          session_id: channelCache?.session_id || null,
          renewable: frame.renewable !== false,
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
    })();
    done.catch(() => {}).then(() => {
      if (current !== c) return;
      c.bound = true;
      boundSince = Date.now();
      backoffMs = BACKOFF_MIN_MS;
      lastError = null;
      setState('bound');
      startPing(c);
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
      .then(() => setState('signed_out'));
    return;
  }
  if (code === CLOSE_SUPERSEDED) {
    lastError = 'another browser took over this project';
    boundSince = null;
    setState('superseded');
    return; // NO automatic reconnect — see header
  }
  if (state === 'signed_out' || state === 'superseded') return;
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
    const url = await getServerUrl();
    if (!rec || !rec.token || !url) {
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
        ws.send(JSON.stringify({ type: 'bind', token: rec.token }));
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
          handleBindAck(c, frame);
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
  supersededBy = null;
  lastError = null;
  backoffMs = BACKOFF_MIN_MS;
  cancelReconnect();
  if (current) detach(current);
  await persistChannel({
    token: msg.token,
    exp: null,
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
export function disconnectBrowserChannel() {
  signOut().catch(() => {});
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
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
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
      if (msg.type === 'browser_channel_sign_out' || msg.type === 'browser_channel_disconnect') {
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

  // Attempt an initial connection on spin-up (also covers the post-eviction wake:
  // whatever woke the worker, we re-bind right away instead of waiting for the alarm).
  connect('spin-up');
}
