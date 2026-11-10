import { randomUUID } from 'node:crypto';
import { expect, it, vi, afterEach } from 'vitest';
import type { NativeWebViews, CatalogQueries } from '@axterm/plugin-api/host';
import type { NativeWebViewCreate, NativeWebViewState } from '@axterm/plugin-api/remote-desktop';
import { WebSessions } from '../../packages/plugins/remote-desktop/src/application/web-sessions.ts';
import { WebSessionObservation } from '../../packages/plugins/remote-desktop/src/application/web-observation.ts';
import { WebSessionProjection } from '../../packages/plugins/remote-desktop/src/client/web-projection.ts';
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());
function fixture() {
  const bookmarkId = randomUUID(),
    windowId = randomUUID(),
    states = new Map<string, NativeWebViewState>();
  const catalog = {
    getBookmark: () => ({
      id: bookmarkId,
      protocol: 'web',
      title: 'Website',
      description: '',
      web: { url: 'https://fixture.test/', userAgent: null, hideAddressBar: false },
    }),
  } as unknown as Pick<CatalogQueries, 'getBookmark'>;
  const native: NativeWebViews = {
    create: vi.fn(async (input: NativeWebViewCreate) => {
      const state: NativeWebViewState = {
        id: input.id,
        url: input.url,
        title: 'Website',
        state: 'ready',
        visible: false,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        zoomFactor: 1,
      };
      states.set(input.id, state);
      return state;
    }),
    state: vi.fn(async (_windowId, id) => {
      const value = states.get(id);
      if (!value) throw { code: 'NOT_FOUND' };
      return value;
    }),
    present: vi.fn(async (_windowId, id, input) => {
      const state = { ...states.get(id)!, visible: input.visible ?? false };
      states.set(id, state);
      return state;
    }),
    perform: vi.fn(),
    authenticate: vi.fn(),
    close: vi.fn(async (_windowId, id) => {
      states.delete(id);
      return true as const;
    }),
  };
  return { owner: new WebSessions(catalog, native), native, bookmarkId, windowId, states };
}
it('publishes an owner-scoped baseline and ordered deltas, rejects cross-window access, and replaces state on reconnect', async () => {
  const f = fixture(),
    observation = new WebSessionObservation(f.owner, f.windowId, randomUUID()),
    stream = observation.watch(signal())[Symbol.asyncIterator](),
    projection = new WebSessionProjection();
  const baseline = (await stream.next()).value;
  expect(baseline.type).toBe('baseline');
  projection.replace(baseline);
  let allocated = '';
  const session = await f.owner.create(
    { bookmarkId: f.bookmarkId, windowId: f.windowId },
    signal(),
    (id) => {
      allocated = id;
      expect(f.native.create).not.toHaveBeenCalled();
    },
  );
  expect(allocated).toBe(session.id);
  expect(f.owner.list(randomUUID())).toEqual([]);
  expect(() => f.owner.get(session.id, randomUUID())).toThrow();
  projection.apply((await stream.next()).value);
  projection.apply((await stream.next()).value);
  await f.owner.present(session.id, f.windowId, { visible: true }, signal());
  expect(projection.apply((await stream.next()).value).sessions[0]!.visible).toBe(true);
  await f.owner.closeSession(session.id, f.windowId);
  expect(projection.apply((await stream.next()).value).sessions).toEqual([]);
  observation.dispose();
  await f.owner.close();
  expect(f.states.size).toBe(0);
});
it('reserves pending admissions before native I/O, joins late cancellation, and retains failed cleanup until retry', async () => {
  const f = fixture(),
    late = Promise.withResolvers<NativeWebViewState>(),
    abort = new AbortController();
  vi.mocked(f.native.create).mockImplementationOnce(() => late.promise);
  let id = '';
  const task = f.owner.create(
    { bookmarkId: f.bookmarkId, windowId: f.windowId },
    abort.signal,
    (value) => {
      id = value;
    },
  );
  const rejected = expect(task).rejects.toThrow();
  await Promise.resolve();
  abort.abort();
  vi.mocked(f.native.close).mockRejectedValueOnce(Error('native undrained'));
  late.resolve({
    id,
    url: 'https://fixture.test/',
    title: '',
    state: 'ready',
    visible: false,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
  });
  await rejected;
  expect(f.owner.list(f.windowId)).toHaveLength(1);
  expect(f.owner.get(id).errorCode).toBe('WEB_VIEW_CLEANUP_UNCERTAIN');
  await f.owner.closeSession(id, f.windowId);
  expect(f.owner.list(f.windowId)).toEqual([]);
  await f.owner.close();
});
it('uses one Host polling loop and drains retired window views without replaying network admissions', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const session = await f.owner.create(
    { bookmarkId: f.bookmarkId, windowId: f.windowId },
    signal(),
    () => {},
  );
  f.states.get(session.id)!.canGoBack = true;
  await vi.advanceTimersByTimeAsync(750);
  expect(f.owner.get(session.id).canGoBack).toBe(true);
  f.states.delete(session.id);
  await vi.advanceTimersByTimeAsync(750);
  expect(f.owner.list(f.windowId)).toEqual([]);
  expect(f.native.create).toHaveBeenCalledOnce();
  await f.owner.close();
  expect(vi.getTimerCount()).toBe(0);
});
