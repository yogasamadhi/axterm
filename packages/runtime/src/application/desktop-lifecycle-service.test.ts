import type { DesktopLifecycleState } from '@workspace/contracts/desktop';
import { describe, expect, it } from 'vitest';
import { DesktopLifecycleService } from './desktop-lifecycle-service';
import { RealtimeHub, type RealtimeEvent } from './realtime-hub';

describe('DesktopLifecycleService', () => {
  it('publishes only newer native lifecycle revisions and releases polling resources', async () => {
    let lifecycle: DesktopLifecycleState = {
      revision: 0,
      state: 'active',
      lastEvent: 'started',
      changedAt: '2026-03-01T00:00:00.000Z',
    };
    const host = {
      lifecycle: async () => lifecycle,
    };
    const realtime = new RealtimeHub();
    const events: RealtimeEvent[] = [];
    realtime.subscribe((event) => events.push(event));
    const service = new DesktopLifecycleService(host as never, realtime, 60_000);

    expect(await service.pollNow()).toEqual(lifecycle);
    expect(events).toEqual([]);

    lifecycle = {
      revision: 2,
      state: 'active',
      lastEvent: 'resume',
      changedAt: '2026-03-01T01:00:00.000Z',
    };
    expect(await service.pollNow()).toEqual(lifecycle);
    expect(events).toEqual([
      expect.objectContaining({ type: 'desktop.lifecycle', data: lifecycle }),
    ]);

    await service.pollNow();
    expect(events).toHaveLength(1);
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.resourceCount()).toBe(1);
    service.close();
    expect(service.resourceCount()).toBe(0);
  });
});
