// Kareenos Browser Channel — the bounded FIVE. This barrel is the capability
// boundary: handleCallTool (tools/index.ts) registers exactly what is exported
// here, so only these five actions are ever callable. Arbitrary-script-exec,
// network capture, tab management, history/bookmarks/console, etc. are removed.
export { navigateTool } from './common';
export { webFetcherTool } from './web-fetcher'; // chrome_get_web_content → platform "read"
export { clickTool, fillTool } from './interaction';
export { screenshotTool } from './screenshot';
