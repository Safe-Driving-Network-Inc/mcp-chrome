// Kareenos Browser Channel — minimal popup (P1.5).
//
// This is a commanded target, not an app: the popup shows connection state and
// the bound account/project, and offers Sign in / Sign out. No automation UI.
// Deliberately framework-free (no Vue, no native-messaging, no agent theme).
//
// Truthfulness rule (2026-08-31): the popup never touches the token itself — the
// background owns it. `signed_out` means there is NO token (the account/project
// rows are greyed: they are a memory, not a session); `disconnected` means the
// token is there and the client is reconnecting by itself; `superseded` means
// another browser bound the same project and this one is parked until the user
// says "Use this browser".
import './style.css';

type ConnState = 'signed_out' | 'disconnected' | 'connecting' | 'bound' | 'superseded' | 'waiting_bootstrap';

const CONNECT_URL_KEY = 'kareenos_connect_url';
const DEFAULT_CONNECT_URL =
  import.meta.env.VITE_KAREENOS_CONNECT_URL || 'https://kareenos.com/kareenos/connectextension';

const STATE_LABEL: Record<ConnState, string> = {
  signed_out: 'Signed out',
  disconnected: 'Reconnecting…',
  connecting: 'Connecting…',
  bound: 'Connected',
  superseded: 'Another browser took over',
  waiting_bootstrap: 'Waiting for Kareenos…',
};

interface StateInfo {
  hosted?: boolean;
  vm_id?: string | null;
  state: ConnState;
  has_token?: boolean;
  exp?: number | null;
  renewable?: boolean;
  bound_since?: number | null;
  last_error?: string | null;
  superseded_by?: any;
  version?: string | null;
}

const app = document.getElementById('app')!;
app.innerHTML = `
  <div class="kc">
    <div class="kc-head"><img class="kc-mark" src="/icon/32.png" alt="" /><h1 id="kc-title">Kareenos Extension</h1><span class="kc-badge" id="kc-badge" hidden>Cloud Browser</span><span class="kc-dot" id="kc-dot"></span></div>
    <div class="kc-row"><span class="kc-k">Status</span><span class="kc-v" id="kc-status">…</span></div>
    <div class="kc-row"><span class="kc-k">Account</span><span class="kc-v" id="kc-account">—</span></div>
    <div class="kc-row"><span class="kc-k">Project</span><span class="kc-v" id="kc-project">—</span></div>
    <div class="kc-row"><span class="kc-k">User</span><span class="kc-v" id="kc-user">—</span></div>
    <div class="kc-actions">
      <button id="kc-signin" class="kc-btn kc-primary">Sign in</button>
      <button id="kc-takeover" class="kc-btn kc-primary" hidden>Use this browser</button>
      <button id="kc-disconnect" class="kc-btn">Sign out</button>
    </div>
    <div class="kc-learn">
      <div class="kc-learn-head">Learn mode</div>
      <input id="kc-learn-title" class="kc-input" type="text" maxlength="200"
             placeholder="e.g. how to post photo with text on linkedin" />
      <div class="kc-actions">
        <button id="kc-learn-btn" class="kc-btn">Start Learn Mode</button>
      </div>
      <p class="kc-note" id="kc-learn-note"></p>
    </div>
    <p class="kc-note" id="kc-note"></p>
    <p class="kc-foot" id="kc-foot"></p>
  </div>`;

const $ = (id: string) => document.getElementById(id)!;

let lastInfo: StateInfo = { state: 'signed_out' };

