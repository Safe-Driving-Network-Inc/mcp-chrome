# Kareenos Browser Channel — Fork Migration (P1.0 Triage)

> Fork of `Safe-Driving-Network-Inc/mcp-chrome`, repurposed as the **attended browser
> channel** for the Kareenos platform. This document is the P1.0 keep/delete/rewrite
> inventory — produced **before any deletion**. The backend half (Phase 2) is already built
> in `kareenos_backend`; this extension is the Phase 1 half.

## The critical question — is the action layer coupled to the transport?

**Answer: cleanly separated.** The triage confirms:

- `entrypoints/background/tools/index.ts` exposes `handleCallTool({ name, args })` — a pure
  name→handler map. It has **no transport dependency**.
- `tools/base-browser.ts` (`BaseBrowserToolExecutor`) depends only on `@/common/tool-handler`
  (the `ToolResult` type) and `chrome.scripting` / `chrome.tabs` APIs. No native-messaging,
  no MCP server, no bridge.
- The transport (`native-host.ts`) is the *only* thing that imports the bridge; it calls
  `handleCallTool` and nothing in the tools calls back into it.

**Consequence:** Phase 1 is **mostly deletion + one new outbound `wss` client + a thin result
adapter** (`ToolResult` → the Phase-2 envelope). The proven `chrome.scripting`/`chrome.tabs`
action layer is kept intact.

## The single coupling point with the backend

The frozen command/result envelope (backend: `global/kareenos/messaging/browser_channel_envelope.js`):

- **Command (server → extension):** `{ command_id, correlation_id, tenant, action ∈
  {navigate,read,click,fill,screenshot}, args, requires_approval }`
- **Result (extension → server):** `{ command_id, correlation_id, status, message, data, errors }`
- The extension speaks this over an **outbound `wss://<server>/browser-channel`** connection
  and binds with `{ type:'bind', token }` before any command flows.

---

## KEEP

| Path | Why |
|---|---|
| `entrypoints/background/tools/index.ts` | Transport-agnostic `handleCallTool` dispatch — the seam the new wss client calls. |
| `tools/base-browser.ts` | Base executor (`chrome.scripting`/`chrome.tabs`, content-script inject/ping). |
| `tools/browser/common.ts` | `chrome_navigate` (→ **navigate**). |
| `tools/browser/read-page.ts` | `chrome_get_web_content` / READ_PAGE (→ **read**). |
| `tools/browser/web-fetcher.ts` | `GET_INTERACTIVE_ELEMENTS` — useful for resolving click/fill targets; keep the interactive-elements path, drop the remote-fetch path if it reaches the network independently. |
| `tools/browser/interaction.ts` | `chrome_click_element` (→ **click**) + `chrome_fill_or_select` (→ **fill**). |
| `tools/browser/screenshot.ts` | `chrome_screenshot` (→ **screenshot**). |
| `common/tool-handler.ts` | `ToolResult` type — kept, but the MCP `CallToolResult` base is adapted to the Phase-2 envelope (see REWRITE). |
| `inject-scripts/`, `shared/selector`, content-script ping infra | Selector resolution + DOM access used by click/fill/read. |
| `entrypoints/popup/` | Minimal UI — reduced to connection state / bound account+project / Sign-in / Disconnect (P1.5). |
| `_locales/`, `assets/`, `public/icon` | Branding (white-label, P1.6). |

## DELETE — transport & off-scope subsystems (P1.1)

| Path | Why |
|---|---|
| `entrypoints/background/native-host.ts` | Native-messaging transport — replaced by the outbound wss client. |
| `app/native-server/` (whole package) | The `127.0.0.1:12306` HTTP/MCP + stdio server. No local listener remains. |
| `packages/wasm-simd/` | WASM-SIMD for semantic search — out of scope, enlarges security-review surface. |
| `entrypoints/background/semantic-similarity.ts` | Vector/semantic search. |
| `tools/browser/vector-search.ts`, `SEARCH_TABS_CONTENT` | Semantic tab search. |
| `entrypoints/background/storage-manager.ts` (if only vector-DB) / `offscreen` (if only WASM/embeddings) | Re-verify before deleting; remove only the semantic-search parts. |
| `@modelcontextprotocol/sdk` dependency | Once the result adapter lands, the MCP types are no longer imported. |

## DELETE — off-scope tools (P1.1 — arbitrary-exec removal is a SECURITY requirement)

`inject-script.ts` (`INJECT_SCRIPT`, `SEND_COMMAND_TO_INJECT_SCRIPT`), `javascript.ts`
(`JAVASCRIPT`), `userscript.ts` — **raw page-exec primitives, removed for security**.
Also: `keyboard.ts`, `network-*.ts` (request/capture/debugger), `history.ts`, `bookmark.ts`,
`console.ts`/`console-buffer.ts`, `window.ts` (multi-tab: `CLOSE_TABS`/`SWITCH_TAB`/
`GET_WINDOWS_AND_TABS`), `computer.ts`, `performance.ts`, `gif-*`, `file-upload.ts`,
`dialog.ts`, `download.ts`, `element-picker.ts` (`REQUEST_ELEMENT_SELECTION`),
`record-replay.ts` (`flowRunTool`, `listPublishedFlowsTool`). Trim `packages/shared/src/tools.ts`
`TOOL_NAMES.BROWSER` down to the five.

## REWRITE / ADD

1. **Result adapter** — `ToolResult` (`{ content:(text|image)[], isError }`) → Phase-2 envelope
   `{ status, message, data, errors }`. A screenshot's `ImageContent` base64 becomes `data.base64`
   (+ `media_type`). Add as a thin wrapper around `handleCallTool`.
2. **Outbound `wss` client** (the only new subsystem, P1.3) — connects to
   `wss://<server>/browser-channel`; binds via `{type:'bind', token}`; on `{type:'command',...}`
   resolves to `handleCallTool({name: <internal name>, args})`, adapts the result, sends
   `{type:'result', command_id, correlation_id, ...}`. MV3-resilient (`chrome.alarms`
   reconnect/heartbeat). No listener; this socket is the only command source.
3. **Action-name map** — platform action (`navigate/read/click/fill/screenshot`) →
   internal tool name (`chrome_navigate`, etc.). Unknown/unassigned actions → `status:'failed'`.
4. **Sign-in** (P1.4) — open the Kareenos auth tab; the backend mints a short-lived token
   (consume `/superos.browser_channel_link_start` → `/browserchannel.signin_callback`,
   which `postMessage`s `{source:'kareenos-browser-channel', data:{token,...}}`). Store the
   token in `chrome.storage.session` only.
5. **Popup** (P1.5) — connection state / bound account+project / Sign-in / Disconnect.
6. **White-label build** (P1.6) — name/icon/server URL configurable at build; enterprise
   force-install.

## Done-when (Phase 1)
Extension loads, signs in, opens an outbound `wss` to the backend, binds identity, and
round-trips all five actions against a real authenticated page — **zero local listener, no
bridge package in the build.**
