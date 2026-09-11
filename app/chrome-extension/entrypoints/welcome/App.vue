<script setup lang="ts">
import { onMounted, ref } from 'vue';

// Welcome / onboarding page shown after the extension is installed. It explains
// what the Kareenos Extension does and walks the user through connecting it to
// the Kareenos platform. Self-contained — no native host, no mcp-bridge.

const DEFAULT_CONNECT_URL =
  (import.meta.env.VITE_KAREENOS_CONNECT_URL as string) ||
  'https://kareenos.com/kareenos/connectextension';

const CONNECT_URL_KEY = 'kareenos_connect_url';

const logoUrl = ref<string>('');
const connectUrl = ref<string>(DEFAULT_CONNECT_URL);
const connected = ref<boolean>(false);
// 'signed_out' | 'disconnected' | 'connecting' | 'bound' | 'superseded'
const channelState = ref<string>('signed_out');
const boundAccount = ref<string>('');
const boundProject = ref<string>('');

const steps = [
  {
    title: 'Sign in to Kareenos',
    body: 'Open the Kareenos platform in this browser and log in to the account whose browser you want the agents to use.',
  },
  {
    title: 'Open the Connect page',
    body: 'Go to Kareenos → Connect Extension. The button below takes you straight there.',
  },
  {
    title: 'Authorize this browser',
    body: 'Pick the project and click “Connect this browser”. A secure sign-in binds this extension to your account and project — no passwords are stored in the extension.',
  },
  {
    title: 'You’re connected — and stay connected',
    body: 'The toolbar icon shows “Connected” with your project. Pin the Kareenos icon so you can always see the status. The connection survives browser restarts, sleep and network drops; only “Sign out” ends it. Your K-Agents can now read, click, fill and screenshot in this browser — and you stay in control.',
  },
];

async function resolveConnectUrl(): Promise<string> {
  try {
    const r = await chrome.storage.local.get(CONNECT_URL_KEY);
    return (r && r[CONNECT_URL_KEY]) || DEFAULT_CONNECT_URL;
  } catch {
    return DEFAULT_CONNECT_URL;
  }
}

async function refreshState() {
  try {
    const res: any = await chrome.runtime.sendMessage({ type: 'browser_channel_get_state' });
    channelState.value = (res && res.state) || 'signed_out';
    connected.value = !!res && res.state === 'bound';
  } catch {
    /* background may be asleep */
  }
  try {
    const r = await chrome.storage.local.get('kareenos_bound');
    const b = (r && r.kareenos_bound) || {};
    boundAccount.value = b.accountid || '';
    boundProject.value = b.projectid || '';
  } catch {
    /* ignore */
  }
}

function openConnect() {
  chrome.tabs.create({ url: connectUrl.value });
}

onMounted(async () => {
  try {
    logoUrl.value = chrome.runtime.getURL('icon/128.png');
  } catch {
    logoUrl.value = '/icon/128.png';
  }
  connectUrl.value = await resolveConnectUrl();
  await refreshState();
  // Live status updates from the background client.
  chrome.runtime.onMessage.addListener((msg: any) => {
    if (msg && msg.type === 'browser_channel_state') {
      channelState.value = msg.state;
      connected.value = msg.state === 'bound';
      if (msg.state === 'bound') refreshState();
    }
  });
});
</script>

<template>
  <div class="kw-page">
    <div class="kw-card">
      <header class="kw-head">
        <img v-if="logoUrl" :src="logoUrl" alt="Kareenos" class="kw-logo" />
        <div>
          <h1 class="kw-title">Welcome to the Kareenos Extension</h1>
          <p class="kw-sub">
            Let your Kareenos K-Agents work inside your own signed-in browser — reading pages,
            clicking, filling forms and taking screenshots, with you watching and in control.
          </p>
        </div>
      </header>

      <div v-if="connected" class="kw-banner kw-ok">
        ✓ Connected{{ boundProject ? ` — project ${boundProject}` : '' }}. You’re all set. You can
        close this tab. The extension stays connected across browser restarts until you sign out.
      </div>
      <div v-else-if="channelState === 'disconnected' || channelState === 'connecting'" class="kw-banner">
        Signed in — reconnecting to Kareenos… no action needed.
      </div>
      <div v-else-if="channelState === 'superseded'" class="kw-banner">
        Another browser is connected to the same project. Open the toolbar popup and click “Use this
        browser” to take the channel back here.
      </div>

      <ol class="kw-steps">
        <li v-for="(s, i) in steps" :key="i" class="kw-step">
          <span class="kw-num">{{ i + 1 }}</span>
          <div>
            <h3 class="kw-step-title">{{ s.title }}</h3>
            <p class="kw-step-body">{{ s.body }}</p>
          </div>
        </li>
      </ol>

      <div class="kw-actions">
        <button class="kw-btn kw-primary" @click="openConnect">Connect this browser →</button>
        <span class="kw-url">{{ connectUrl }}</span>
      </div>

      <section class="kw-security">
        <h4 class="kw-sec-title">Your security</h4>
        <ul>
          <li
            >The extension only makes an <strong>outbound, encrypted</strong> connection to Kareenos
            — it opens no local port and accepts no inbound connections.</li
          >
          <li
            >Every action is scoped to <strong>your account, project and user</strong>. The
            extension can never approve its own actions — sensitive clicks are approved
            <strong>server-side</strong>.</li
          >
          <li
            >Page content is treated as <strong>data only</strong>, never as instructions. You can
            sign out anytime from the toolbar popup — that revokes this browser's access
            immediately, server-side.</li
          >
        </ul>
      </section>

      <footer class="kw-foot">Kareenos • Attended Browser Channel</footer>
    </div>
  </div>
