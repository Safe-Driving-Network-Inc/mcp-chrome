// Which kind of browser channel this extension is running: 'attended' (the
// user's own Chrome, signed in through the connect page) or 'hosted' (a
// Kareenos Cloud Browser / K-Desktop VM, bootstrapped through Chromium managed
// storage). Decided once per worker spin-up from chrome.storage.managed.
export type ChannelMode = 'attended' | 'hosted';
let mode: ChannelMode = 'attended';
export function setChannelMode(m: ChannelMode) { mode = m; }
export function getChannelMode(): ChannelMode { return mode; }
export function isHosted(): boolean { return mode === 'hosted'; }

export interface ManagedBootstrap {
  token?: string;
  vm_id?: string;
  ws_url?: string;
  api_url?: string;
  issued_at?: number;
  label?: { project_name?: string; account_name?: string; user_name?: string; projectid?: string; accountid?: string; userid?: string };
}

// Read the managed policy the K-Desktop runtime wrote (3rdparty.extensions.<id>
// .kareenos_bootstrap). Absent on every attended install. Never throws.
export async function getManagedBootstrap(): Promise<ManagedBootstrap | null> {
  try {
    const anyChrome = chrome as any;
    if (!anyChrome.storage || !anyChrome.storage.managed) return null;
    const got = await anyChrome.storage.managed.get('kareenos_bootstrap');
    const b = got && got.kareenos_bootstrap;
    if (!b || typeof b !== 'object' || !b.vm_id) return null;
    return b as ManagedBootstrap;
  } catch (e) {
    return null;
  }
}