function fmtDate(epochSec: number): string {
  try {
    return new Date(epochSec * 1000).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch (e) {
    return '';
  }
}

function renderState(state: ConnState) {
  renderInfo({ ...lastInfo, state });
}

function renderInfo(info: StateInfo) {
  lastInfo = info;
  const state = info.state;
  $('kc-status').textContent = STATE_LABEL[state] || state;
  $('kc-dot').className = 'kc-dot kc-' + state;
  const hasToken = info.has_token !== false && state !== 'signed_out';
  const hosted = info.hosted === true;
  ($('kc-badge') as HTMLElement).hidden = !hosted;
  // No token ⇒ the identity rows are a memory of the last sign-in, not a session.
  document.querySelectorAll('.kc-row').forEach((el) => el.classList.toggle('kc-stale', !hasToken));
  ($('kc-signin') as HTMLButtonElement).hidden = hosted || (hasToken && state !== 'superseded');
  ($('kc-signin') as HTMLButtonElement).textContent = hasToken ? 'Sign in again' : 'Sign in';
  ($('kc-takeover') as HTMLButtonElement).hidden = hosted || state !== 'superseded';
  ($('kc-disconnect') as HTMLButtonElement).hidden = hosted || !hasToken;
  let note = '';
  if (hosted) {
    note =
      state === 'bound'
        ? 'Running in a Kareenos Cloud Browser — managed by the platform. Agents act here; take control from the live view in Kareenos.'
        : state === 'waiting_bootstrap'
          ? 'Running in a Kareenos Cloud Browser — waiting for the platform to hand over a bind token.'
          : 'Running in a Kareenos Cloud Browser — reconnecting to the platform.' + (info.last_error ? ' (' + info.last_error + ')' : '');
  } else if (state === 'bound') {
    note = 'Agents can act in this browser. Stays connected across restarts';
    if (info.renewable === false && info.exp) note += ' — sign in again before ' + fmtDate(info.exp);
    else if (info.exp) note += '; the sign-in renews itself (valid until ' + fmtDate(info.exp) + ')';
    note += '.';
  } else if (state === 'disconnected' || state === 'connecting') {
    note = 'Signed in — reconnecting automatically.' + (info.last_error ? ' (' + info.last_error + ')' : '');
  } else if (state === 'superseded') {
    const by = info.superseded_by && info.superseded_by.display_name;
    note =
      (by ? by : 'Another browser') +
      ' connected to the same project. Click “Use this browser” to take the channel back here.';
  } else if (state === 'signed_out') {
    note = info.last_error
      ? 'Sign in to connect (' + info.last_error + ').'
      : 'Sign in to connect this browser to a Kareenos project.';
  }
  $('kc-note').textContent = note;
  ($('kc-foot') as HTMLElement).dataset.vm = info.vm_id || '';
  // Support footer: version + token expiry + last error — what a "why am I
  // signed out?" report needs and what nobody can see otherwise.
  let version = info.version || '';
  if (!version) {
    try {
      version = chrome.runtime.getManifest().version;
    } catch (e) {
      version = '';
    }
  }
  const bits: string[] = [];
  if (version) bits.push('v' + version);
  if (hasToken && info.exp) bits.push('token until ' + fmtDate(info.exp));
  if (info.last_error && state !== 'bound') bits.push(info.last_error);
  $('kc-foot').textContent = bits.join(' · ');
  $('kc-foot').title = info.last_error || '';
}

function shorten(s: string): string {
  return s && s.length > 22 ? s.slice(0, 19) + '…' : s;
}

async function renderBound() {
  try {
    const r = await chrome.storage.local.get('kareenos_bound');
    const b = r?.kareenos_bound || {};
    // Prefer readable names; fall back to the id (shortened) when a name is absent.
    $('kc-account').textContent = b.account_name || (b.accountid ? shorten(b.accountid) : '—');
    $('kc-project').textContent = b.project_name || (b.projectid ? shorten(b.projectid) : '—');
    $('kc-user').textContent = b.user_name || (b.userid ? shorten(b.userid) : '—');
    // Full value on hover for the ids/names.
    $('kc-account').title = b.account_name || b.accountid || '';
    $('kc-project').title = b.project_name || b.projectid || '';
    $('kc-user').title = b.user_name || b.userid || '';
  } catch (e) {
    /* ignore */
  }
}

async function getConnectUrl(): Promise<string> {
  try {
    const r = await chrome.storage.local.get(CONNECT_URL_KEY);
    return r?.[CONNECT_URL_KEY] || DEFAULT_CONNECT_URL;
  } catch (e) {
    return DEFAULT_CONNECT_URL;
  }
}

// Sign in: open the Kareenos connect page (where the logged-in user authorizes
// this extension). That page calls /superos.browser_channel_link_start and the
// callback posts the token, which the content-script relay forwards to background.
$('kc-signin').addEventListener('click', async () => {
  const url = await getConnectUrl();
  if (!url) {
    $('kc-note').textContent = 'No connect URL configured (set kareenos_connect_url).';
    return;
  }
  chrome.tabs.create({ url });
  window.close();
});

// Sign out: the background clears the token (locally first, then revokes the
// session server-side over the socket or the HTTP fallback). The popup only asks.
$('kc-disconnect').addEventListener('click', async () => {
  $('kc-note').textContent = 'Signing out…';
  const res: any = await chrome.runtime
    .sendMessage({ type: 'browser_channel_sign_out' })
    .catch(() => null);
  if (res && res.ok) {
    renderInfo({ state: 'signed_out', has_token: false, last_error: null, version: lastInfo.version });
  } else {
    // The background did not confirm — do not pretend we are signed out.
    $('kc-note').textContent = 'Sign-out request did not go through — try again.';
    refreshInfo();
  }
});

// Take the channel back from another browser bound to the same project.
$('kc-takeover').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'browser_channel_take_over' }).catch(() => null);
  renderInfo({ ...lastInfo, state: 'connecting', superseded_by: null });
});

