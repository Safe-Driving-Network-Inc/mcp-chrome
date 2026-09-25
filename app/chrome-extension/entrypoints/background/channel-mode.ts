// Which kind of browser channel this extension is running: 'attended' (the
// user's own Chrome, signed in through the connect page) or 'hosted' (a
// Kareenos Cloud Browser / K-Desktop VM, bootstrapped through Chromium managed
// storage). Decided from chrome.storage.managed — re-read on every connect
// attempt, because Chrome fills the managed area for a freshly force-installed
// extension some time AFTER the worker's first spin-up.
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

// What the last managed read returned, in a shape safe to put in the trail
// (never the token itself).
export interface ManagedReadInfo {
  ok: boolean;          // the API call itself succeeded
  keys: string[];       // top-level keys Chrome handed back
  vm_id: string | null; // from kareenos_bootstrap, when present
  has_token: boolean;
  issued_at: number | null;
  err: string | null;
}
let lastRead: ManagedReadInfo = { ok: false, keys: [], vm_id: null, has_token: false, issued_at: null, err: 'not read yet' };
export function lastManagedRead(): ManagedReadInfo { return lastRead; }

// Read the managed policy the K-Desktop runtime wrote (3rdparty.extensions.<id>
// .kareenos_bootstrap). Absent on every attended install. Never throws.
export async function getManagedBootstrap(): Promise<ManagedBootstrap | null> {
  try {
    const anyChrome = chrome as any;
    if (!anyChrome.storage || !anyChrome.storage.managed) {
      lastRead = { ok: false, keys: [], vm_id: null, has_token: false, issued_at: null, err: 'storage.managed unavailable' };
      return null;
    }
    const got = await anyChrome.storage.managed.get('kareenos_bootstrap');
    const b = got && got.kareenos_bootstrap;
    lastRead = {
      ok: true,
      keys: got && typeof got === 'object' ? Object.keys(got) : [],
      vm_id: b && typeof b === 'object' && b.vm_id ? String(b.vm_id) : null,
      has_token: !!(b && typeof b === 'object' && typeof b.token === 'string' && b.token),
      issued_at: b && typeof b === 'object' && typeof b.issued_at === 'number' ? b.issued_at : null,
      err: null,
    };
    if (!b || typeof b !== 'object' || !b.vm_id) return null;
    return b as ManagedBootstrap;
  } catch (e: any) {
    lastRead = { ok: false, keys: [], vm_id: null, has_token: false, issued_at: null, err: String((e && e.message) || e) };
    return null;
  }
}
