import { expect, it, vi } from 'vitest';
import type { ConnectionGeneration, ConnectionWebSocket } from '@axterm/infra-connection/client';
import { claimRemoteDesktopCredentials } from './credentials.ts';
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
  const claim = claimRemoteDesktopCredentials(
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
  );
  return {
    socket,
    claim,
    subscribers,
    disconnect: () => {
      generation = undefined;
      for (const fn of [...subscribers]) fn();
    },
  };
}
it('consumes exactly one bounded binary credential bootstrap and releases its socket and generation listener', async () => {
  const f = fixture();
  const value = {
    username: 'user',
    password: 'CONTROLLED_TRANSIENT_SECRET',
    domain: '',
    destination: '127.0.0.1:3389',
  };
  f.socket.receive(new TextEncoder().encode(JSON.stringify(value)).buffer);
  expect(await f.claim).toEqual(value);
  expect(f.socket.close).toHaveBeenCalledOnce();
  expect(f.subscribers.size).toBe(0);
  expect(f.socket.frames).toEqual([]);
});
it('cancels a pending credential bootstrap on generation loss and never replays a claim', async () => {
  const f = fixture();
  const failed = expect(f.claim).rejects.toThrow('REMOTE_DESKTOP_CREDENTIAL_UNAVAILABLE');
  f.disconnect();
  await failed;
  expect(f.socket.close).toHaveBeenCalledOnce();
  expect(f.subscribers.size).toBe(0);
  expect(f.socket.frames).toEqual([]);
});
it.each([
  'unvalidated text',
  new TextEncoder().encode(
    JSON.stringify({
      username: 'user',
      password: 'PRIVATE',
      domain: '',
      destination: '127.0.0.1:3389',
      extra: 'forbidden',
    }),
  ).buffer,
])('rejects unvalidated text or extra secret fields and releases the bootstrap', async (data) => {
  const f = fixture();
  const failed = expect(f.claim).rejects.toThrow('REMOTE_DESKTOP_CREDENTIAL_UNAVAILABLE');
  f.socket.receive(data);
  await failed;
  expect(f.subscribers.size).toBe(0);
});
