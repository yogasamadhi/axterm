import { randomUUID } from 'node:crypto';
import { shell, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import {
  hostWebViewActionSchema,
  hostWebViewAuthResponseSchema,
  hostWebViewCreateSchema,
  hostWebViewPresentationSchema,
  hostWebViewStateSchema,
  hostWebUrlSchema,
  type HostWebViewAction,
  type HostWebViewAuthResponse,
  type HostWebViewCreate,
  type HostWebViewPresentation,
  type HostWebViewState,
} from '@workspace/contracts/desktop';

interface PendingAuthentication {
  id: string;
  callback(username?: string, password?: string): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ManagedWebView {
  owner: BrowserWindow;
  view: WebContentsView;
  initialUrl: string;
  state: HostWebViewState['state'];
  visible: boolean;
  title: string;
  blockedUrl?: string;
  errorCode?: string;
  authChallenge?: HostWebViewState['authChallenge'];
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
  createView?: (options: ConstructorParameters<typeof WebContentsView>[0]) => WebContentsView;
  openExternal?: (url: string) => Promise<void>;
}

export class NativeWebViewController {
  private readonly views = new Map<string, ManagedWebView>();

  constructor(
    private readonly getWindow: () => BrowserWindow | undefined,
    private readonly options: NativeWebViewControllerOptions = {},
  ) {}

  async create(input: HostWebViewCreate): Promise<HostWebViewState> {
    const command = hostWebViewCreateSchema.parse(input);
    if (this.views.has(command.id)) throw new NativeWebViewConflictError();
    if (this.views.size >= 8) throw new NativeWebViewUnavailableError('WEB_VIEW_LIMIT');
    const owner = this.requireWindow();
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
      view,
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
    this.views.set(command.id, managed);
    owner.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    view.setVisible(false);
    if (command.userAgent) view.webContents.setUserAgent(command.userAgent);
    this.installSecurity(command.id, managed);
    managed.state = 'loading';
    void view.webContents.loadURL(command.url).catch(() => {
      if (!this.views.has(command.id)) return;
      managed.state = 'failed';
      managed.errorCode = 'WEB_LOAD_FAILED';
    });
    return this.state(command.id);
  }

  state(id: string): HostWebViewState {
    const managed = this.require(id);
    const currentUrl = normalizedWebUrl(managed.view.webContents.getURL()) ?? managed.initialUrl;
    return hostWebViewStateSchema.parse({
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

  present(id: string, input: HostWebViewPresentation): HostWebViewState {
    const command = hostWebViewPresentationSchema.parse(input);
    const managed = this.require(id);
    if (command.bounds) managed.view.setBounds(clampBounds(command.bounds, managed.owner));
    if (command.visible !== undefined) {
      managed.visible = command.visible && !managed.authChallenge;
      managed.view.setVisible(managed.visible);
    }
    return this.state(id);
  }

  async perform(id: string, input: HostWebViewAction): Promise<HostWebViewState> {
    const command = hostWebViewActionSchema.parse(input);
    const managed = this.require(id);
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
    return this.state(id);
  }

  authenticate(id: string, input: HostWebViewAuthResponse): HostWebViewState {
    const command = hostWebViewAuthResponseSchema.parse(input);
    const managed = this.require(id);
    const pending = managed.pendingAuthentication;
    if (!pending || pending.id !== command.challengeId) throw new NativeWebViewConflictError();
    clearTimeout(pending.timer);
    delete managed.pendingAuthentication;
    delete managed.authChallenge;
    pending.callback(command.username || undefined, command.password || undefined);
    managed.visible = false;
    managed.view.setVisible(false);
    return this.state(id);
  }

  close(id: string): void {
    const managed = this.views.get(id);
    if (!managed) return;
    this.views.delete(id);
    this.cancelAuthentication(managed);
    managed.view.webContents.session.off('will-download', managed.downloadListener);
    if (!managed.owner.isDestroyed()) managed.owner.contentView.removeChildView(managed.view);
    if (!managed.view.webContents.isDestroyed()) managed.view.webContents.close();
  }

  closeAll(): void {
    for (const id of [...this.views.keys()]) this.close(id);
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
    contents.on('login', (event, details, authInfo, callback) => {
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

  private requireWindow(): BrowserWindow {
    const owner = this.getWindow();
    if (!owner || owner.isDestroyed())
      throw new NativeWebViewUnavailableError('WINDOW_UNAVAILABLE');
    return owner;
  }

  private require(id: string): ManagedWebView {
    const managed = this.views.get(id);
    if (!managed) throw new NativeWebViewNotFoundError();
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
  const parsed = hostWebUrlSchema.safeParse(value);
  return parsed.success ? new URL(parsed.data).toString() : undefined;
}

function clampBounds(
  bounds: HostWebViewPresentation['bounds'] & {},
  owner: BrowserWindow,
): HostWebViewPresentation['bounds'] & {} {
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
