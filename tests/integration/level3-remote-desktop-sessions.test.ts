import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import {
  bookmarkSchema,
  createBookmarkSchema,
  connectionProfileSchema,
} from '@axterm/plugin-api/catalog';
import type { RemoteDesktopProtocol } from '@axterm/plugin-api/remote-desktop';
import { RemoteDesktopSessions } from '../../packages/plugins/remote-desktop/src/application/sessions.ts';
import { RemoteDesktopObservation } from '../../packages/plugins/remote-desktop/src/application/observation.ts';
import { BinaryRelay } from '../../packages/plugins/remote-desktop/src/adapters/binary-relay.ts';
import type { Relay, RelaySocket } from '../../packages/plugins/remote-desktop/src/ports/relay.ts';
class Socket extends EventEmitter implements RelaySocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: Buffer[] = [];
  send(data: Uint8Array) {
    this.sent.push(Buffer.from(data));
  }
  close = vi.fn(() => {
    this.readyState = 3;
  });
}
class Target extends Duplex {
  readonly received: Buffer[] = [];
  releaseDestroy?: () => void;
  override _read() {}
  override _write(data: Buffer, _: BufferEncoding, done: () => void) {
    this.received.push(Buffer.from(data));
    done();
  }
  override _destroy(_: Error | null, done: (error?: Error) => void) {
    this.releaseDestroy = done;
  }
}
function fixture(protocol: RemoteDesktopProtocol = 'vnc', relay?: Relay) {
  const now = new Date().toISOString();
  const id = randomUUID();
  const profile = connectionProfileSchema.parse({
    id: randomUUID(),
    name: 'Controlled profile',
    isDefault: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
    [protocol]: {
      ...(protocol !== 'spice' ? { username: 'profile-user' } : {}),
      passwordCredentialRef: 'saved-ref',
    },
  });
  const bookmark = bookmarkSchema.parse({
    ...createBookmarkSchema.parse({
      protocol,
      hostId: null,
      title: 'Remote Desktop',
      connectionProfileId: profile.id,
      [protocol]: {
        hostname: '127.0.0.1',
        ...(protocol === 'rdp'
          ? { domain: 'LAB' }
          : protocol === 'vnc'
            ? {
                viewOnly: true,
                clipViewport: true,
                scaleViewport: false,
                qualityLevel: 7,
                compressionLevel: 4,
                shared: false,
                showDotCursor: true,
                clipboard: false,
              }
            : { viewOnly: true, scaleViewport: false }),
        ...(protocol !== 'spice' ? { username: 'bookmark-user' } : {}),
      },
    }),
    id,
    position: 0,
    connectionDisplay: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  const credentials = vi.fn(async () => 'CONTROLLED_DESKTOP_SECRET');
  const openStream = vi.fn();
  let clock = Date.now();
  const service = new RemoteDesktopSessions(
    {
      catalog: { getBookmark: () => bookmark, getConnectionProfile: () => profile },
      credential: credentials,
      openStream,
    },
    {
      rdp: relay ?? new BinaryRelay('VNC'),
      vnc: relay ?? new BinaryRelay('VNC'),
      spice: relay ?? new BinaryRelay('SPICE'),
    },
    () => clock,
  );
  return {
    service,
    credentials,
    openStream,
    id,
    tick: () => {
      clock += 120001;
    },
    create: () => service.create({ protocol, bookmarkId: id }, new AbortController().signal),
  };
}
it.each(['rdp', 'vnc', 'spice'] as const)(
  'keeps %s credentials out of metadata, applies profile precedence and never replays claims',
  async (protocol) => {
    const f = fixture(protocol);
    try {
      const session = await f.create();
      expect(JSON.stringify(f.service.list())).not.toContain('SECRET');
      const credentials = await f.service.claim(session.id);
      expect(credentials.password).toBe('CONTROLLED_DESKTOP_SECRET');
      expect(f.credentials).toHaveBeenCalledExactlyOnceWith('saved-ref', expect.any(AbortSignal));
      if (protocol === 'rdp')
        expect(credentials).toMatchObject({ domain: 'LAB', destination: '127.0.0.1:3389' });
      if (protocol === 'vnc')
        expect(session).toMatchObject({
          viewOnly: true,
          clipViewport: true,
          qualityLevel: 7,
          compressionLevel: 4,
          shared: false,
        });
      if (protocol === 'spice')
        expect(session).toMatchObject({ viewOnly: true, scaleViewport: false });
      expect(credentials.username).toBe(protocol === 'spice' ? '' : 'profile-user');
      expect(() => f.service.claim(session.id)).toThrow();
      await f.service.closeSession(session.id);
      expect(f.service.resourceCount()).toBe(0);
      const expired = await f.create();
      f.tick();
      expect(() => f.service.claim(expired.id)).toThrow();
    } finally {
      await f.service.close();
    }
  },
);
it('bounds pending secret resolutions, cancels late claims and replaces complete generation metadata', async () => {
  const f = fixture();
  const resolving = Promise.withResolvers<string>();
  f.credentials.mockImplementation(() => resolving.promise);
  const created = await Promise.all(Array.from({ length: 8 }, () => f.create()));
  expect(f.credentials).not.toHaveBeenCalled();
  const creates = created.map((session) => f.service.claim(session.id));
  await expect(f.create()).rejects.toThrow();
  const observation = new RemoteDesktopObservation(f.service, randomUUID());
  const abort = new AbortController();
  const stream = observation.watch(abort.signal)[Symbol.asyncIterator]();
  expect((await stream.next()).value).toMatchObject({
    type: 'baseline',
    sessions: expect.arrayContaining(created),
  });
  const results = Promise.allSettled(creates);
  let finished = false;
  const close = f.service.close().then(() => {
    finished = true;
  });
  await setImmediate();
  expect(finished).toBe(false);
  resolving.resolve('SECRET');
  await close;
  expect((await results).every((result) => result.status === 'rejected')).toBe(true);
  expect(f.service.resourceCount()).toBe(0);
  abort.abort();
  observation.dispose();
});
it('reserves attachment ownership synchronously and waits for late opens and actual native destruction', async () => {
  const f = fixture();
  const late = Promise.withResolvers<{ stream: Target; close(): Promise<void> }>();
  f.openStream.mockImplementation(() => late.promise);
  const session = await f.create();
  await f.service.claim(session.id);
  await f.service.attach(session.id, new Socket());
  expect(() => f.service.attach(session.id, new Socket())).toThrow();
  let closed = false;
  const closing = f.service.closeSession(session.id).then(() => {
    closed = true;
  });
  await setImmediate();
  expect(closed).toBe(false);
  const target = new Target();
  late.resolve({
    stream: target,
    close: async () => {
      if (target.closed) return;
      const done = new Promise<void>((resolve) => target.once('close', resolve));
      target.destroy();
      await done;
    },
  });
  await vi.waitFor(() => expect(target.releaseDestroy).toBeTypeOf('function'));
  expect(closed).toBe(false);
  target.releaseDestroy!();
  await closing;
  expect(f.service.resourceCount()).toBe(0);
  await f.service.close();
});
it.each(['VNC', 'SPICE'] as const)(
  'bounds %s binary queues, rejects text and drains the target',
  async (protocol) => {
    const relay = new BinaryRelay(protocol);
    const socket = new Socket();
    const target = new Target();
    const closed = vi.fn();
    const handle = await relay.attach({
      socket,
      target: { host: '127.0.0.1', port: 1 },
      timeoutMs: 1000,
      signal: new AbortController().signal,
      openTarget: async () => target,
      onReady: vi.fn(),
      onClose: closed,
    });
    await setImmediate();
    const bytes = Buffer.alloc(1024 * 1024, 0x67);
    socket.emit('message', bytes, true);
    target.push(bytes);
    await setImmediate();
    expect(Buffer.concat(target.received)).toEqual(bytes);
    expect(Buffer.concat(socket.sent)).toEqual(bytes);
    socket.emit('message', Buffer.from('text'), false);
    expect(closed).toHaveBeenCalledWith(protocol + '_PROTOCOL_ERROR');
    let drained = false;
    const close = handle.close().then(() => {
      drained = true;
    });
    await setImmediate();
    expect(drained).toBe(false);
    target.releaseDestroy!();
    await close;
    expect(socket.listenerCount('message')).toBe(0);
  },
);

it('resolves a saved reference only inside a single claim and joins a canceled claim before closing its session', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<string>();
  f.credentials.mockImplementation(() => pending.promise);
  const session = await f.create();
  expect(f.credentials).not.toHaveBeenCalled();
  const claiming = f.service.claim(session.id);
  const canceled = expect(claiming).rejects.toThrow();
  await vi.waitFor(() => expect(f.credentials).toHaveBeenCalledOnce());
  expect(() => f.service.canAttach(session.id)).toThrow();
  let closed = false;
  const closing = f.service.closeSession(session.id).then(() => {
    closed = true;
  });
  await setImmediate();
  expect(closed).toBe(false);
  pending.resolve('LATE_PRIVATE_SECRET');
  await canceled;
  await closing;
  expect(f.service.resourceCount()).toBe(0);
  await f.service.close();
});
it('binds allocated sessions before publication and rolls back failed binding without leaving claims or timers', async () => {
  const f = fixture();
  let allocated = '';
  const row = await f.service.create(
    { protocol: 'vnc', bookmarkId: f.id },
    new AbortController().signal,
    (id) => {
      allocated = id;
      expect(f.service.get(id).id).toBe(id);
    },
  );
  expect(row.id).toBe(allocated);
  await f.service.closeSession(row.id);
  await expect(
    f.service.create({ protocol: 'vnc', bookmarkId: f.id }, new AbortController().signal, () => {
      throw Error('BIND_FAILED');
    }),
  ).rejects.toThrow('BIND_FAILED');
  expect(f.service.list()).toEqual([]);
  await f.service.close();
});
