import type { WebContentsView } from 'electron';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect, it, vi, afterEach } from 'vitest';
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() }, WebContentsView: class {} }));
import { NativeWebViewController } from '../../apps/desktop/src/shell/web-views.ts';
afterEach(() => vi.useRealTimers());
function fixture() {
  let nextViewId = 1;
  const windowId = randomUUID(),
    life = new AbortController(),
    views: ReturnType<typeof createTestView>[] = []; // Minimal Electron boundary fixture.
  const owner = {
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 1000, height: 700 }),
    webContents: { getZoomFactor: () => 2 },
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  };
  function createTestView(options: ConstructorParameters<typeof WebContentsView>[0]) {
    const emitter = new EventEmitter();
    let destroyed = false,
      url = '',
      zoom = 1;
    const contents = Object.assign(emitter, {
      id: nextViewId++,
      session: {
        on: vi.fn(),
        off: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
      },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      loadURL: async (value: string) => {
        url = value;
      },
      getURL: () => url,
      getTitle: () => 'Fixture',
      isLoading: () => false,
      getZoomFactor: () => zoom,
      setZoomFactor: (value: number) => {
        zoom = value;
      },
      setUserAgent: vi.fn(),
      setWindowOpenHandler: vi.fn(
        (_handler: (details: { url: string }) => { action: string }) => {},
      ),
      isDestroyed: () => destroyed,
      close: () => {
        destroyed = true;
        emitter.emit('destroyed');
      },
    });
    const view = { webContents: contents, options, setBounds: vi.fn(), setVisible: vi.fn() };
    return view;
  }
  const external = vi.fn(async () => {});
  const controller = new NativeWebViewController(
    (id) => (id === windowId ? { window: owner as never, signal: life.signal } : undefined),
    {
      openExternal: external,
      createView: (options) => {
        const view = createTestView(options);
        views.push(view);
        return view as never;
      },
    },
  );
  return { controller, views, windowId, life, external };
}
const signal = () => new AbortController().signal;
it('binds each sandboxed view to one window, uses separate partition and zoom-correct bounds, denies privileged navigation and popups', async () => {
  const f = fixture(),
    id = randomUUID();
  await expect(
    f.controller.create(
      { id, windowId: randomUUID(), url: 'https://example.test/', userAgent: null },
      signal(),
    ),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await f.controller.create(
    { id, windowId: f.windowId, url: 'https://example.test/', userAgent: 'Fixture' },
    signal(),
  );
  const v = f.views[0]!;
  expect(v.options!.webPreferences).toMatchObject({
    partition: 'persist:axterm-web',
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false,
    webSecurity: true,
  });
  expect(v.options!.webPreferences).not.toHaveProperty('preload');
  await expect(f.controller.state(randomUUID(), id, signal())).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  await f.controller.present(
    f.windowId,
    id,
    { visible: true, bounds: { x: 10, y: 20, width: 200, height: 100 } },
    signal(),
  );
  expect(v.setBounds).toHaveBeenLastCalledWith({ x: 20, y: 40, width: 400, height: 200 });
  const event = { preventDefault: vi.fn() };
  v.webContents.emit('will-navigate', event, 'file:///etc/passwd');
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(
    v.webContents.setWindowOpenHandler.mock.calls[0]![0]({ url: 'https://popup.test/' }),
  ).toEqual({ action: 'deny' });
  await f.controller.perform(f.windowId, id, { action: 'open-blocked-external' }, signal());
  expect(f.external).toHaveBeenCalledWith('https://popup.test/');
  await f.controller.close(f.windowId, id, signal());
  expect(f.controller.resourceCount()).toBe(0);
});
it('uses transient single-use Basic authentication and retires views when their exact window identity ends', async () => {
  const f = fixture(),
    id = randomUUID();
  await f.controller.create(
    { id, windowId: f.windowId, url: 'https://example.test/', userAgent: null },
    signal(),
  );
  const callback = vi.fn();
  f.views[0]!.webContents.emit(
    'login',
    { preventDefault: vi.fn() },
    {},
    { host: 'example.test', realm: 'Operators', isProxy: false },
    callback,
  );
  const state = await f.controller.state(f.windowId, id, signal());
  expect(state.state).toBe('auth-required');
  const input = {
    challengeId: state.authChallenge!.id,
    username: 'operator',
    password: 'transient-only',
  };
  await f.controller.authenticate(f.windowId, id, input, signal());
  expect(callback).toHaveBeenCalledWith('operator', 'transient-only');
  expect(JSON.stringify(await f.controller.state(f.windowId, id, signal()))).not.toContain(
    input.password,
  );
  await expect(f.controller.authenticate(f.windowId, id, input, signal())).rejects.toThrow();
  f.life.abort();
  await vi.waitFor(() => expect(f.controller.resourceCount()).toBe(0));
  await f.controller.dispose();
});
it('keeps failed native destruction owned and permits a later explicit cleanup retry', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    id = randomUUID();
  await f.controller.create(
    { id, windowId: f.windowId, url: 'https://example.test/', userAgent: null },
    signal(),
  );
  const view = f.views[0]!,
    close = view.webContents.close;
  view.webContents.close = () => {};
  const rejected = expect(f.controller.close(f.windowId, id, signal())).rejects.toMatchObject({
    code: 'TIMEOUT',
  });
  await vi.advanceTimersByTimeAsync(5001);
  await rejected;
  expect(f.controller.resourceCount()).toBe(1);
  view.webContents.close = close;
  await f.controller.close(f.windowId, id, signal());
  expect(f.controller.resourceCount()).toBe(0);
});
