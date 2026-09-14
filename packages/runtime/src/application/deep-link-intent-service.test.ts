import { describe, expect, it } from 'vitest';
import { RealtimeHub } from './realtime-hub';
import { DeepLinkIntentService } from './deep-link-intent-service';

describe('DeepLinkIntentService', () => {
  it('queues valid links in FIFO order and exposes credentials only in the claimed intent', () => {
    const realtime = new RealtimeHub();
    const events: Array<{ type: string; data: unknown }> = [];
    realtime.subscribe(({ type, data }) => events.push({ type, data }));
    const service = new DeepLinkIntentService(realtime, () => Date.parse('2026-03-01T00:00:00Z'));

    const receipt = service.enqueue('axterm://operator:session-secret@example.test?type=telnet');
    expect(receipt).toMatchObject({ status: 'ready', protocol: 'telnet' });
    expect(JSON.stringify(receipt)).not.toContain('session-secret');
    expect(JSON.stringify(events)).not.toContain('session-secret');
    expect(service.next()).toMatchObject({
      status: 'ready',
      protocol: 'telnet',
      source: 'axterm://operator:session-secret@example.test?type=telnet',
    });
    expect(service.count()).toBe(0);
  });

  it('turns malformed input into a safe rejection and expires unclaimed work', () => {
    let now = Date.parse('2026-03-01T00:00:00Z');
    const service = new DeepLinkIntentService(new RealtimeHub(), () => now);
    const receipt = service.enqueue('axterm://host.test?type=unsupported&password=secret');
    expect(receipt).toMatchObject({ status: 'rejected', errorCode: 'INVALID_DEEP_LINK' });
    expect(JSON.stringify(receipt)).not.toContain('host.test');
    expect(JSON.stringify(service.next())).not.toContain('host.test');

    service.enqueue('ssh://operator@example.test');
    now += 120_001;
    expect(service.next()).toBeNull();
  });

  it('rejects work above the bounded queue capacity and clears deterministically', () => {
    const service = new DeepLinkIntentService(new RealtimeHub());
    for (let index = 0; index < 32; index += 1)
      service.enqueue(`ssh://operator@host-${index}.example.test`);
    expect(() => service.enqueue('ssh://overflow.example.test')).toThrowError(
      /pending deep-link limit/,
    );
    service.clear();
    expect(service.count()).toBe(0);
  });
});
