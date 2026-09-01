// Kareenos Browser Channel: the native-messaging host and the semantic-search
// engine are removed. The ONLY command source is the outbound wss client
// (P1.3), wired in below. Semantic/vector search is out of scope.
import { initBrowserChannelClient } from './browser-channel-client';
import { initLearnMode } from './learn-mode';
import { initStorageManagerListener } from './storage-manager';
import { initRecordReplayListeners } from './record-replay';
import { initElementMarkerListeners } from './element-marker';
import { initWebEditorListeners } from './web-editor';
import { initQuickPanelAgentHandler } from './quick-panel/agent-handler';
import { initQuickPanelCommands } from './quick-panel/commands';
import { initQuickPanelTabsHandler } from './quick-panel/tabs-handler';

// Record-Replay V3 (feature flag)
import { bootstrapV3 } from './record-replay-v3/bootstrap';

/**
 * Feature flag for RR-V3
 * Set to true to enable the new Record-Replay V3 engine
 */
const ENABLE_RR_V3 = true;

/**
 * Background script entry point
 * Initializes all background services and listeners
 */
export default defineBackground(() => {
  // On fresh install, open the Kareenos onboarding page that guides the user
  // through connecting the extension to the platform. Only on 'install' (not on
  // update/reload) so we don't nag on every rebuild.
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      try {
        chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
      } catch (e) {
        console.warn('[Kareenos] could not open welcome page:', e);
      }
    }
  });

  // Initialize core services
  // The outbound wss client — the only command source — binds identity and
  // dispatches the bounded five. Replaces the removed native-messaging host.
  initBrowserChannelClient();
  // Learn Mode: record a user demonstration → macro shipped over the channel.
  initLearnMode();
  initStorageManagerListener();
  // Record & Replay V1/V2 listeners
  initRecordReplayListeners();

  // Record & Replay V3 (new engine)
  if (ENABLE_RR_V3) {
    bootstrapV3()
      .then((runtime) => {
        console.log(`[RR-V3] Bootstrap complete, ownerId: ${runtime.ownerId}`);
      })
      .catch((error) => {
        console.error('[RR-V3] Bootstrap failed:', error);
      });
  }

  // Element marker: context menu + CRUD listeners
  initElementMarkerListeners();
  // Web editor: toggle edit-mode overlay
  initWebEditorListeners();
  // Quick Panel: send messages to AgentChat via background-stream bridge
  initQuickPanelAgentHandler();
  // Quick Panel: tabs search bridge for content script UI
  initQuickPanelTabsHandler();
  // Quick Panel: keyboard shortcut handler
  initQuickPanelCommands();
});
