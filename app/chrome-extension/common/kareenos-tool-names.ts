// Kareenos Browser Channel v2 — internal tool names for the actions this fork
// adds on top of the upstream mcp-chrome set. They live HERE (not in
// chrome-mcp-shared's TOOL_NAMES) so a release never needs a shared-package
// rebuild for a channel-only change.
//
// Never register a tool named `chrome_read_page`: the dormant record-replay v2
// handlers call that name and would silently come back to life.
export const KAREENOS_TOOL_NAMES = {
  SNAPSHOT: 'kareenos_snapshot',
  WAIT: 'kareenos_wait',
  PRESS: 'kareenos_press',
  RUN_STEPS: 'kareenos_run_steps',
} as const;

// The in-page core every v2 action shares (inject-scripts/k-dom-core.js).
export const K_DOM_CORE_SCRIPT = 'inject-scripts/k-dom-core.js';
export const K_DOM_CORE_PING = 'k_dom_core_ping';

// Message actions answered by k-dom-core.js.
export const K_MSG = {
  FIND_CANDIDATES: 'kFindCandidates',
  RESOLVE_REF: 'kResolveRef',
  FOCUS_PROBE: 'kFocusProbe',
  STATE_PROBE: 'kStateProbe',
  QUIET_WAIT: 'kQuietWait',
  LIST_IFRAMES: 'kListIframes',
  ELEMENT_RECT: 'kElementRect',
  FOCUS: 'kFocus',
  SCROLL: 'kScroll',
  WAIT_FOR: 'kWaitFor',
  SNAPSHOT: 'kSnapshot',
} as const;
