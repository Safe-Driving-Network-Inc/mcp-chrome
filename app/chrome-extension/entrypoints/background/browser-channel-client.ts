// ============================================================================
// Kareenos Browser Channel — outbound wss client (P1.3)
// ============================================================================
// The ONLY new subsystem in the extension and the ONLY command source. It makes
// a single OUTBOUND wss://<server>/browser-channel connection — no listener, no
// localhost port, no native bridge. It binds identity with a short-lived token,
// then dispatches the bounded five to handleCallTool and returns result envelopes.
//
// Security spine:
//  * outbound only; no inbound command path other than this socket.
//  * page content is never interpreted as a command (we only run commands that
//    arrive as {type:'command'} frames over this socket).
//  * unknown/unsupported actions return status:'failed', never a guess.
//
// MV3-resilient: the service worker is ephemeral, so we never assume a held
// socket. A chrome.alarms heartbeat re-checks the connection and reconnects/
// re-binds after eviction. initBrowserChannelClient() is called on every SW
// spin-up (from background/index.ts).
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
const TOKEN_KEY = 'kareenos_channel_token';
const SERVER_URL_KEY = 'kareenos_server_url';
// Build-time default server (white-label override via .env; runtime override via
// chrome.storage.local 'kareenos_server_url'). Must include the /browser-channel path.
const DEFAULT_SERVER_URL =
  import.meta.env.VITE_BROWSER_CHANNEL_URL || 'wss://ap4.sdnvision.services:8092/browser-channel';

let socket: WebSocket | null = null;
let connecting = false;
let bound = false;

type ConnState = 'disconnected' | 'connecting' | 'bound' | 'error';
let state: ConnState = 'disconnected';

function setState(s: ConnState) {
  state = s;
  // Surface to the popup (best effort) so the UI reflects connection status.
  try { chrome.runtime.sendMessage({ type: 'browser_channel_state', state: s }).catch?.(() => {}); } catch (e) { /* no popup open */ }
}

export function getBrowserChannelState(): ConnState {
  return state;
}

async function getToken(): Promise<string | null> {
  try {
    const r = await chrome.storage.session.get(TOKEN_KEY);
    return r?.[TOKEN_KEY] || null;
  } catch (e) {
    return null;
  }
}

// Persist a sign-in: the short-lived token goes to session storage (never durable
// storage — no long-lived refresh token is kept), the bound context to local for
// the popup to display. The storage.onChanged watcher then triggers a reconnect.
async function storeSignIn(msg: any): Promise<void> {
  await chrome.storage.session.set({ [TOKEN_KEY]: msg.token });
  await chrome.storage.local.set({
    kareenos_bound: { projectid: msg.projectid || null, accountid: msg.accountid || null, session_id: msg.session_id || null },
  });
}

async function getServerUrl(): Promise<string> {
  try {
    const r = await chrome.storage.local.get(SERVER_URL_KEY);
    return r?.[SERVER_URL_KEY] || DEFAULT_SERVER_URL;
  } catch (e) {
    return DEFAULT_SERVER_URL;
  }
}

function send(obj: any) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try { socket.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }
}

// Execute one command: map action → tool, run it, adapt the result, reply.
async function handleCommand(cmd: CommandEnvelope) {
  if (!cmd || !cmd.command_id) return;
  if (!isSupportedAction(cmd.action)) {
    send({ type: 'result', ...failureEnvelope(cmd, 'UNSUPPORTED_ACTION', 'Unsupported action: ' + cmd.action) });
    return;
  }
  try {
    const call = resolveToolCall(cmd.action, cmd.args || {});
    const toolResult = await handleCallTool({ name: call.name, args: call.args });
    send({ type: 'result', ...toResultEnvelope(cmd.action, cmd, toolResult as any) });
  } catch (e: any) {
    send({ type: 'result', ...failureEnvelope(cmd, 'EXECUTION_ERROR', (e && e.message) || 'Tool execution failed') });
  }
}

async function connect() {
  if (connecting || (socket && socket.readyState === WebSocket.OPEN)) return;
  const token = await getToken();
  const url = await getServerUrl();
  if (!token || !url) {
    // Not signed in / not configured — stay disconnected, the heartbeat retries.
    setState('disconnected');
    return;
  }
  connecting = true;
  bound = false;
  setState('connecting');
  try {
    socket = new WebSocket(url);
  } catch (e) {
    connecting = false;
    setState('error');
    return;
  }

  socket.onopen = () => {
    connecting = false;
    send({ type: 'bind', token });
  };
  socket.onmessage = (ev) => {
    let frame: any;
    try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch (e) { return; }
    switch (frame.type) {
      case 'bind_ack':
        if (frame.ok) { bound = true; setState('bound'); }
        else { bound = false; setState('error'); try { socket?.close(); } catch (e) {} }
        break;
      case 'command':
        if (bound) handleCommand(frame as CommandEnvelope);
        break;
      case 'pong':
        break;
      default:
        break; // never treat anything else as a command
    }
  };
  socket.onclose = () => { socket = null; bound = false; connecting = false; if (state !== 'error') setState('disconnected'); };
  socket.onerror = () => { setState('error'); };
}

function disconnect() {
  try { socket?.close(); } catch (e) {}
  socket = null; bound = false; connecting = false;
  setState('disconnected');
}

// Public: called by the popup after sign-in stores a fresh token, or on Disconnect.
export async function reconnectBrowserChannel() { disconnect(); await connect(); }
export function disconnectBrowserChannel() { disconnect(); }

export function initBrowserChannelClient() {
  // Heartbeat: re-check the connection every minute (MV3 alarms min period).
  // On wake after SW eviction this fires and reconnects/re-binds.
  try {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === ALARM_NAME) connect();
    });
  } catch (e) { /* alarms unavailable in some contexts */ }

  // React to sign-in (token written to session storage) without waiting for the alarm.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && changes[TOKEN_KEY]) {
        if (changes[TOKEN_KEY].newValue) reconnectBrowserChannel();
        else disconnect();
      }
    });
  } catch (e) { /* ignore */ }

  // Control + sign-in messages. `browser_channel_signin` is sent either by the
  // popup, by a content script relaying a window postMessage from the Kareenos
  // connect page, or directly by that page via externally_connectable — whichever
  // capture mechanism the deployment chooses (the connect-page origin is the open
  // config; see P1.4). Payload: { token, session_id?, projectid?, accountid? }.
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'browser_channel_get_state') { sendResponse({ state }); return; }
      if (msg.type === 'browser_channel_reconnect') { reconnectBrowserChannel(); sendResponse({ ok: true }); return; }
      if (msg.type === 'browser_channel_disconnect') { disconnectBrowserChannel(); sendResponse({ ok: true }); return; }
      if (msg.type === 'browser_channel_signin' && msg.token) {
        storeSignIn(msg).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e?.message }));
        return true; // async response
      }
    });
  } catch (e) { /* ignore */ }

  // Direct sign-in from the Kareenos connect page via externally_connectable
  // (parallel to the content-script relay). Same payload, same handler.
  try {
    chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
      if (msg && msg.type === 'browser_channel_signin' && msg.token) {
        storeSignIn(msg).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e?.message }));
        return true;
      }
    });
  } catch (e) { /* ignore */ }

  // Attempt an initial connection on spin-up.
  connect();
}
