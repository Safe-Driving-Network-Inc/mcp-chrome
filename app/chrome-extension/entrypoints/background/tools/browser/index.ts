// Kareenos Browser Channel — the bounded ELEVEN. This barrel is the capability
// boundary: handleCallTool (tools/index.ts) registers exactly what is exported
// here, so only these actions are ever callable. Arbitrary-script-exec, network
// capture, tab management, history/bookmarks/console, coordinate clicks etc. are
// deliberately NOT exported. Adding a line here is a capability decision.
export { navigateTool } from './common';
export { webFetcherTool } from './web-fetcher'; // chrome_get_web_content → platform "read"
export { clickTool, fillTool } from './interaction';
export { scrollTool } from './scroll'; // chrome_scroll → platform "scroll" (reach virtual-list items)
export { screenshotTool } from './screenshot';
export { uploadFileTool } from './upload'; // chrome_upload_file → platform "upload" (bytes arrive base64; never fetched)
// v2 (2026-09-14): the ref-based engine.
export { snapshotTool } from './snapshot'; // kareenos_snapshot → platform "snapshot" (refs the agent acts on)
export { waitTool } from './wait'; // kareenos_wait → platform "wait" (text/selector/ref × visible/hidden, load state)
export { pressTool } from './press'; // kareenos_press → platform "press" (trusted keys over CDP; gated like click)
export { runStepsTool } from './run-steps'; // kareenos_run_steps → platform "run_steps" (batched steps, one round trip)
