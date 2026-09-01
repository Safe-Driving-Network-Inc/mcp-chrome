#!/usr/bin/env bash
# =============================================================================
# build-extension-release.sh — build the Kareenos Extension and publish the zip
#
# One command replaces the five-step manual release ritual. It builds the WXT/MV3
# extension, packages it, verifies the artifact, and lands ONE file —
# kareenos-extension-latest.zip — on the three paths that matter:
#
#   1. mcp-chrome/releases/chrome-extension/latest/            (repo convention)
#   2. kareenos_frontend/public/releases/chrome-extension/...  (committed; rides
#      the Quasar build, which copies public/ verbatim into dist/spa/)
#   3. expressserver/public/kareenos_com/releases/...          (skips the Quasar
#      rebuild — this is exactly what `npm run publish:web` would have copied)
#
# Result: once expressserver/public is deployed the usual way,
# https://kareenos.com/releases/chrome-extension/latest/kareenos-extension-latest.zip
# resolves — the URL releases/README.md has always advertised and nothing served.
#
# Three failure modes this script exists to prevent:
#   - Forgetting `chrome-mcp-shared`. It is a workspace:* dep that publishes only
#     compiled dist/ and is imported by ~20 extension files. Stale dist = broken
#     build, or worse, a silently stale one.
#   - Running `wxt zip` from the repo root. wxt.config.ts resolves dotenv against
#     process.cwd(), so a root-run build bakes in FALLBACK server URLs and fails
#     only later, in the user's browser. Hence the `cd` before the build.
#   - Hand-renaming chrome-mcp-server-<v>-chrome.zip -> kareenos-extension-latest.zip.
#
# Usage:
#   pnpm release:extension                  # build + copy everywhere. That's it.
#   pnpm release:extension --install        # also `pnpm install` first (lockfile changed)
#
# Env overrides:
#   FRONTEND_DIR   default ../kareenos_frontend
#   EXPRESS_DIR    default ../expressserver
# =============================================================================
set -euo pipefail

# ── locate the repo root from this script, so cwd never matters ──────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
EXT_DIR="$REPO_ROOT/app/chrome-extension"

FRONTEND_DIR="${FRONTEND_DIR:-$REPO_ROOT/../kareenos_frontend}"
EXPRESS_DIR="${EXPRESS_DIR:-$REPO_ROOT/../expressserver}"

ARTIFACT_NAME="kareenos-extension-latest.zip"
REL_SUBPATH="releases/chrome-extension/latest"
PUBLIC_URL="https://kareenos.com/${REL_SUBPATH}/${ARTIFACT_NAME}"

# Installs are OFF by default: deps are already present and this machine is a dev
# PC where installs are avoided. Opt in with --install after a lockfile change.
DO_INSTALL=0
KEEP_OUTPUT=0

# ── pretty output ────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''
fi

step() { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
dim()  { printf '    %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok()   { printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!!%s  %s%s%s\n' "$C_YELLOW" "$C_RESET" "$C_YELLOW" "$*" "$C_RESET" >&2; }
die()  { printf '\n%sERROR:%s %s\n\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
${C_BOLD}build-extension-release.sh${C_RESET} — build + publish the Kareenos Extension zip

Builds the extension and copies kareenos-extension-latest.zip to all three
release directories. No flags needed for a normal release.

  --install        run \`pnpm install --frozen-lockfile\` first (lockfile changed)
  --keep-output    do not wipe app/chrome-extension/.output before building
  -h, --help       this text

Env: FRONTEND_DIR (default ../kareenos_frontend), EXPRESS_DIR (default ../expressserver)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)     DO_INSTALL=1 ;;
    --no-install)  DO_INSTALL=0 ;;   # accepted for compatibility; already the default
    --keep-output) KEEP_OUTPUT=1 ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

# ── tmp-file cleanup, so a failed copy never leaves junk in a served dir ──────
TMP_FILES=()
cleanup() {
  local f
  for f in ${TMP_FILES+"${TMP_FILES[@]}"}; do
    rm -f "$f" 2>/dev/null || true
  done
  # MUST end truthy: an EXIT trap's last status overrides the script's exit code,
  # so a failing test here would report a successful release as exit 1.
  return 0
}
trap cleanup EXIT

# =============================================================================
# 1. Preflight — fail fast, before anything is built or written
# =============================================================================
step "Preflight"

command -v pnpm  >/dev/null 2>&1 || die "pnpm not found on PATH. This is a pnpm workspace (lockfileVersion 6.0 -> pnpm 8.x)."
command -v node  >/dev/null 2>&1 || die "node not found on PATH."
command -v unzip >/dev/null 2>&1 || die "unzip not found on PATH (needed to verify the artifact before publishing)."

info "node    $(node --version)"
info "pnpm    $(pnpm --version)"
info "repo    $REPO_ROOT"

[[ -d "$EXT_DIR" ]] || die "extension package not found at $EXT_DIR"

# The sibling repos must already exist. A missing directory means a wrong path,
# not a first run — never silently mkdir a vhost tree.
[[ -d "$FRONTEND_DIR/public" ]] \
  || die "frontend public/ not found at $FRONTEND_DIR/public
       Set FRONTEND_DIR=/path/to/kareenos_frontend if the repo lives elsewhere."
[[ -d "$EXPRESS_DIR/public/kareenos_com" ]] \
  || die "express vhost not found at $EXPRESS_DIR/public/kareenos_com
       Set EXPRESS_DIR=/path/to/expressserver if the repo lives elsewhere."

FRONTEND_DIR="$(cd -- "$FRONTEND_DIR" && pwd)"
EXPRESS_DIR="$(cd -- "$EXPRESS_DIR" && pwd)"
ok "frontend  $FRONTEND_DIR"
ok "express   $EXPRESS_DIR"

# =============================================================================
# 2. Show the build config that is about to be COMPILED IN
#
# VITE_* values are compile-time constants with hardcoded fallbacks scattered in
# popup/main.ts, welcome/App.vue, kareenos-connect.content.ts and wxt.config.ts.
# Build with the wrong ones and nothing fails here — it fails silently in the
# user's browser when "Connect this browser" does nothing. So print them.
#
# Precedence mirrors dotenv's real behaviour (override:false in wxt.config.ts:10-11):
# an already-exported shell var wins, then .env, then .env.local.
# =============================================================================
step "Build configuration (compiled into the extension)"

read_env_var() {
  local key="$1" val="" line f
  # exported shell env wins, exactly like dotenv override:false
  if [[ -n "${!key:-}" ]]; then printf '%s' "${!key}"; return; fi
  for f in "$EXT_DIR/.env" "$EXT_DIR/.env.local"; do
    [[ -f "$f" ]] || continue
    line="$(grep -E "^[[:space:]]*${key}=" "$f" | tail -n 1 || true)"
    [[ -n "$line" ]] || continue
    # .env is loaded first and WINS (dotenv does not override) — stop here
    val="${line#*=}"
    val="${val%$'\r'}"
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    printf '%s' "$val"
    return
  done
  printf '%s' "$val"
}

if [[ ! -f "$EXT_DIR/.env" && ! -f "$EXT_DIR/.env.local" ]]; then
  warn "No .env or .env.local in app/chrome-extension — the build will fall back to"
  warn "hardcoded defaults. Copy .env.example and set the target environment first."
fi
if [[ -f "$EXT_DIR/.env" && -f "$EXT_DIR/.env.local" ]]; then
  warn ".env AND .env.local both exist. dotenv does not override, so .env WINS."
fi

CFG_CHANNEL="$(read_env_var VITE_BROWSER_CHANNEL_URL)"
CFG_CONNECT="$(read_env_var VITE_KAREENOS_CONNECT_URL)"
CFG_MATCHES="$(read_env_var VITE_KAREENOS_MATCHES)"
CFG_KEY="$(read_env_var CHROME_EXTENSION_KEY)"

printf '    %-28s %s\n' "VITE_BROWSER_CHANNEL_URL" "${CFG_CHANNEL:-${C_YELLOW}(unset -> code fallback)${C_RESET}}"
printf '    %-28s %s\n' "VITE_KAREENOS_CONNECT_URL" "${CFG_CONNECT:-${C_YELLOW}(unset -> code fallback)${C_RESET}}"
printf '    %-28s %s\n' "VITE_KAREENOS_MATCHES" "${CFG_MATCHES:-${C_YELLOW}(unset -> wxt.config.ts default)${C_RESET}}"
# never print the key itself
printf '    %-28s %s\n' "CHROME_EXTENSION_KEY" "$([[ -n "$CFG_KEY" ]] && echo 'set (stable extension id)' || echo '(unset -> id changes per install)')"

# The connect origin must appear in the externally_connectable matches or the
# connect page's token never reaches the extension.
if [[ -n "$CFG_CONNECT" && -n "$CFG_MATCHES" ]]; then
  CONNECT_ORIGIN="$(printf '%s' "$CFG_CONNECT" | sed -E 's#^(https?://[^/]+).*#\1#')"
  CONNECT_HOST="${CONNECT_ORIGIN#*//}"
  if ! grep -qF "$CONNECT_HOST" <<< "$CFG_MATCHES"; then
    warn "VITE_KAREENOS_MATCHES does not mention '$CONNECT_HOST' (host of the connect URL)."
    warn "The connect page's token will not reach the extension. Check .env.local."
  fi
fi

# =============================================================================
# 3. Install
#
# Only the root install — do NOT call `pnpm build` / `build:native` / `build:wasm`.
# This fork has no app/native-server and no packages/wasm-simd; those root scripts
# reference packages that do not exist. The wasm/ONNX blobs are committed under
# app/chrome-extension/workers/ and copied by vite-plugin-static-copy.
# =============================================================================
if [[ $DO_INSTALL -eq 1 ]]; then
  step "Installing workspace dependencies"
  ( cd "$REPO_ROOT" && pnpm install --frozen-lockfile )
  ok "dependencies installed"
else
  step "Installing workspace dependencies"
  dim "skipped — deps already present (pass --install after a lockfile change)"
fi

# =============================================================================
# 4. Build the shared package FIRST
#
# packages/shared ships only dist/ (files: ["dist"]). The extension resolves it
# through a workspace symlink, so a missing or stale dist breaks the build.
# =============================================================================
step "Building chrome-mcp-shared"
( cd "$REPO_ROOT" && pnpm --filter chrome-mcp-shared build )
ok "shared package built"

# =============================================================================
# 5. Clean .output
#
# The root `clean:dist` only removes dist/.turbo and misses .output entirely —
# a real stale-artifact hazard when the version string does not change.
# =============================================================================
if [[ $KEEP_OUTPUT -eq 0 ]]; then
  step "Cleaning previous build output"
  rm -rf "$EXT_DIR/.output"
  ok "removed app/chrome-extension/.output"
fi

# =============================================================================
# 6. Build + zip
#
# The `cd` is REQUIRED: wxt.config.ts:10-11 resolves dotenv against process.cwd().
# `wxt zip` defaults to production mode, which is what gates esbuild minification
# and the COEP/COOP/CSP manifest keys — no NODE_ENV juggling needed.
# =============================================================================
step "Building + packaging the extension (wxt zip)"

# Retry once. wxt.config.ts registers viteStaticCopy with hook:'writeBundle', and
# WXT runs its ~7 entrypoint builds in PARALLEL — every one of them carries the
# same plugin, same targets, same destination. The plugin's copyAll() does
# `fs.cp(src, dest, {recursive:true, force:true})` under pMap, so two groups
# copying e.g. inject-scripts/element-picker.js to the identical path can race:
# one replaces the file between the other's internal stat and use, and the
# rejection is uncaught, killing the build with
#   ENOENT: no such file or directory, stat '.output/chrome-mv3/inject-scripts/*.js'
# It is intermittent and a retry always clears it. The real fix is to move
# inject-scripts/ + workers/ + _locales/ into app/chrome-extension/public/ (WXT
# copies public/ itself, once, outside the parallel builds — same output layout),
# which would let the viteStaticCopy plugin be dropped entirely.
BUILD_ATTEMPTS=2
attempt=1
while true; do
  if ( cd "$EXT_DIR" && pnpm zip ); then
    break
  fi
  if (( attempt >= BUILD_ATTEMPTS )); then
    die "extension build failed $attempt times — this is not the static-copy flake. Read the output above."
  fi
  warn "build failed on attempt $attempt/$BUILD_ATTEMPTS."
  warn "If the error above is an ENOENT stat on .output/chrome-mv3/inject-scripts/*.js,"
  warn "that is the known parallel static-copy race — retrying from a clean .output."
  rm -rf "$EXT_DIR/.output"
  attempt=$(( attempt + 1 ))
done

# =============================================================================
# 7. Locate the artifact
# =============================================================================
step "Locating the artifact"

EXT_NAME="$(node -p "require('$EXT_DIR/package.json').name")"
EXT_VERSION="$(node -p "require('$EXT_DIR/package.json').version")"
ZIP_SRC="$EXT_DIR/.output/${EXT_NAME}-${EXT_VERSION}-chrome.zip"

if [[ ! -f "$ZIP_SRC" ]]; then
  # WXT has renamed its outputs before (chrome-mv3-prod -> chrome-mv3); fall back
  # to the newest *-chrome.zip rather than failing on a cosmetic rename.
  FALLBACK="$(ls -t "$EXT_DIR/.output/"*-chrome.zip 2>/dev/null | head -n 1 || true)"
  [[ -n "$FALLBACK" ]] || die "no zip produced in $EXT_DIR/.output — the build did not emit an artifact."
  warn "expected $(basename "$ZIP_SRC") but found $(basename "$FALLBACK") — WXT naming may have changed."
  ZIP_SRC="$FALLBACK"
fi
ok "$(basename "$ZIP_SRC")"

# =============================================================================
# 8. Verify BEFORE publishing
# =============================================================================
step "Verifying the artifact"

# Read the entry list into a variable first: `unzip -l | grep -q` would exit on the
# first match, SIGPIPE the unzip, and `set -o pipefail` would report that as failure.
ZIP_ENTRIES="$(unzip -Z1 "$ZIP_SRC")"
grep -qx 'manifest\.json' <<< "$ZIP_ENTRIES" \
  || die "manifest.json is not at the root of the archive — refusing to publish."
ZIP_ENTRY_COUNT="$(grep -c '' <<< "$ZIP_ENTRIES")"
ok "manifest.json present at archive root ($ZIP_ENTRY_COUNT entries)"

MANIFEST_VERSION="$(unzip -p "$ZIP_SRC" manifest.json | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).version")"
[[ "$MANIFEST_VERSION" == "$EXT_VERSION" ]] \
  || die "manifest version ($MANIFEST_VERSION) != package.json version ($EXT_VERSION) — stale build?"
ok "version $MANIFEST_VERSION matches package.json"

ZIP_BYTES="$(wc -c < "$ZIP_SRC" | tr -d ' ')"
ZIP_HUMAN="$(awk -v b="$ZIP_BYTES" 'BEGIN{printf "%.1f MB", b/1048576}')"
if command -v shasum >/dev/null 2>&1; then
  ZIP_SHA="$(shasum -a 256 "$ZIP_SRC" | awk '{print $1}')"
else
  ZIP_SHA="$(sha256sum "$ZIP_SRC" | awk '{print $1}')"
fi
ok "$ZIP_HUMAN ($ZIP_BYTES bytes)"
dim "sha256 $ZIP_SHA"

# =============================================================================
# 9. Publish — atomically, to all three destinations
#
# express.static serves destination 3 LIVE. A plain cp of a 10 MB file would hand
# a truncated zip to anyone downloading mid-copy, so write to a temp name in the
# same directory and mv (atomic within a filesystem) into place.
# =============================================================================
step "Publishing $ARTIFACT_NAME"

publish_to() {
  local dest_dir="$1" label="$2" tmp
  mkdir -p "$dest_dir"
  tmp="$dest_dir/.${ARTIFACT_NAME}.tmp.$$"
  TMP_FILES+=("$tmp")
  cp "$ZIP_SRC" "$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$dest_dir/$ARTIFACT_NAME"
  ok "$label"
  dim "$dest_dir/$ARTIFACT_NAME"
}

publish_to "$REPO_ROOT/$REL_SUBPATH"                        "repo release dir"
publish_to "$FRONTEND_DIR/public/$REL_SUBPATH"              "frontend public/ (commit this)"
publish_to "$EXPRESS_DIR/public/kareenos_com/$REL_SUBPATH"  "expressserver vhost (no Quasar rebuild needed)"

# Mirror publish:web's ownership fixup; a no-op when the owner already matches.
chown -R "${SUDO_USER:-$(whoami)}" "$EXPRESS_DIR/public/kareenos_com/releases" 2>/dev/null || true

# =============================================================================
# 10. Summary
# =============================================================================
printf '\n%s─────────────────────────────────────────────────────────────%s\n' "$C_DIM" "$C_RESET"
printf '%sKareenos Extension %s published%s\n' "$C_BOLD" "$EXT_VERSION" "$C_RESET"
printf '%s─────────────────────────────────────────────────────────────%s\n' "$C_DIM" "$C_RESET"
printf '  size      %s (%s bytes)\n' "$ZIP_HUMAN" "$ZIP_BYTES"
printf '  sha256    %s\n' "$ZIP_SHA"
printf '  channel   %s\n' "${CFG_CHANNEL:-(fallback)}"
printf '  connect   %s\n' "${CFG_CONNECT:-(fallback)}"
printf '\n  %sdownload%s  %s\n' "$C_GREEN" "$C_RESET" "$PUBLIC_URL"
printf '            %s(live once expressserver/public is deployed as usual)%s\n' "$C_DIM" "$C_RESET"
printf '\n  %sNext:%s commit kareenos_frontend/public/%s/%s so a clean\n' "$C_BOLD" "$C_RESET" "$REL_SUBPATH" "$ARTIFACT_NAME"
printf '        clone still ships the extension with the frontend build.\n\n'
