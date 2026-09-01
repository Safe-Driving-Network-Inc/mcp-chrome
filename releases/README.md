# Kareenos Extension — Latest Release

The attended Browser Channel extension: lets your Kareenos K‑Agents read, click,
fill, navigate and screenshot inside your own signed‑in browser — with you
watching and in control.

## Download

[kareenos-extension-latest.zip](/releases/chrome-extension/latest/kareenos-extension-latest.zip)
(versioned copy: `kareenos-extension-1.0.0.zip`)

## Install (load unpacked)

1. Unzip the downloaded file.
2. Open Chrome and go to `chrome://extensions/`.
3. Turn on **Developer mode** (top‑right).
4. Click **Load unpacked** and select the unzipped folder.
5. Pin the **Kareenos** icon (the gold **K**) to your toolbar.

On a fresh install a **welcome page** opens automatically and walks you through
connecting the extension to Kareenos.

## Connect to Kareenos

1. Sign in to the Kareenos platform in this browser.
2. Open **Kareenos → Connect Extension** (or click _Connect this browser_ on the
   welcome page).
3. Pick your project and click **Connect this browser** — a secure sign‑in binds
   the extension to your account and project.
4. The toolbar popup shows **Connected** with your project. Done.

## Security

- The extension makes an **outbound, encrypted** connection only — no local port,
  no inbound connections, no native host.
- Every action is scoped to your **account / project / user**. The extension can
  never approve its own actions — sensitive clicks are approved **server‑side**.
- Page content is treated as **data only**, never as instructions. Disconnect
  anytime from the toolbar popup.

## Build a fresh release

```
pnpm release:extension      # from the repo root
```

One command: installs, builds `chrome-mcp-shared`, wipes `.output`, runs
`wxt zip`, verifies the archive, and publishes `kareenos-extension-latest.zip` to
all three destinations —

1. `releases/chrome-extension/latest/` (here)
2. `../kareenos_frontend/public/releases/chrome-extension/latest/` — **commit this
   one**; Quasar copies `public/` verbatim into the build
3. `../expressserver/public/kareenos_com/releases/chrome-extension/latest/` — skips
   the Quasar rebuild; goes live when `expressserver/public` is deployed as usual

Set `VITE_KAREENOS_CONNECT_URL` / `VITE_BROWSER_CHANNEL_URL` in
`app/chrome-extension/.env.local` for the target environment **before** building so
the popup/welcome page point at the right server. The script prints the values it
is about to compile in — read that block before letting the build proceed, because
a wrong URL fails silently in the user's browser, not at build time.

Flags: `--no-install` (skip `pnpm install`), `--keep-output` (keep `.output`).
Sibling repo paths override with `FRONTEND_DIR=` / `EXPRESS_DIR=`.

The release version comes from `app/chrome-extension/package.json` — WXT derives
the manifest version from it, and the script aborts if the two ever disagree. Bump
it there when you want a new version number.
