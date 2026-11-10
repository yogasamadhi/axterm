import { NativeError } from '@axterm/infra-desktop-native';
import { randomUUID } from 'node:crypto';
import {
  shell,
  WebContentsView,
  type BrowserWindow,
  type WebContents,
  type Session,
} from 'electron';
import {
  nativeWebViewActionSchema,
  nativeWebViewAuthResponseSchema,
  nativeWebViewCreateSchema,
  nativeWebViewPresentationSchema,
  nativeWebViewStateSchema,
  nativeWebUrlSchema,
  type NativeWebViewAction,
  type NativeWebViewAuthResponse,
  type NativeWebViewCreate,
  type NativeWebViewPresentation,
  type NativeWebViewState,
} from '@axterm/infra-desktop-native';

interface PendingAuthentication {
  id: string;
  callback(username?: string, password?: string): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ManagedWebView {
  owner: BrowserWindow;
  windowId: string;
  retire(): void;
  releaseKeyboard?: () => void;
  closing?: Promise<true>;
  view: WebContentsView;
  session: Session;
  initialUrl: string;
  state: NativeWebViewState['state'];
  visible: boolean;
  title: string;
  blockedUrl?: string;
  errorCode?: string;
  authChallenge?: NativeWebViewState['authChallenge'];
  pendingAuthentication?: PendingAuthentication;
  downloadListener: (
    event: Electron.Event,
    item: Electron.DownloadItem,
    contents: WebContents,
  ) => void;
}

const AUTH_TIMEOUT_MS = 2 * 60_000;
const WEB_PARTITION = 'persist:axterm-web';

interface NativeWebViewControllerOptions {
  attachKeyboard?: (
    window: BrowserWindow,
    contents: WebContents,
    id: string,
    visible: () => boolean,
  ) => () => void;
  createView?: (options: ConstructorParameters<typeof WebContentsView>[0]) => WebContentsView;
  openExternal?: (url: string) => Promise<void>;
}

export class NativeWebViewController {
  private readonly views = new Map<string, ManagedWebView>();

  constructor(
    private readonly getWindow: (
      id: string,
    ) => { window: BrowserWindow; signal: AbortSignal } | undefined,
    private readonly options: NativeWebViewControllerOptions = {},
  ) {}

  async create(input: NativeWebViewCreate, signal: AbortSignal): Promise<NativeWebViewState> {
    signal.throwIfAborted();
    const command = nativeWebViewCreateSchema.parse(input);
    if (this.views.has(command.id)) throw new NativeWebViewConflictError();
    if (this.views.size >= 8) throw new NativeWebViewUnavailableError('WEB_VIEW_LIMIT');
    const identity = this.getWindow(command.windowId);
    if (!identity || identity.signal.aborted || identity.window.isDestroyed())
      throw new NativeError('FORBIDDEN');
    const owner = identity.window;
    const view = (this.options.createView ?? ((options) => new WebContentsView(options)))({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        partition: WEB_PARTITION,
      },
    });
    const managed: ManagedWebView = {
      owner,
      windowId: command.windowId,
      retire: () => identity.signal.removeEventListener('abort', retired),
      view,
      session: view.webContents.session,
      initialUrl: command.url,
      state: 'created',
      visible: false,
      title: '',
      downloadListener: (event, _item, downloadContents) => {
        if (downloadContents.id !== view.webContents.id) return;
        event.preventDefault();
        managed.errorCode = 'DOWNLOAD_BLOCKED';
      },
    };
    const retired = () => {
      void this.close(command.windowId, command.id, new AbortController().signal).catch(() => {});
    };
    this.views.set(command.id, managed);
    identity.signal.addEventListener('abort', retired, { once: true });
    try {
      owner.contentView.addChildView(view);
      const releaseKeyboard = this.options.attachKeyboard?.(
        owner,
        view.webContents,
        command.id,
        () => managed.visible && !managed.closing,
      );
      if (releaseKeyboard) managed.releaseKeyboard = releaseKeyboard;
      view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
      view.setVisible(false);
      if (command.userAgent) view.webContents.setUserAgent(command.userAgent);
      this.installSecurity(command.id, managed);
      managed.state = 'loading';
      void view.webContents.loadURL(command.url).catch(() => {
        if (!this.views.has(command.id) || managed.closing) return;
        managed.state = 'failed';
        managed.errorCode = 'WEB_LOAD_FAILED';
      });
      if (signal.aborted || identity.signal.aborted) {
        await this.close(command.windowId, command.id, new AbortController().signal);
        throw new NativeError('CANCELLED');
      }
      return await this.state(command.windowId, command.id, signal);
    } catch {
      await this.close(command.windowId, command.id, new AbortController().signal);
      throw new NativeError('UNAVAILABLE');
    }
  }

