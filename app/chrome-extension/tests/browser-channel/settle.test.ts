import { describe, it, expect, vi } from 'vitest';
import { navEventsSince, waitForLoadState, __pushNavEventForTests } from '@/entrypoints/background/tools/settle';

describe('settle: navigation log + load state', () => {
  it('records and filters navigation events by time', () => {
    const t0 = Date.now();
    __pushNavEventForTests(7, { t: t0 - 5000, frameId: 0, url: 'a', event: 'committed' });
    __pushNavEventForTests(7, { t: t0 + 10, frameId: 0, url: 'b', event: 'committed' });
    const since = navEventsSince(7, t0);
    expect(since).toHaveLength(1);
    expect(since[0].url).toBe('b');
  });
  it('waits for the tab to complete', async () => {
    const get = (globalThis as any).chrome.tabs.get as ReturnType<typeof vi.fn>;
    get.mockResolvedValueOnce({ id: 9, status: 'loading' }).mockResolvedValueOnce({ id: 9, status: 'complete' });
    const r = await waitForLoadState(9, 'complete', 3000);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('complete');
  });
  it('times out honestly', async () => {
    const get = (globalThis as any).chrome.tabs.get as ReturnType<typeof vi.fn>;
    get.mockResolvedValue({ id: 9, status: 'loading' });
    const r = await waitForLoadState(9, 'complete', 200);
    expect(r.ok).toBe(false);
  });
});
