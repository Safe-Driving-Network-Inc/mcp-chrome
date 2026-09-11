import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { config } from 'dotenv';
import { resolve } from 'path';
import Icons from 'unplugin-icons/vite';
import Components from 'unplugin-vue-components/vite';
import IconsResolver from 'unplugin-icons/resolver';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local') });

const CHROME_EXTENSION_KEY = process.env.CHROME_EXTENSION_KEY;
// Detect dev mode early for manifest-level switches
const IS_DEV = process.env.NODE_ENV !== 'production' && process.env.MODE !== 'production';

// Kareenos Browser Channel: origins of the Kareenos connect page that may sign
// the extension in directly via externally_connectable (parallel to the
// content-script relay). White-label builds set VITE_KAREENOS_MATCHES.
const KAREENOS_CONNECT_MATCHES = (
  process.env.VITE_KAREENOS_MATCHES ||
  'https://kareenos.com/*,https://www.kareenos.com/*,https://*.sdnvision.services/*'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  runner: {
    // Option 1: disable auto-start (recommended)
    disabled: true,

    // Option 2: to enable auto-start with an existing profile, uncomment the config below
    // chromiumArgs: [
    //   '--user-data-dir=' + homedir() + (process.platform === 'darwin'
    //     ? '/Library/Application Support/Google/Chrome'
    //     : process.platform === 'win32'
    //     ? '/AppData/Local/Google/Chrome/User Data'
    //     : '/.config/google-chrome'),
    //   '--remote-debugging-port=9222',
    // ],
  },
  manifest: {
    // Use environment variable for the key, fallback to undefined if not set
    key: CHROME_EXTENSION_KEY,
    default_locale: 'en',
    // Kareenos branding — literal (locale-independent) name/description.
    name: 'Kareenos Extension',
    // The browser channel keeps the MV3 service worker alive with WebSocket
    // traffic (a 20s ping); Chrome resets the worker's idle timer on WebSocket
    // activity only from 116 (Aug 2023). Older Chrome would drop the channel
    // every ~30s idle, so refuse to install there.
    minimum_chrome_version: '116',
    description:
      'Kareenos attended browser channel — lets your Kareenos agents read and act in your signed-in browser, on your behalf.',
    permissions: [
      // Kareenos Browser Channel: trimmed to what the bounded five + the wss client
      // actually use. Removed (zero usages after the off-scope-tool deletions):
      // nativeMessaging, webRequest, history, bookmarks, declarativeNetRequest.
      'tabs',
      'activeTab',
      'scripting',
      'contextMenus',
      'downloads',
      'webNavigation',
      'debugger',
      'offscreen',
      'storage',
      'alarms',
      // Allow programmatic control of Chrome Side Panel
      'sidePanel',
    ],
    host_permissions: ['<all_urls>'],
    // Let the Kareenos connect page sign the extension in directly (the
    // content-script relay is the parallel, opener-topology-independent path).
    externally_connectable: { matches: KAREENOS_CONNECT_MATCHES },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
    action: {
      default_popup: 'popup.html',
      default_title: 'Kareenos Extension',
      // Explicit toolbar icon (the Kareenos "K"); falls back to top-level icons.
      default_icon: {
        '16': 'icon/16.png',
        '32': 'icon/32.png',
        '48': 'icon/48.png',
        '128': 'icon/128.png',
      },
    },
    // Chrome Side Panel entry for workflow management
    // Ref: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
    side_panel: {
      default_path: 'sidepanel.html',
    },
    // Keyboard shortcuts for quick triggers
    commands: {
      // run_quick_trigger_1: {
      //   suggested_key: { default: 'Ctrl+Shift+1' },
      //   description: 'Run quick trigger 1',
      // },
      // run_quick_trigger_2: {
      //   suggested_key: { default: 'Ctrl+Shift+2' },
      //   description: 'Run quick trigger 2',
      // },
      // run_quick_trigger_3: {
      //   suggested_key: { default: 'Ctrl+Shift+3' },
      //   description: 'Run quick trigger 3',
      // },
      // open_workflow_sidepanel: {
      //   suggested_key: { default: 'Ctrl+Shift+O' },
      //   description: 'Open workflow sidepanel',
      // },
      toggle_web_editor: {
        suggested_key: { default: 'Ctrl+Shift+O', mac: 'Command+Shift+O' },
        description: 'Toggle Web Editor mode',
      },
      toggle_quick_panel: {
        suggested_key: { default: 'Ctrl+Shift+U', mac: 'Command+Shift+U' },
        description: 'Toggle Quick Panel AI Chat',
      },
    },
    web_accessible_resources: [
      {
        resources: [
          '/models/*', // allow access to everything under public/models/
          '/workers/*', // allow access to the worker files
          '/inject-scripts/*', // allow the helper files injected by content scripts
        ],
        matches: ['<all_urls>'],
      },
    ],
    // Note: the security policy below blocks the dev server's asset loading in development,
    // so enable it only in production and let WXT's defaults handle development.
    ...(IS_DEV
      ? {}
      : {
          cross_origin_embedder_policy: { value: 'require-corp' as const },
          cross_origin_opener_policy: { value: 'same-origin' as const },
          content_security_policy: {
            // Allow inline styles injected by Vite (compiled CSS) and data images used in UI thumbnails
            extension_pages:
              "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;",
          },
        }),
  },
  vite: (env) => ({
    plugins: [
      // TailwindCSS v4 Vite plugin – no PostCSS config required
      tailwindcss(),
      // Auto-register SVG icons as Vue components; all icons are bundled locally
      Components({
        dts: false,
        resolvers: [IconsResolver({ prefix: 'i', enabledCollections: ['lucide', 'mdi', 'ri'] })],
      }) as any,
      Icons({ compiler: 'vue3', autoInstall: false }) as any,
      // Ensure static assets are available as early as possible to avoid race conditions in dev
      // Copy workers/_locales/inject-scripts into the build output before other steps
      viteStaticCopy({
        targets: [
          {
            src: 'inject-scripts/*.js',
            dest: 'inject-scripts',
          },
          {
            src: ['workers/*'],
            dest: 'workers',
          },
          {
            src: '_locales/**/*',
            dest: '_locales',
          },
        ],
        // Use writeBundle so outDir exists for dev and prod
        hook: 'writeBundle',
        // Enable watch so changes to these files are reflected during dev
        watch: {
          // Use default patterns inferred from targets; explicit true enables watching
          // Vite plugin will watch src patterns and re-copy on change
        } as any,
      }) as any,
    ],
    build: {
      // Our build output needs to stay ES6-compatible
      target: 'es2015',
      // Emit sourcemaps outside production
      sourcemap: env.mode !== 'production',
      // Disable the gzip size report, since compressing large files can be slow
      reportCompressedSize: false,
      // Warn when a chunk exceeds 1500kb
      chunkSizeWarningLimit: 1500,
      // Minify production builds (esbuild — fast, ES2015-safe); keep dev readable.
      minify: env.mode === 'production' ? 'esbuild' : false,
    },
  }),
});
