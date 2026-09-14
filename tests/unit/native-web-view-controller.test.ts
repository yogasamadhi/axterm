import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  instances: [] as Array<{
    bounds: unknown;
    visible: boolean;
    options: unknown;
    webContents: Record<string, unknown>;
    handlers: Map<string, (...args: never[]) => unknown>;
    windowOpenHandler: ((details: { url: string }) => { action: string }) | undefined;
    permissionRequest: ((...args: never[]) => unknown) | undefined;
    permissionCheck: ((...args: never[]) => unknown) | undefined;
  }>,
  openExternal: vi.fn(async () => undefined),
  createView: undefined as undefined | ((options: unknown) => unknown),
}));

vi.mock('electron', () => {
  class WebContentsView {
    bounds: unknown;
    visible = false;
    readonly handlers = new Map<string, (...args: never[]) => unknown>();
    windowOpenHandler?: (details: { url: string }) => { action: string };
    permissionRequest?: (...args: never[]) => unknown;
    permissionCheck?: (...args: never[]) => unknown;
    readonly history = {
      back: false,
      forward: false,
      canGoBack: () => this.history.back,
      canGoForward: () => this.history.forward,
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    readonly session = {
      on: vi.fn(),
      off: vi.fn(),
      setPermissionRequestHandler: vi.fn((handler: (...args: never[]) => unknown) => {
        this.permissionRequest = handler;
      }),
      setPermissionCheckHandler: vi.fn((handler: (...args: never[]) => unknown) => {
        this.permissionCheck = handler;
      }),
    };
    readonly webContents = {
      id: electronMock.instances.length + 1,
      session: this.session,
      navigationHistory: this.history,
      loadURL: vi.fn(async (url: string) => {
        this.url = url;
      }),
      getURL: vi.fn(() => this.url),
      getTitle: vi.fn(() => 'Fixture title'),
      isLoading: vi.fn(() => false),
      getZoomFactor: vi.fn(() => this.zoom),
      setZoomFactor: vi.fn((value: number) => {
        this.zoom = value;
      }),
      setUserAgent: vi.fn(),
      setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: string }) => {
        this.windowOpenHandler = handler;
      }),
      on: vi.fn((name: string, handler: (...args: never[]) => unknown) => {
        this.handlers.set(name, handler);
      }),
      reload: vi.fn(),
      stop: vi.fn(),
      isDestroyed: vi.fn(() => false),
      close: vi.fn(),
    };
    private url = '';
    private zoom = 1;

    constructor(readonly options: unknown) {
      electronMock.instances.push(this as never);
    }

    setBounds(bounds: unknown) {
      this.bounds = bounds;
    }

    setVisible(visible: boolean) {
      this.visible = visible;
    }
  }
  electronMock.createView = (options) => new WebContentsView(options);
  return {
    __esModule: true,
    WebContentsView,
    shell: { openExternal: electronMock.openExternal },
  };
});

import { NativeWebViewController } from '../../apps/desktop/src/main/host-capabilities/native-web-view-controller';

function createTestView(options: unknown) {
  let url = '';
  let zoom = 1;
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const history = {
    back: false,
    forward: false,
    canGoBack: () => history.back,
    canGoForward: () => history.forward,
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  const session = {
    on: vi.fn(),
    off: vi.fn(),
    setPermissionRequestHandler: vi.fn((handler: (...args: never[]) => unknown) => {
      view.permissionRequest = handler;
    }),
    setPermissionCheckHandler: vi.fn((handler: (...args: never[]) => unknown) => {
      view.permissionCheck = handler;
    }),
  };
  const view = {
    bounds: undefined as unknown,
    visible: false,
    options,
    handlers,
    windowOpenHandler: undefined as undefined | ((details: { url: string }) => { action: string }),
    permissionRequest: undefined as undefined | ((...args: never[]) => unknown),
    permissionCheck: undefined as undefined | ((...args: never[]) => unknown),
    setBounds(bounds: unknown) {
      view.bounds = bounds;
    },
    setVisible(visible: boolean) {
      view.visible = visible;
    },
    webContents: {
      id: electronMock.instances.length + 1,
      session,
      navigationHistory: history,
      loadURL: vi.fn(async (nextUrl: string) => {
        url = nextUrl;
      }),
      getURL: vi.fn(() => url),
      getTitle: vi.fn(() => 'Fixture title'),
      isLoading: vi.fn(() => false),
      getZoomFactor: vi.fn(() => zoom),
      setZoomFactor: vi.fn((value: number) => {
        zoom = value;
      }),
      setUserAgent: vi.fn(),
      setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: string }) => {
        view.windowOpenHandler = handler;
      }),
      on: vi.fn((name: string, handler: (...args: never[]) => unknown) => {
        handlers.set(name, handler);
      }),
      reload: vi.fn(),
      stop: vi.fn(),
      isDestroyed: vi.fn(() => false),
      close: vi.fn(),
    },
  };
  electronMock.instances.push(view);
  return view;
}

