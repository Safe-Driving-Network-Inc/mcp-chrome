// Kareenos Browser Channel — minimal popup (P1.5).
//
// This is a commanded target, not an app: the popup shows connection state and
// the bound account/project, and offers Sign in / Disconnect. No automation UI.
// Deliberately framework-free (no Vue, no native-messaging, no agent theme).
import './style.css';

type ConnState = 'disconnected' | 'connecting' | 'bound' | 'error';

const CONNECT_URL_KEY = 'kareenos_connect_url';
const TOKEN_KEY = 'kareenos_channel_token';
const DEFAULT_CONNECT_URL =
  import.meta.env.VITE_KAREENOS_CONNECT_URL || 'https://kareenos.com/kareenos/connectextension';

const STATE_LABEL: Record<ConnState, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  bound: 'Connected',
  error: 'Error',
};

const app = document.getElementById('app')!;
app.innerHTML = `
  <div class="kc">
    <div class="kc-head"><img class="kc-mark" src="/icon/32.png" alt="" /><h1 id="kc-title">Kareenos Extension</h1><span class="kc-dot" id="kc-dot"></span></div>
    <div class="kc-row"><span class="kc-k">Status</span><span class="kc-v" id="kc-status">…</span></div>
    <div class="kc-row"><span class="kc-k">Account</span><span class="kc-v" id="kc-account">—</span></div>
    <div class="kc-row"><span class="kc-k">Project</span><span class="kc-v" id="kc-project">—</span></div>
    <div class="kc-row"><span class="kc-k">User</span><span class="kc-v" id="kc-user">—</span></div>
    <div class="kc-actions">
      <button id="kc-signin" class="kc-btn kc-primary">Sign in</button>
      <button id="kc-disconnect" class="kc-btn">Disconnect</button>
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
  </div>`;

const $ = (id: string) => document.getElementById(id)!;

function renderState(state: ConnState) {
  $('kc-status').textContent = STATE_LABEL[state] || state;
  $('kc-dot').className = 'kc-dot kc-' + state;
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

$('kc-disconnect').addEventListener('click', async () => {
  try {
    await chrome.storage.session.remove(TOKEN_KEY);
  } catch (e) {
    /* ignore */
  }
  chrome.runtime.sendMessage({ type: 'browser_channel_disconnect' }).catch(() => {});
  renderState('disconnected');
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

// Live state updates pushed by the background client.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'browser_channel_state') renderState(msg.state);
  if (msg && msg.type === 'learn_macro_ack') {
    $('kc-learn-note').textContent = msg.ok
      ? 'Saved ✓ — agents can now fetch this macro by title.'
      : 'Server rejected the recording' + (msg.reason ? ' (' + msg.reason + ')' : '') + '.';
  }
});

// Initial paint.
chrome.runtime
  .sendMessage({ type: 'browser_channel_get_state' })
  .then((res: any) => renderState((res && res.state) || 'disconnected'))
  .catch(() => renderState('disconnected'));
renderBound();
renderLearnStatus();
