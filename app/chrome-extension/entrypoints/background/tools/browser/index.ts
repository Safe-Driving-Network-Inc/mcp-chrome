// Kareenos Browser Channel — the bounded SEVEN. This barrel is the capability
// boundary: handleCallTool (tools/index.ts) registers exactly what is exported
// here, so only these seven actions are ever callable. Arbitrary-script-exec,
// network capture, tab management, history/bookmarks/console, etc. are removed.
export { navigateTool } from './common';
export { webFetcherTool } from './web-fetcher'; // chrome_get_web_content → platform "read"
export { clickTool, fillTool } from './interaction';
export { scrollTool } from './scroll'; // chrome_scroll → platform "scroll" (reach virtual-list items)
export { screenshotTool } from './screenshot';
export { uploadFileTool } from './upload'; // chrome_upload_file → platform "upload" (bytes arrive base64; never fetched)
