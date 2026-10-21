import { TOOL_NAMES } from 'chrome-mcp-shared';

type OwnerTag = string;

interface TabSessionState {
  refCount: number;
  owners: Set<OwnerTag>;
  attachedByUs: boolean;
}

const DEBUGGER_PROTOCOL_VERSION = '1.3';

// JavaScript dialogs seen while a session is attached (2026-10-21). A
// `beforeunload` ("Leave site?") is accepted at once — an agent that navigated
// away meant to leave — and recorded so the tool can report it; alert/confirm/
// prompt are only recorded (a page's question is the agent's to answer).
export interface DialogEvent {
  type: string;
  message: string;
  at: number;
  auto_accepted: boolean;
}
const dialogEvents = new Map<number, DialogEvent[]>();
export function takeDialogEvents(tabId: number): DialogEvent[] {
  const l = dialogEvents.get(tabId) || [];
  dialogEvents.delete(tabId);
  return l;
}

class CDPSessionManager {
  private sessions = new Map<number, TabSessionState>();

  constructor() {
    // The debugger can be detached under us (DevTools opened, the tab navigated to
    // a page extensions cannot script, "Cancel" on the debugging banner): forget
    // the session so the next command re-attaches instead of failing on a stale one.
    try {
      chrome.debugger.onDetach.addListener((source, reason) => {
        if (source && typeof source.tabId === 'number') {
          this.sessions.delete(source.tabId);
          console.log(`[BC] debugger detached from tab ${source.tabId}: ${reason}`);
        }
      });
      chrome.debugger.onEvent.addListener((source, method, params: any) => {
        if (!source || typeof source.tabId !== 'number') return;
        if (method !== 'Page.javascriptDialogOpening') return;
        const type = String((params && params.type) || 'alert');
        const auto = type === 'beforeunload';
        const list = dialogEvents.get(source.tabId) || [];
        list.push({
          type,
          message: String((params && params.message) || '').slice(0, 300),
          at: Date.now(),
          auto_accepted: auto,
        });
        dialogEvents.set(source.tabId, list.slice(-10));
        if (auto) {
          chrome.debugger
            .sendCommand({ tabId: source.tabId }, 'Page.handleJavaScriptDialog', { accept: true })
            .catch(() => {});
        }
      });
    } catch {
      /* debugger API unavailable in some contexts */
    }
  }

  private async enablePageEvents(tabId: number) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    } catch {
      /* events are best effort */
    }
  }

  private getState(tabId: number): TabSessionState | undefined {
    return this.sessions.get(tabId);
  }

  private setState(tabId: number, state: TabSessionState) {
    this.sessions.set(tabId, state);
  }

  async attach(tabId: number, owner: OwnerTag = 'unknown'): Promise<void> {
    const state = this.getState(tabId);
    if (state && state.attachedByUs) {
      state.refCount += 1;
      state.owners.add(owner);
      return;
    }

    // Check existing attachments
    const targets = await chrome.debugger.getTargets();
    const existing = targets.find((t) => t.tabId === tabId && t.attached);
    if (existing) {
      if (existing.extensionId === chrome.runtime.id) {
        // Already attached by us (e.g., previous tool). Adopt and refcount.
        this.setState(tabId, {
          refCount: state ? state.refCount + 1 : 1,
          owners: new Set([...(state?.owners || []), owner]),
          attachedByUs: true,
        });
        await this.enablePageEvents(tabId);
        return;
      }
      // Another client (DevTools/other extension) is attached
      throw new Error(
        `Debugger is already attached to tab ${tabId} by another client (e.g., DevTools/extension)`,
      );
    }

    // Attach freshly
    await chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
    this.setState(tabId, { refCount: 1, owners: new Set([owner]), attachedByUs: true });
    await this.enablePageEvents(tabId);
  }

  async detach(tabId: number, owner: OwnerTag = 'unknown'): Promise<void> {
    const state = this.getState(tabId);
    if (!state) return; // Nothing to do

    // Update ownership/refcount
    if (state.owners.has(owner)) state.owners.delete(owner);
    state.refCount = Math.max(0, state.refCount - 1);

    if (state.refCount > 0) {
      // Still in use by other owners
      return;
    }

    // We are the last owner
    try {
      if (state.attachedByUs) {
        await chrome.debugger.detach({ tabId });
      }
    } catch (e) {
      // Best-effort detach; ignore
    } finally {
      this.sessions.delete(tabId);
    }
  }

  /**
   * Convenience wrapper: ensures attach before fn, and balanced detach after.
   */
  async withSession<T>(tabId: number, owner: OwnerTag, fn: () => Promise<T>): Promise<T> {
    await this.attach(tabId, owner);
    try {
      return await fn();
    } finally {
      await this.detach(tabId, owner);
    }
  }

  /**
   * Send a CDP command. Requires that this manager has attached to the tab.
   * If not attached by us, will attempt a one-shot attach around the call.
   */
  async sendCommand<T = any>(tabId: number, method: string, params?: object): Promise<T> {
    const state = this.getState(tabId);
    if (state && state.attachedByUs) {
      try {
        return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
      } catch (e) {
        // Our bookkeeping says attached but Chrome says otherwise (a detach we did
        // not see): drop the state and re-attach once (2026-10-21).
        if (
          !/not attached|Detached|No target with given id/i.test(
            e instanceof Error ? e.message : String(e),
          )
        )
          throw e;
        this.sessions.delete(tabId);
      }
    }
    // Fallback: temporary session
    return await this.withSession<T>(tabId, `send:${method}`, async () => {
      return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
    });
  }
}

export const cdpSessionManager = new CDPSessionManager();