</template>

<style scoped>
/* Brand v5 tokens (indigo/violet/cyan on light slate). The extension is a
   standalone document — it cannot reach the platform's quasar.variables.scss /
   theme.scss — so the v5 values are mirrored here as local custom properties.
   Edit these, never the leaf rules below. Source of truth:
   docs/brandv5/kareenos design and style v5.md */
.kw-page {
  --kn-indigo: #4f46e5;
  --kn-indigo-dark: #4338ca;
  --kn-violet: #7c3aed;
  --kn-cyan: #06b6d4;
  --kn-ground: #f7f8fb;
  --kn-panel: #0b1220;
  --kn-surface: #ffffff;
  --kn-border: #e4e7ef;
  --kn-ink: #0b1220;
  --kn-ink-soft: #55607a;
  --kn-ink-faint: #8b95ad;

  min-height: 100vh;
  margin: 0;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  background: var(--kn-ground);
  padding: 40px 16px;
  font-family:
    'Manrope',
    system-ui,
    -apple-system,
    'Segoe UI',
    Roboto,
    sans-serif;
  color: var(--kn-ink);
}
.kw-card {
  width: 100%;
  max-width: 720px;
  background: var(--kn-surface);
  border: 1px solid var(--kn-border);
  border-radius: 16px;
  box-shadow: 0 10px 40px rgba(11, 18, 32, 0.07);
  padding: 32px;
}
.kw-head {
  display: flex;
  gap: 18px;
  align-items: flex-start;
}
.kw-logo {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  flex-shrink: 0;
}
.kw-title {
  margin: 2px 0 6px;
  font-family:
    'Space Grotesk',
    'Manrope',
    system-ui,
    -apple-system,
    sans-serif;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--kn-ink);
}
.kw-sub {
  margin: 0;
  font-size: 15px;
  line-height: 1.5;
  color: var(--kn-ink-soft);
}
.kw-banner {
  margin: 20px 0 0;
  padding: 12px 14px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
}
.kw-ok {
  background: #eaf6ec;
  color: #1f7a37;
  border: 1px solid #c7e7cf;
}
.kw-steps {
  list-style: none;
  margin: 24px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.kw-step {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.kw-num {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--kn-indigo);
  color: #fff;
  font-weight: 700;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.kw-step-title {
  margin: 3px 0 2px;
  font-size: 15px;
  font-weight: 600;
  color: var(--kn-ink);
}
.kw-step-body {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--kn-ink-soft);
}
.kw-actions {
  margin: 28px 0 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kw-btn {
  cursor: pointer;
  border: none;
  border-radius: 10px;
  padding: 14px 18px;
  font-size: 16px;
  font-weight: 600;
}
/* The single hero CTA is the one place the brand gradient is allowed; every
   other accent on the page is solid indigo (v5 rule: accent text is never a
   gradient). */
.kw-primary {
  background: linear-gradient(
    135deg,
    var(--kn-violet) 0%,
    var(--kn-indigo) 55%,
    var(--kn-cyan) 100%
  );
  color: #fff;
  box-shadow: 0 6px 18px rgba(79, 70, 229, 0.28);
}
.kw-primary:hover {
  filter: brightness(1.06);
}
.kw-url {
  font-size: 12px;
  color: var(--kn-ink-faint);
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}
.kw-security {
  margin: 28px 0 0;
  background: var(--kn-ground);
  border: 1px solid var(--kn-border);
  border-radius: 12px;
  padding: 16px 18px;
}
.kw-sec-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 700;
  color: var(--kn-ink);
}
.kw-security ul {
  margin: 0;
  padding-left: 18px;
}
.kw-security li {
  font-size: 13px;
  line-height: 1.6;
  color: var(--kn-ink-soft);
}
.kw-security strong {
  color: var(--kn-indigo);
  font-weight: 700;
}
.kw-foot {
  margin: 24px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--kn-ink-faint);
}
</style>