  async state(windowId: string, id: string, signal: AbortSignal): Promise<NativeWebViewState> {
    signal.throwIfAborted();
    const managed = this.require(windowId, id);
    const currentUrl = normalizedWebUrl(managed.view.webContents.getURL()) ?? managed.initialUrl;
    return nativeWebViewStateSchema.parse({
      id,
      state: managed.authChallenge ? 'auth-required' : managed.state,
      url: currentUrl,
      title: managed.title,
      loading: managed.view.webContents.isLoading(),
      canGoBack: managed.view.webContents.navigationHistory.canGoBack(),
      canGoForward: managed.view.webContents.navigationHistory.canGoForward(),
      zoomFactor: managed.view.webContents.getZoomFactor(),
      visible: managed.visible,
      ...(managed.blockedUrl ? { blockedUrl: managed.blockedUrl } : {}),
      ...(managed.errorCode ? { errorCode: managed.errorCode } : {}),
      ...(managed.authChallenge ? { authChallenge: managed.authChallenge } : {}),
    });
  }

  async present(
    windowId: string,
    id: string,
    input: NativeWebViewPresentation,
    signal: AbortSignal,
  ): Promise<NativeWebViewState> {
    signal.throwIfAborted();
    const command = nativeWebViewPresentationSchema.parse(input);
    const managed = this.require(windowId, id);
    if (command.bounds) managed.view.setBounds(clampBounds(command.bounds, managed.owner));
    if (command.visible !== undefined) {
      managed.visible = command.visible && !managed.authChallenge;
      managed.view.setVisible(managed.visible);
    }
    return this.state(windowId, id, signal);
  }

  async perform(
    windowId: string,
    id: string,
    input: NativeWebViewAction,
    signal: AbortSignal,
  ): Promise<NativeWebViewState> {
    signal.throwIfAborted();
    const command = nativeWebViewActionSchema.parse(input);
    const managed = this.require(windowId, id);
    const contents = managed.view.webContents;
    if (command.action === 'back' && contents.navigationHistory.canGoBack())
      contents.navigationHistory.goBack();
    else if (command.action === 'forward' && contents.navigationHistory.canGoForward())
      contents.navigationHistory.goForward();
    else if (command.action === 'reload') contents.reload();
    else if (command.action === 'stop') contents.stop();
    else if (command.action === 'set-zoom') contents.setZoomFactor(command.zoomFactor!);
    else if (command.action === 'open-external')
      await (this.options.openExternal ?? shell.openExternal)(
        normalizedWebUrl(contents.getURL()) ?? managed.initialUrl,
      );
    else if (command.action === 'open-blocked-external') {
      if (!managed.blockedUrl) throw new NativeWebViewConflictError();
      await (this.options.openExternal ?? shell.openExternal)(managed.blockedUrl);
      delete managed.blockedUrl;
    }
    return this.state(windowId, id, signal);
  }

  async authenticate(
    windowId: string,
    id: string,
    input: NativeWebViewAuthResponse,
    signal: AbortSignal,
  ): Promise<NativeWebViewState> {
    signal.throwIfAborted();
    const command = nativeWebViewAuthResponseSchema.parse(input);
    const managed = this.require(windowId, id);
    const pending = managed.pendingAuthentication;
    if (!pending || pending.id !== command.challengeId) throw new NativeWebViewConflictError();
    clearTimeout(pending.timer);
    delete managed.pendingAuthentication;
    delete managed.authChallenge;
    pending.callback(command.username || undefined, command.password || undefined);
    managed.visible = false;
    managed.view.setVisible(false);
    return this.state(windowId, id, signal);
  }

