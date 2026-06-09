/// <reference types="unplugin-icons/types/vue" />

// Kareenos Browser Channel build-time config (see .env.example).
interface ImportMetaEnv {
  /** wss/ws endpoint of the browser_channel_server, including the /browser-channel path. */
  readonly VITE_BROWSER_CHANNEL_URL?: string;
  /** Comma-separated match patterns for the Kareenos connect origin (content-script relay + externally_connectable). */
  readonly VITE_KAREENOS_MATCHES?: string;
  /** URL of the Kareenos connect page the popup's "Sign in" opens. */
  readonly VITE_KAREENOS_CONNECT_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  type Props = Record<string, never>;
  type RawBindings = Record<string, never>;
  const component: DefineComponent<Props, RawBindings, any>;
  export default component;
}
