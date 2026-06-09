// Kareenos Browser Channel — sign-in token relay content script (P1.4).
//
// Runs on the configured Kareenos origin(s). The sign-in callback page
// (served by the backend) posts a window message
//   { source: 'kareenos-browser-channel', ok: true, data: { token, session_id, projectid } }
// This script captures it and relays it to the background, which stores the
// short-lived token and connects. This is the robust capture path (independent
// of opener topology); externally_connectable is a parallel direct path.
//
// Origin is build-time config: VITE_KAREENOS_MATCHES (comma-separated match
// patterns). White-label builds set it to the partner's Kareenos origin.
// Default targets the platform domain + localhost for dev.

const MATCHES = (import.meta.env.VITE_KAREENOS_MATCHES || 'https://*.sdnvision.services/*')
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean);

export default defineContentScript({
  matches: MATCHES,
  main() {
    window.addEventListener('message', (event: MessageEvent) => {
      // Identify the sign-in message by its source MARKER, not event.source: the
      // callback page may post to window.opener (this page is the opener), in which
      // case event.source is the popup window, not `window`. The content script
      // only runs on trusted matched origins, and the token is re-verified
      // server-side on bind, so the marker is a safe trigger.
      const d: any = event.data;
      if (!d || d.source !== 'kareenos-browser-channel' || d.ok !== true) return;
      const payload = d.data || {};
      if (!payload.token) return;
      chrome.runtime
        .sendMessage({
          type: 'browser_channel_signin',
          token: payload.token,
          session_id: payload.session_id || null,
          projectid: payload.projectid || null,
          accountid: payload.accountid || null,
        })
        .catch(() => {
          /* background may be waking; the storage watcher will still pick it up if re-sent */
        });
    });
  },
});
