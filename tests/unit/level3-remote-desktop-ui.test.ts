import { expect, it, vi, afterEach } from 'vitest';
import type {
  ConnectionGeneration,
  ConnectionWebSocket,
} from '../../packages/infra/connection/src/client/index.ts';
import { VendorSocketRoutes } from '../../packages/plugins/remote-desktop/src/client/ui/vendor-sockets.ts';
import { RemoteDesktopWorkspace } from '../../packages/plugins/remote-desktop/src/client/ui/workspace-owner.ts';
import { WorkspaceStore } from '../../packages/plugins/workspace/src/client/store.ts';
import type { RemoteDesktopState } from '../../packages/plugins/remote-desktop/src/client/index.ts';
import { remoteDesktopSessionSchema } from '@axterm/plugin-api/remote-desktop';
afterEach(() => vi.unstubAllGlobals());
class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 1;
  binaryType = '';
  bufferedAmount = 0;
  sent: Uint8Array[] = [];
  constructor(readonly url: string) {
    super();
  }
  send(bytes: Uint8Array) {
    this.sent.push(bytes);
  }
  close = vi.fn(() => {});
  end() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}
function socketsFixture() {
  vi.stubGlobal(
    'CloseEvent',
    class extends Event {
      readonly code = 1000;
      readonly wasClean = true;
    },
  );
  let generation: ConnectionGeneration | undefined = { id: 1, host: { home: '/fixture' } };
  const listeners = new Set<() => void>();
  const physical: FakeSocket[] = [];
  const carrier = {
    generation: {
      getSnapshot: () => generation,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    },
    openWebSocket: vi.fn((path: string) => {
      const value = new FakeSocket(path);
      physical.push(value);
      return value as unknown as ConnectionWebSocket;
    }),
  };
  const original = FakeSocket as unknown as typeof WebSocket,
    surface = { WebSocket: original };
  const routes = new VendorSocketRoutes(carrier, surface);
  return {
    routes,
    physical,
    carrier,
    surface,
    original,
    listeners,
    retire: () => {
      generation = undefined;
      for (const fn of listeners) fn();
    },
  };
}
it('routes exactly registered vendor URLs through the authenticated carrier, bounds bytes and restores the constructor after physical drain', async () => {
  const f = socketsFixture(),
    id = crypto.randomUUID(),
    binding = f.routes.bind(id),
    vendor = new f.surface.WebSocket(binding.url);
  expect(f.carrier.openWebSocket).toHaveBeenCalledWith('/remote-desktop/stream?id=' + id);
  expect(binding.url).not.toContain(id);
  expect(() => new f.surface.WebSocket(binding.url)).toThrow('UNAVAILABLE');
  new f.surface.WebSocket('ws://external.invalid/');
  expect(f.carrier.openWebSocket).toHaveBeenCalledOnce();
  vendor.send(new Uint8Array([1, 2]));
  expect(f.physical[0]!.sent).toEqual([new Uint8Array([1, 2])]);
  const message = vi.fn();
  vendor.addEventListener('message', message);
  f.physical[0]!.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([3]).buffer }));
  expect(message).toHaveBeenCalledOnce();
  f.physical[0]!.bufferedAmount = 8 * 1024 * 1024;
  expect(() => vendor.send(new Uint8Array([4]))).toThrow('BOUNDS');
  let drained = false;
  const closing = binding.close().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  f.physical[0]!.end();
  await closing;
  await f.routes.close();
  expect(f.surface.WebSocket).toBe(f.original);
  expect(f.listeners.size).toBe(0);
});
it('fences a vendor channel on generation loss, rejects oversized frames and never reopens it', async () => {
  const f = socketsFixture(),
    binding = f.routes.bind(crypto.randomUUID(), 2),
    vendor = new f.surface.WebSocket(binding.url);
  const messages = vi.fn();
  vendor.onmessage = messages;
  f.physical[0]!.dispatchEvent(
    new MessageEvent('message', { data: new ArrayBuffer(4 * 1024 * 1024 + 1) }),
  );
  expect(messages).not.toHaveBeenCalled();
  expect(f.physical[0]!.close).toHaveBeenCalled();
  f.retire();
  expect(() => new f.surface.WebSocket(binding.url)).toThrow();
  f.physical[0]!.end();
  await binding.close();
  await f.routes.close();
  expect(f.carrier.openWebSocket).toHaveBeenCalledOnce();
});
function ownerFixture() {
  const session = remoteDesktopSessionSchema.parse({
    id: crypto.randomUUID(),
    bookmarkId: crypto.randomUUID(),
    title: 'VNC fixture',
    protocol: 'vnc',
    state: 'created',
    viewOnly: false,
    clipViewport: false,
    scaleViewport: true,
    qualityLevel: 6,
    compressionLevel: 2,
    shared: true,
    showDotCursor: true,
    clipboard: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const generation = crypto.randomUUID();
  let state: RemoteDesktopState = {
    status: 'ready',
    baseline: { type: 'baseline', generation, revision: 0, sessions: [] },
  };
  const listeners = new Set<() => void>();
  const model = {
    loadVnc: vi.fn(),
    claimCredentials: vi.fn(),
    resize: vi.fn(),
    getSnapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    create: vi.fn(async () => session),
    getCommandOutcome: vi.fn(async () => ({ status: 'accepted' as const, id: session.id })),
    close: vi.fn(async () => {}),
  };
  const store = new WorkspaceStore(),
    sockets = { bind: vi.fn(), close: vi.fn(async () => {}) };
  const owner = new RemoteDesktopWorkspace(model, store, sockets as unknown as VendorSocketRoutes);
  const publish = (value: RemoteDesktopState) => {
    state = value;
    for (const fn of [...listeners]) fn();
  };
  return {
    session,
    generation,
    model,
    store,
    owner,
    sockets,
    listeners,
    publish,
    accept: () =>
      publish({
        status: 'ready',
        baseline: { type: 'baseline', generation, revision: 1, sessions: [session] },
      }),
  };
}
it('waits for accepted metadata before activating a view and joins renderer drain before Host cleanup', async () => {
  const f = ownerFixture(),
    request = {
      protocol: 'vnc' as const,
      bookmarkId: f.session.bookmarkId,
      temporaryPassword: 'TRANSIENT_RENDER_SECRET',
    },
    opening = f.owner.open(request);
  await vi.waitFor(() => expect(f.listeners.size).toBe(2));
  expect(f.store.getSnapshot().tabs).toEqual([]);
  f.accept();
  expect(await opening).toBe(f.session.id);
  expect(f.store.getSnapshot().activeTabId).toBe(f.session.id);
  expect(JSON.stringify(f.store.getSnapshot())).not.toContain('TRANSIENT');
  const pending = Promise.withResolvers<void>(),
    dispose = vi.fn(() => pending.promise);
  f.owner.surface.attach(f.session.id, { dispose });
  let done = false;
  const closing = f.owner.closeView(f.session.id).then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(f.model.close).not.toHaveBeenCalled();
  expect(done).toBe(false);
  pending.resolve();
  await closing;
  expect(f.model.close).toHaveBeenCalledWith(f.session.id, f.generation);
  await f.owner.close();
  await f.store.dispose();
  expect(f.listeners.size).toBe(0);
});
it('cleans a lost create by exact outcome even before metadata arrives and never resubmits it', async () => {
  const f = ownerFixture();
  f.model.create.mockRejectedValueOnce(Error('LOST_RESPONSE'));
  await expect(
    f.owner.open({ protocol: 'vnc', bookmarkId: f.session.bookmarkId }),
  ).rejects.toThrow();
  expect(f.model.close).toHaveBeenCalledWith(f.session.id, f.generation);
  expect(f.model.create).toHaveBeenCalledOnce();
  expect(f.model.getCommandOutcome).toHaveBeenCalledOnce();
  await f.owner.close();
  await f.store.dispose();
});
it('retains a failed close for retry and retires views without closing an old id in the replacement Host', async () => {
  const f = ownerFixture();
  f.accept();
  await f.owner.open({ protocol: 'vnc', bookmarkId: f.session.bookmarkId });
  f.model.close.mockRejectedValueOnce(Error('CLOSE_UNKNOWN'));
  await expect(f.owner.closeView(f.session.id)).rejects.toThrow();
  expect(f.store.getSnapshot().tabs).toHaveLength(1);
  await f.owner.closeView(f.session.id);
  expect(f.store.getSnapshot().tabs).toEqual([]);
  await f.owner.close();
  await f.store.dispose();
  const g = ownerFixture();
  g.accept();
  await g.owner.open({ protocol: 'vnc', bookmarkId: g.session.bookmarkId });
  g.publish({
    status: 'ready',
    baseline: { type: 'baseline', generation: crypto.randomUUID(), revision: 0, sessions: [] },
  });
  await vi.waitFor(() => expect(g.store.getSnapshot().tabs).toEqual([]));
  expect(g.model.close).not.toHaveBeenCalled();
  await g.owner.close();
  await g.store.dispose();
});
it('joins canceled late admission and cleans its exact resource without opening a protocol view', async () => {
  const f = ownerFixture(),
    pending = Promise.withResolvers<typeof f.session>(),
    abort = new AbortController();
  f.model.create.mockImplementation(() => pending.promise);
  const opening = f.owner.open({ protocol: 'vnc', bookmarkId: f.session.bookmarkId }, abort.signal);
  const rejected = expect(opening).rejects.toThrow();
  await vi.waitFor(() => expect(f.model.create).toHaveBeenCalledOnce());
  abort.abort();
  pending.resolve(f.session);
  await rejected;
  expect(f.model.close).toHaveBeenCalledWith(f.session.id, f.generation);
  expect(f.store.getSnapshot().tabs).toEqual([]);
  await f.owner.close();
  await f.store.dispose();
});

it('admits exactly two SPICE vendor channels through the carrier and leaves unrelated sockets untouched', async () => {
  const f = socketsFixture(),
    id = crypto.randomUUID(),
    binding = f.routes.bind(id, 2),
    first = new f.surface.WebSocket(binding.url),
    second = new f.surface.WebSocket(binding.url);
  new f.surface.WebSocket('ws://unrelated.invalid/');
  expect(f.carrier.openWebSocket).toHaveBeenCalledTimes(2);
  expect(f.carrier.openWebSocket.mock.calls.map(([url]) => url)).toEqual([
    '/remote-desktop/stream?id=' + id,
    '/remote-desktop/stream?id=' + id,
  ]);
  expect(() => new f.surface.WebSocket(binding.url)).toThrow('UNAVAILABLE');
  const closed = binding.close();
  expect(first.readyState).toBe(1);
  expect(second.readyState).toBe(1);
  for (const physical of f.physical) physical.end();
  await closed;
  await f.routes.close();
  expect(f.surface.WebSocket).toBe(f.original);
  expect(f.listeners.size).toBe(0);
});
