import { expect, it, vi } from 'vitest';
import type { ConnectionGeneration, ConnectionWebSocket } from '@axterm/infra-connection/client';
import { RemoteDesktopStream } from './stream.ts';
class Socket implements ConnectionWebSocket {
  private readonly events = new EventTarget();
  addEventListener: ConnectionWebSocket['addEventListener'] = (event, listener, options) => {
    this.events.addEventListener(event, listener as EventListener, options);
  };
  removeEventListener: ConnectionWebSocket['removeEventListener'] = (event, listener) => {
    this.events.removeEventListener(event, listener as EventListener);
  };
  readyState = 1;
  bufferedAmount = 0;
  binaryType = '';
  readonly frames: Array<string | Uint8Array> = [];
  send(data: string | Uint8Array) {
    this.frames.push(data);
  }
  close = vi.fn(() => {
    this.readyState = 3;
    this.events.dispatchEvent(new Event('close'));
  });
  receive(data: unknown) {
    this.events.dispatchEvent(new MessageEvent('message', { data }));
  }
}

function fixture() {
  const socket = new Socket();
  const subscribers = new Set<() => void>();
  let generation: ConnectionGeneration | undefined = { id: 1, host: { home: '/fixture' } };
  const consume = vi.fn();
  const ended = vi.fn();
  const stream = new RemoteDesktopStream(
    {
      openWebSocket: () => socket,
      generation: {
        getSnapshot: () => generation,
        subscribe: (fn) => {
          subscribers.add(fn);
          return () => {
            subscribers.delete(fn);
          };
        },
      },
    },
    crypto.randomUUID(),
    consume,
    ended,
  );
  return {
    stream,
    socket,
    subscribers,
    consume,
    ended,
    disconnect: () => {
      generation = undefined;
      for (const fn of [...subscribers]) fn();
    },
  };
}
it('delivers binary bytes directly, bounds output and closes on generation loss without replay', () => {
  const f = fixture();
  try {
    const data = new Uint8Array([1, 2, 3]);
    f.socket.receive(data.buffer);
    expect(f.consume).toHaveBeenCalledWith(data);
    expect(f.stream.send(data)).toBe(true);
    f.socket.bufferedAmount = 8 * 1024 * 1024;
    expect(f.stream.send(data)).toBe(false);
    f.socket.bufferedAmount = 0;
    expect(f.stream.send(new Uint8Array(4 * 1024 * 1024 + 1))).toBe(false);
    f.disconnect();
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect(f.subscribers.size).toBe(0);
    expect(f.stream.send(data)).toBe(false);
    f.socket.receive(data.buffer);
    expect(f.consume).toHaveBeenCalledOnce();
    expect(f.ended).toHaveBeenCalledOnce();
  } finally {
    f.stream.dispose();
  }
});
it.each(['text', new ArrayBuffer(4 * 1024 * 1024 + 1)])(
  'rejects malformed or oversized byte carriers',
  (data) => {
    const f = fixture();
    f.socket.receive(data);
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect(f.consume).not.toHaveBeenCalled();
    f.stream.dispose();
  },
);