// ---------------------------------------------------------------------------
// Learn Mode: name the session, demonstrate the task by hand, Stop & Save.
// The recording ships upstream as a macro agents replay via get_browser_macro.
// ---------------------------------------------------------------------------
let learnActive = false;

function renderLearn(active: boolean, note?: string) {
  learnActive = active;
  $('kc-learn-btn').textContent = active ? 'Stop & Save' : 'Start Learn Mode';
  $('kc-learn-btn').className = active ? 'kc-btn kc-recording' : 'kc-btn';
  ($('kc-learn-title') as HTMLInputElement).disabled = active;
  if (note !== undefined) $('kc-learn-note').textContent = note;
}

$('kc-learn-btn').addEventListener('click', async () => {
  if (!learnActive) {
    const title = ($('kc-learn-title') as HTMLInputElement).value.trim();
    if (!title) {
      $('kc-learn-note').textContent =
        'Name the session first (this is the title agents search for).';
      return;
    }
    const res: any = await chrome.runtime
      .sendMessage({ type: 'learn_start', title })
      .catch(() => null);
    if (res && res.success) {
      renderLearn(true, 'Recording… perform the task by hand, then come back and Stop & Save.');
    } else {
      $('kc-learn-note').textContent = (res && res.error) || 'Could not start recording.';
    }
  } else {
    const res: any = await chrome.runtime.sendMessage({ type: 'learn_stop' }).catch(() => null);
    if (res && res.success) {
      renderLearn(false, 'Saving ' + (res.step_count || 0) + ' steps…');
    } else {
      renderLearn(false, (res && res.error) || 'Could not save the recording.');
    }
  }
});

async function renderLearnStatus() {
  const res: any = await chrome.runtime.sendMessage({ type: 'learn_status' }).catch(() => null);
  if (!res || !res.success) return;
  if (res.learn) {
    ($('kc-learn-title') as HTMLInputElement).value = res.learn.title || '';
    renderLearn(true, 'Recording "' + (res.learn.title || '') + '"…');
  } else if (res.pending > 0) {
    renderLearn(
      false,
      res.pending + ' recording(s) waiting for the server — will send when connected.',
    );
  }
}

// Live state updates pushed by the background client. Re-query the full info
// so exp/last_error stay accurate (the push carries only the state).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'browser_channel_state') {
    renderState(msg.state);
    refreshInfo();
  }
  if (msg && msg.type === 'learn_macro_ack') {
    $('kc-learn-note').textContent = msg.ok
      ? 'Saved ✓ — agents can now fetch this macro by title.'
      : 'Server rejected the recording' + (msg.reason ? ' (' + msg.reason + ')' : '') + '.';
  }
});

async function queryState(): Promise<StateInfo | null> {
  const res: any = await chrome.runtime
    .sendMessage({ type: 'browser_channel_get_state' })
    .catch(() => null);
  return res && res.state ? (res as StateInfo) : null;
}

// A missed message is NOT "signed out": the service worker may simply be waking
// up. Retry briefly and say so; only the background's own answer paints a state.
async function refreshInfo(): Promise<StateInfo> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const info = await queryState();
    if (info) {
      renderInfo(info);
      return info;
    }
    $('kc-status').textContent = 'Waking up…';
    $('kc-dot').className = 'kc-dot kc-connecting';
    await new Promise((r) => setTimeout(r, 1000));
  }
  $('kc-status').textContent = 'Not responding';
  $('kc-dot').className = 'kc-dot kc-disconnected';
  $('kc-note').textContent =
    'The extension did not answer. Open chrome://extensions and press Reload on the Kareenos card.';
  return lastInfo;
}

// Initial paint — and if we hold a token but are not bound, nudge the background
// to reconnect right now rather than waiting for its next alarm tick.
refreshInfo().then((info) => {
  if (info.has_token && info.state !== 'bound' && info.state !== 'superseded' && info.state !== 'connecting') {
    chrome.runtime.sendMessage({ type: 'browser_channel_reconnect' }).catch(() => {});
  }
});
renderBound();
renderLearnStatus();
