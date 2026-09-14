import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type { SpiceRelaySocket } from '../../ports/spice-relay';
import { NodeSpiceRelay } from './node-spice-relay';

class TestTarget extends Duplex {
  readonly writes: Buffer[] = [];

  override _read() {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    this.writes.push(Buffer.from(chunk));
    callback();
  }

  serverData(data: Uint8Array) {
    this.push(Buffer.from(data));
  }
}

class TestSocket extends EventEmitter implements SpiceRelaySocket {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn();
}

describe('NodeSpiceRelay', () => {
  it('relays raw SPICE channel bytes in both directions and cleans up deterministically', async () => {
    const socket = new TestSocket();
    const target = new TestTarget();
    const onReady = vi.fn();
    const onClose = vi.fn();
    const handle = await new NodeSpiceRelay().attach({
      socket,
      signal: new AbortController().signal,
      openTarget: vi.fn(async () => target),
      onReady,
      onClose,
    });
    await setImmediate();
    expect(onReady).toHaveBeenCalledOnce();

    socket.emit('message', Buffer.from([1, 2, 3]), true);
    target.serverData(Buffer.from([4, 5, 6]));
    await setImmediate();
    expect(Buffer.concat(target.writes)).toEqual(Buffer.from([1, 2, 3]));
    expect(socket.send).toHaveBeenCalledWith(Buffer.from([4, 5, 6]), { binary: true });

    handle.close();
    expect(target.destroyed).toBe(true);
    expect(socket.close).toHaveBeenCalledWith(1000, 'spice closed');
    expect(onClose).toHaveBeenCalledWith(undefined);
    expect(socket.listenerCount('message')).toBe(0);
  });

  it('rejects text frames before forwarding them to the SPICE server', async () => {
    const socket = new TestSocket();
    const target = new TestTarget();
    const onClose = vi.fn();
    await new NodeSpiceRelay().attach({
      socket,
      signal: new AbortController().signal,
      openTarget: vi.fn(async () => target),
      onReady: vi.fn(),
      onClose,
    });
    await setImmediate();
    socket.emit('message', Buffer.from('text'), false);
    expect(target.writes).toHaveLength(0);
    expect(onClose).toHaveBeenCalledWith('SPICE_PROTOCOL_ERROR');
  });
});
