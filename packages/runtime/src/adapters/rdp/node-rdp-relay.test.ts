import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  buildRdpCleanPathResponse,
  NodeRdpRelay,
  parseRdpCleanPathRequest,
  parseRdpDestination,
} from './node-rdp-relay';

const wrap = (tag: number, value: Uint8Array) => {
  const content = Buffer.from(value);
  if (content.length >= 128) throw new Error('Fixture only supports short DER values');
  return Buffer.concat([Buffer.from([tag, content.length]), content]);
};

describe('NodeRdpRelay protocol framing', () => {
  it('parses the bounded RDCleanPath destination and X.224 request', () => {
    const x224 = Buffer.from([3, 0, 0, 7, 2, 0xf0, 0x80]);
    const request = wrap(
      0x30,
      Buffer.concat([
        wrap(0xa0, wrap(0x02, Buffer.from([0x0d, 0x3e]))),
        wrap(0xa2, wrap(0x0c, Buffer.from('rdp.example.test:3390'))),
        wrap(0xa6, wrap(0x04, x224)),
      ]),
    );
    expect(parseRdpCleanPathRequest(request)).toEqual({
      destination: 'rdp.example.test:3390',
      x224ConnectionRequest: x224,
    });
    expect(parseRdpDestination('[2001:db8::1]:3389')).toEqual({
      host: '2001:db8::1',
      port: 3_389,
    });
  });

  it('builds a certificate-bearing response and rejects malformed targets', () => {
    const response = buildRdpCleanPathResponse(
      'rdp.example.test:3389',
      Buffer.from([3, 0, 0, 7, 2, 0xf0, 0x80]),
      [Buffer.from('certificate')],
    );
    expect(response[0]).toBe(0x30);
    expect(response.includes(Buffer.from('certificate'))).toBe(true);
    expect(() => parseRdpDestination('host:70000')).toThrow(/port/i);
    expect(() => parseRdpCleanPathRequest(Buffer.from([0x30, 0]))).toThrow(/Incomplete/i);
  });

  it('rejects a client-selected target before opening any network route', async () => {
    const events = new EventEmitter();
    const close = vi.fn();
    const onClose = vi.fn();
    const openTarget = vi.fn();
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close,
      on: events.on.bind(events),
      off: events.off.bind(events),
    };
    const relay = new NodeRdpRelay();
    const controller = new AbortController();
    await relay.attach({
      socket,
      target: { host: 'approved.example.test', port: 3_389 },
      timeoutMs: 1_000,
      signal: controller.signal,
      openTarget,
      onReady: vi.fn(),
      onClose,
    });
    const request = wrap(
      0x30,
      Buffer.concat([
        wrap(0xa0, wrap(0x02, Buffer.from([0x0d, 0x3e]))),
        wrap(0xa2, wrap(0x0c, Buffer.from('attacker.example.test:3389'))),
        wrap(0xa6, wrap(0x04, Buffer.from([3, 0, 0, 7, 2, 0xf0, 0x80]))),
      ]),
    );
    events.emit('message', request, true);
    await setImmediate();
    expect(openTarget).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(1011, 'rdp closed');
    expect(onClose).toHaveBeenCalledWith('RDP_CONNECTION_FAILED');
    expect(events.listenerCount('message')).toBe(0);
  });
});
