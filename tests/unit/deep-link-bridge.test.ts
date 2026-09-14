import { describe, expect, it, vi } from 'vitest';
import {
  AXTERM_DEEP_LINK_SCHEMES,
  DesktopDeepLinkBridge,
  extractDeepLinks,
} from '../../apps/desktop/src/main/deep-link-bridge';

async function settled() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('DesktopDeepLinkBridge', () => {
  it('extracts only registered bounded session schemes and excludes ordinary web URLs', () => {
    expect(AXTERM_DEEP_LINK_SCHEMES).toEqual([
      'ssh',
      'telnet',
      'vnc',
      'rdp',
      'spice',
      'serial',
      'ftp',
      'axterm',
      'electerm',
    ]);
    expect(
      extractDeepLinks([
        '--flag',
        'HTTPS://example.test',
        'SSH://operator@example.test',
        'axterm://host.test?type=vnc',
        `ssh://${'x'.repeat(16_384)}`,
      ]),
    ).toEqual(['SSH://operator@example.test', 'axterm://host.test?type=vnc']);
  });

  it('buffers before Runtime readiness and authenticates the generation ingress', async () => {
    const focus = vi.fn();
    const transport = vi.fn(async () => new Response(null, { status: 202 }));
    const bridge = new DesktopDeepLinkBridge(focus, transport as never);
    bridge.receive('electerm://operator@example.test');
    expect(bridge.pendingCount()).toBe(1);
    bridge.connect({
      baseUrl: 'http://127.0.0.1:4567',
      generation: 'generation-a',
      token: 'token-a',
    });
    await settled();
    expect(bridge.pendingCount()).toBe(0);
    expect(focus).toHaveBeenCalledOnce();
    const [url, init] = transport.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:4567/desktop/v1/deep-links');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-a',
        'Content-Type': 'application/json',
        'X-Runtime-Generation': 'generation-a',
      },
    });
  });

  it('keeps bounded pending work and retains the next item when transport fails', async () => {
    const bridge = new DesktopDeepLinkBridge(
      () => undefined,
      vi.fn(async () => new Response(null, { status: 401 })) as never,
    );
    for (let index = 0; index < 40; index += 1)
      bridge.receive(`ssh://operator@host-${index}.example.test`);
    expect(bridge.pendingCount()).toBe(32);
    bridge.connect({
      baseUrl: 'http://127.0.0.1:4567',
      generation: 'generation-a',
      token: 'token-a',
    });
    await settled();
    expect(bridge.pendingCount()).toBe(32);
  });
});