describe('NativeWebViewController', () => {
  beforeEach(() => {
    electronMock.instances.length = 0;
    electronMock.openExternal.mockClear();
  });

  it('creates a sandboxed bounded view and blocks implicit external surfaces', async () => {
    const addChildView = vi.fn();
    const removeChildView = vi.fn();
    const owner = {
      isDestroyed: () => false,
      getContentBounds: () => ({ x: 0, y: 0, width: 1_000, height: 700 }),
      contentView: { addChildView, removeChildView },
    };
    const controller = new NativeWebViewController(() => owner as never, {
      createView: createTestView as never,
      openExternal: electronMock.openExternal,
    });
    const id = '11111111-1111-4111-8111-111111111111';

    await controller.create({
      id,
      url: 'https://example.test/app',
      userAgent: 'Axterm-Web-Test/1',
    });
    const view = electronMock.instances[0]!;
    expect(view.options).toEqual({
      webPreferences: expect.objectContaining({
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      }),
    });
    expect(addChildView).toHaveBeenCalledOnce();
    expect(view.webContents.setUserAgent).toHaveBeenCalledWith('Axterm-Web-Test/1');
    expect(view.permissionCheck?.()).toBe(false);
    const permissionCallback = vi.fn();
    view.permissionRequest?.(undefined as never, undefined as never, permissionCallback as never);
    expect(permissionCallback).toHaveBeenCalledWith(false);

    controller.present(id, {
      bounds: { x: 900, y: 650, width: 500, height: 500 },
      visible: true,
    });
    expect(view.bounds).toEqual({ x: 900, y: 650, width: 100, height: 50 });
    expect(view.visible).toBe(true);

    const unsafeEvent = { preventDefault: vi.fn() };
    view.handlers.get('will-navigate')?.(unsafeEvent as never, 'file:///etc/passwd' as never);
    expect(unsafeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(controller.state(id).errorCode).toBe('UNSAFE_NAVIGATION_BLOCKED');

    expect(view.windowOpenHandler?.({ url: 'https://popup.example.test/' })).toEqual({
      action: 'deny',
    });
    expect(controller.state(id).blockedUrl).toBe('https://popup.example.test/');
    await controller.perform(id, { action: 'open-blocked-external' });
    expect(electronMock.openExternal).toHaveBeenCalledWith('https://popup.example.test/');

    controller.close(id);
    expect(removeChildView).toHaveBeenCalledOnce();
    expect(view.webContents.close).toHaveBeenCalledOnce();
    expect(controller.resourceCount()).toBe(0);
  });

  it('keeps Basic authentication transient and binds the reply to one challenge', async () => {
    const owner = {
      isDestroyed: () => false,
      getContentBounds: () => ({ x: 0, y: 0, width: 1_000, height: 700 }),
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    };
    const controller = new NativeWebViewController(() => owner as never, {
      createView: createTestView as never,
      openExternal: electronMock.openExternal,
    });
    const id = '22222222-2222-4222-8222-222222222222';
    await controller.create({ id, url: 'https://auth.example.test/', userAgent: null });
    const view = electronMock.instances[0]!;
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    view.handlers.get('login')?.(
      event as never,
      {} as never,
      { host: 'auth.example.test', realm: 'Operators', isProxy: false } as never,
      callback as never,
    );
    const challenge = controller.state(id).authChallenge;
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(challenge).toMatchObject({ host: 'auth.example.test', realm: 'Operators' });
    expect(controller.state(id).visible).toBe(false);

    controller.authenticate(id, {
      challengeId: challenge!.id,
      username: 'operator',
      password: 'one-use-secret',
    });
    expect(callback).toHaveBeenCalledWith('operator', 'one-use-secret');
    expect(JSON.stringify(controller.state(id))).not.toContain('one-use-secret');
    expect(() =>
      controller.authenticate(id, {
        challengeId: challenge!.id,
        username: 'operator',
        password: 'replay',
      }),
    ).toThrow();
    controller.closeAll();
  });
});
