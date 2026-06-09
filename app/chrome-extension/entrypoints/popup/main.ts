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
  import.meta.env.VITE_KAREENOS_CONNECT_URL ||
  'https://ap4.sdnvision.services:8443/kareenos/connectextension';

const STATE_LABEL: Record<ConnState, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  bound: 'Connected',
  error: 'Error',
};

const app = document.getElementById('app')!;
app.innerHTML = `
  <div class="kc">
    <div class="kc-head"><span class="kc-dot" id="kc-dot"></span><h1 id="kc-title">Kareenos Extension</h1></div>
    <div class="kc-row"><span class="kc-k">Status</span><span class="kc-v" id="kc-status">…</span></div>
    <div class="kc-row"><span class="kc-k">Account</span><span class="kc-v" id="kc-account">—</span></div>
    <div class="kc-row"><span class="kc-k">Project</span><span class="kc-v" id="kc-project">—</span></div>
    <div class="kc-actions">
      <button id="kc-signin" class="kc-btn kc-primary">Sign in</button>
      <button id="kc-disconnect" class="kc-btn">Disconnect</button>
    </div>
    <p class="kc-note" id="kc-note"></p>
  </div>`;

const $ = (id: string) => document.getElementById(id)!;

function renderState(state: ConnState) {
  $('kc-status').textContent = STATE_LABEL[state] || state;
  $('kc-dot').className = 'kc-dot kc-' + state;
}

async function renderBound() {
  try {
    const r = await chrome.storage.local.get('kareenos_bound');
    const b = r?.kareenos_bound || {};
    $('kc-account').textContent = b.accountid || '—';
    $('kc-project').textContent = b.projectid || '—';
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

// Live state updates pushed by the background client.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'browser_channel_state') renderState(msg.state);
});

// Initial paint.
chrome.runtime
  .sendMessage({ type: 'browser_channel_get_state' })
  .then((res: any) => renderState((res && res.state) || 'disconnected'))
  .catch(() => renderState('disconnected'));
renderBound();