  close(windowId: string, id: string, signal: AbortSignal): Promise<true> {
    signal.throwIfAborted();
    const managed = this.views.get(id);
    if (!managed) return Promise.resolve(true);
    if (managed.windowId !== windowId) return Promise.reject(new NativeError('FORBIDDEN'));
    if (managed.closing) return managed.closing;
    const task = (async (): Promise<true> => {
      managed.retire();
      managed.releaseKeyboard?.();
      delete managed.releaseKeyboard;
      this.cancelAuthentication(managed);
      const contents = managed.view.webContents;
      managed.session.off('will-download', managed.downloadListener);
      managed.visible = false;
      if (!managed.owner.isDestroyed()) managed.owner.contentView.removeChildView(managed.view);
      if (!contents.isDestroyed())
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            contents.off('destroyed', done);
            resolve();
          };
          const timer = setTimeout(() => {
            contents.off('destroyed', done);
            reject(new NativeError('TIMEOUT'));
          }, 5000);
          contents.once('destroyed', done);
          contents.close({ waitForBeforeUnload: false });
          if (contents.isDestroyed()) done();
        });
      this.views.delete(id);
      return true;
    })();
    managed.closing = task;
    void task.catch(() => {
      if (managed.closing === task) delete managed.closing;
    });
    return task;
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.views].map(([id, value]) =>
        this.close(value.windowId, id, new AbortController().signal),
      ),
    );
    if (results.some((result) => result.status === 'rejected') || this.views.size)
      throw new NativeError('UNAVAILABLE');
  }

  resourceCount(): number {
    return this.views.size;
  }

  private installSecurity(id: string, managed: ManagedWebView) {
    const contents = managed.view.webContents;
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.on('will-download', managed.downloadListener);
    contents.setWindowOpenHandler(({ url }) => {
      const target = normalizedWebUrl(url);
      if (target) managed.blockedUrl = target;
      else managed.errorCode = 'UNSAFE_NAVIGATION_BLOCKED';
      return { action: 'deny' };
    });
    const guardNavigation = (event: Electron.Event, url: string) => {
      const target = normalizedWebUrl(url);
      if (target) return;
      event.preventDefault();
      managed.errorCode = 'UNSAFE_NAVIGATION_BLOCKED';
    };
    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);
    contents.on('did-start-loading', () => {
      managed.state = 'loading';
      delete managed.errorCode;
    });
    contents.on('did-finish-load', () => {
      managed.state = 'ready';
      managed.title = contents.getTitle().slice(0, 1_024);
    });
    contents.on('page-title-updated', (_event, title) => {
      managed.title = title.slice(0, 1_024);
    });
    contents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      managed.state = 'failed';
      managed.errorCode = `WEB_LOAD_${Math.abs(errorCode)}`.slice(0, 100);
    });
    contents.on('login', (event, _details, authInfo, callback) => {
      event.preventDefault();
      this.cancelAuthentication(managed);
      const challengeId = randomUUID();
      const timer = setTimeout(() => {
        if (!this.views.has(id) || managed.pendingAuthentication?.id !== challengeId) return;
        delete managed.pendingAuthentication;
        delete managed.authChallenge;
        callback();
        managed.state = 'failed';
        managed.errorCode = 'WEB_AUTH_TIMEOUT';
      }, AUTH_TIMEOUT_MS);
      timer.unref();
      managed.pendingAuthentication = { id: challengeId, callback, timer };
      managed.authChallenge = {
        id: challengeId,
        host: authInfo.host.slice(0, 253),
        ...(authInfo.realm ? { realm: authInfo.realm.slice(0, 512) } : {}),
        isProxy: authInfo.isProxy,
      };
      managed.visible = false;
      managed.view.setVisible(false);
    });
  }

  private cancelAuthentication(managed: ManagedWebView) {
    const pending = managed.pendingAuthentication;
    if (!pending) return;
    clearTimeout(pending.timer);
    delete managed.pendingAuthentication;
    delete managed.authChallenge;
    pending.callback();
  }

  private require(windowId: string, id: string): ManagedWebView {
    const managed = this.views.get(id);
    if (!managed) throw new NativeError('NOT_FOUND');
    const identity = this.getWindow(windowId);
    if (
      managed.windowId !== windowId ||
      !identity ||
      identity.window !== managed.owner ||
      identity.signal.aborted
    )
      throw new NativeError('FORBIDDEN');
    if (managed.closing || managed.view.webContents.isDestroyed()) throw new NativeError('CLOSED');
    return managed;
  }
}

export class NativeWebViewNotFoundError extends Error {}
export class NativeWebViewConflictError extends Error {}
export class NativeWebViewUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function normalizedWebUrl(value: string): string | undefined {
  const parsed = nativeWebUrlSchema.safeParse(value);
  return parsed.success ? new URL(parsed.data).toString() : undefined;
}

function clampBounds(
  bounds: NativeWebViewPresentation['bounds'] & {},
  owner: BrowserWindow,
): NativeWebViewPresentation['bounds'] & {} {
  const zoom = owner.webContents.getZoomFactor();
  bounds = {
    x: Math.round(bounds.x * zoom),
    y: Math.round(bounds.y * zoom),
    width: Math.max(1, Math.round(bounds.width * zoom)),
    height: Math.max(1, Math.round(bounds.height * zoom)),
  };
  const content = owner.getContentBounds();
  const x = Math.max(0, Math.min(bounds.x, Math.max(0, content.width - 1)));
  const y = Math.max(0, Math.min(bounds.y, Math.max(0, content.height - 1)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(bounds.width, content.width - x)),
    height: Math.max(1, Math.min(bounds.height, content.height - y)),
  };
}
