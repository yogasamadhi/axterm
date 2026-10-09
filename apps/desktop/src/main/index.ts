import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  powerMonitor,
  protocol,
  screen,
  shell,
  utilityProcess,
} from 'electron';
import { APP_VERSION } from '@workspace/shared';
import runtimePath from '../../../../packages/runtime/src/entry/desktop.ts?modulePath';
import { RuntimeSupervisor } from './supervisor/runtime-supervisor';
import { isTrustedClipboardPermission, isTrustedDocument } from './windows/security';
import { reportWorkspaceLoadFailure } from './windows/workspace-load';
import { HostCapabilityServer } from './host-capabilities/server';
import {
  DEFAULT_DESKTOP_WINDOW_SIZE,
  DEFAULT_DESKTOP_WINDOW_PREFERENCES,
  readWindowLaunchPreferences,
  WindowBoundsPersistence,
} from './host-capabilities/window-preferences';
import { AXTERM_DEEP_LINK_SCHEMES, DesktopDeepLinkBridge } from './deep-link-bridge';
import {
  DESKTOP_COMMAND_LINE_HELP,
  materializeDesktopCommandLine,
  parseDesktopCommandLine,
  type DesktopCommandLineResult,
} from './command-line';
import { GlobalHotkeyController } from './host-capabilities/global-hotkey-controller';
import { WindowCloseGuard } from './host-capabilities/window-close-guard';
import { createDesktopUpdaterFromEnvironment } from './host-capabilities/signed-release-updater';
import {
  RUNTIME_LEGAL_SCHEME,
  resolvePackagedRuntimeLegalDirectory,
  resolveRuntimeLegalDocument,
} from './legal-runtime-documents';

const developmentInstance = !app.isPackaged;
const hiddenE2EWindow = developmentInstance && process.env.AXTERM_E2E_HIDDEN_WINDOW === '1';
const desktopProductName = developmentInstance ? 'Axterm Dev' : 'Axterm';
const mainRequire = createRequire(import.meta.url);
const MAX_RUNTIME_LEGAL_BYTES = 32 * 1024 * 1024;
protocol.registerSchemesAsPrivileged([
  {
    scheme: RUNTIME_LEGAL_SCHEME,
    privileges: { secure: true, standard: true },
  },
]);
if (developmentInstance) {
  app.setName(desktopProductName);
  app.setAppUserModelId('dev.axterm.desktop.dev');
  if (hiddenE2EWindow && process.platform === 'darwin') app.setActivationPolicy('accessory');
  if (!app.commandLine.hasSwitch('user-data-dir'))
    app.setPath('userData', resolve(app.getPath('appData'), desktopProductName));
}

let window: BrowserWindow | undefined;
let windowRequested = true;
let desktopAppIcon: ReturnType<typeof nativeImage.createFromPath> | undefined;
const desktopWindows = new Set<BrowserWindow>();
const windowBoundsPersistences = new Map<BrowserWindow, WindowBoundsPersistence>();
let quitting = false;
let allowedOrigin = '';
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
let supervisor: RuntimeSupervisor | undefined;
let hostCapabilities: HostCapabilityServer | undefined;
const globalHotkeyController = new GlobalHotkeyController(globalShortcut, () => window);
let runtimeIngress: { generation: string; token: string } | undefined;
const recordSuspend = () => hostCapabilities?.recordLifecycle('suspend');
const recordResume = () => hostCapabilities?.recordLifecycle('resume');
const pendingCommandLines: Array<Extract<DesktopCommandLineResult, { kind: 'session' }>> = [];
let drainingCommandLines = false;
const initialCommandLine = parseDesktopCommandLine(process.argv.slice(1));
const exitsFromCommandLine =
  initialCommandLine.kind === 'help' || initialCommandLine.kind === 'version';
if (initialCommandLine.kind === 'help') console.log(DESKTOP_COMMAND_LINE_HELP);
if (initialCommandLine.kind === 'version') console.log(APP_VERSION);
if (exitsFromCommandLine) app.exit(0);
const launchWindowPreferences = readWindowLaunchPreferences(
  resolve(app.getPath('userData'), 'desktop'),
);
const primaryInstance =
  !exitsFromCommandLine &&
  (launchWindowPreferences.allowMultiInstance || app.requestSingleInstanceLock());
const windowCloseGuard = new WindowCloseGuard(async (target) => {
  const owner = target as BrowserWindow;
  const result = await dialog.showMessageBox(owner, {
    type: 'question',
    title: '退出 Axterm',
    message: '确定要关闭当前 Axterm 窗口吗？',
    detail: '正在运行的终端、传输和临时任务将被停止。',
    buttons: ['取消', '退出'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
});

function focusWindow() {
  if (!window || window.isDestroyed()) {
    windowRequested = true;
    if (supervisor?.state === 'ready') createWindow();
    return;
  }
  if (hiddenE2EWindow) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function registerRuntimeLegalDocumentProtocol() {
  const electronDistributionDirectory = app.isPackaged
    ? ''
    : resolve(dirname(mainRequire.resolve('electron/package.json')), 'dist');
  await protocol.handle(RUNTIME_LEGAL_SCHEME, async (request) => {
    const document = resolveRuntimeLegalDocument(request.url, {
      packaged: app.isPackaged,
      resourcesDirectory: resolvePackagedRuntimeLegalDirectory(
        process.resourcesPath,
        process.platform,
      ),
      electronDistributionDirectory,
    });
    if (!document)
      return new Response('Not found', {
        status: 404,
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    try {
      const metadata = await stat(document.path);
      if (!metadata.isFile() || metadata.size > MAX_RUNTIME_LEGAL_BYTES)
        throw new Error('Runtime legal document is unavailable');
      // Node's stream/web declarations and Electron's Response declarations use
      // structurally compatible but separately declared ReadableStream types.
      const body = Readable.toWeb(
        createReadStream(document.path),
      ) as unknown as ReadableStream<Uint8Array>;
      return new Response(body, {
        headers: {
          'Content-Type': document.contentType,
          'Content-Length': `${metadata.size}`,
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return new Response('Unavailable', {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    }
  });
}

const deepLinks = new DesktopDeepLinkBridge(focusWindow);

function enqueueCommandLine(parsed: DesktopCommandLineResult) {
  if (parsed.kind === 'session') {
    if (pendingCommandLines.length >= 32) pendingCommandLines.shift();
    pendingCommandLines.push(parsed);
    void drainCommandLines();
  } else if (parsed.kind === 'error') {
    console.error(`[Axterm CLI] ${parsed.errorCode}`);
    deepLinks.receive('axterm://invalid?type=invalid');
  }
}

async function drainCommandLines() {
  if (drainingCommandLines || !hostCapabilities) return;
  drainingCommandLines = true;
  try {
    while (pendingCommandLines[0]) {
      const parsed = pendingCommandLines.shift()!;
      try {
        const privateKeyGrant = parsed.privateKeyPath
          ? await hostCapabilities.grantCommandLinePath(parsed.privateKeyPath, 'file')
          : undefined;
        const directoryGrant = parsed.initialDirectoryPath
          ? await hostCapabilities.grantCommandLinePath(parsed.initialDirectoryPath, 'directory', [
              'read',
              'write',
            ])
          : undefined;
        const batchOperationGrant = parsed.batchOperationPath
          ? await hostCapabilities.grantCommandLinePath(parsed.batchOperationPath, 'file')
          : undefined;
        deepLinks.receive(
          materializeDesktopCommandLine(parsed, {
            ...(privateKeyGrant ? { privateKeyGrantId: privateKeyGrant.grantId } : {}),
            ...(directoryGrant ? { initialDirectoryGrantId: directoryGrant.grantId } : {}),
            ...(batchOperationGrant ? { batchOperationGrantId: batchOperationGrant.grantId } : {}),
          }),
        );
      } catch {
        console.error('[Axterm CLI] CLI_PATH_GRANT_FAILED');
        deepLinks.receive('axterm://invalid?type=invalid');
      }
    }
  } finally {
    drainingCommandLines = false;
  }
}

if (!primaryInstance) app.quit();
else {
  enqueueCommandLine(initialCommandLine);
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deepLinks.receive(url);
  });
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    const parsed = parseDesktopCommandLine(commandLine, workingDirectory);
    if (parsed.newWindow && supervisor?.state === 'ready') createWindow();
    else focusWindow();
    enqueueCommandLine(parsed);
  });
}

function createSupervisor(host: HostCapabilityServer) {
  return new RuntimeSupervisor({
    fork: () => {
      const debugRuntime = process.env.AXTERM_DEBUG_RUNTIME === '1';
      const child = utilityProcess.fork(runtimePath, [], {
        serviceName: 'Axterm Core Runtime',
        stdio: debugRuntime ? 'pipe' : 'ignore',
        ...(process.platform === 'darwin' ? { allowLoadingUnsignedLibraries: true } : {}),
      });
      if (debugRuntime) {
        child.stdout?.pipe(process.stdout);
        child.stderr?.pipe(process.stderr);
      }
      return child;
    },
    startup: (generation) => ({
      ...(() => {
        const token = randomBytes(32).toString('base64url');
        runtimeIngress = { generation, token };
        deepLinks.disconnect();
        return {
          appVersion: APP_VERSION,
          dataDirectory: resolve(app.getPath('userData'), 'data-v2'),
          ...host.activate(generation),
          runtimeIngressToken: token,
          ...(devUrl
            ? { devOrigin: new URL(devUrl).origin }
            : {
                rendererDirectory: resolve(import.meta.dirname, '../renderer'),
              }),
        };
      })(),
    }),
    onUnavailable: showStartupError,
    onReady: (bootstrap) => {
      if (quitting) return;
      const targetOrigin = devUrl ? new URL(devUrl).origin : bootstrap.baseUrl;
      const originChanged = allowedOrigin !== targetOrigin;
      allowedOrigin = targetOrigin;
      if (!window && windowRequested) createWindow();
      else if (window && originChanged) {
        const recovery = supervisor?.restartCount ? '?recovery=runtime-restarted' : '';
        void window
          .loadURL(`${allowedOrigin}/${recovery}`)
          .catch((error: unknown) => reportWorkspaceLoadFailure(error, showStartupError));
      }
      if (runtimeIngress?.generation === bootstrap.generation)
        deepLinks.connect({
          baseUrl: bootstrap.baseUrl,
          generation: bootstrap.generation,
          token: runtimeIngress.token,
        });
    },
  });
}

function showStartupError() {
  if (!quitting)
    dialog.showErrorBox(
      'Axterm could not start',
      'The local runtime or workspace could not be loaded. Close and reopen Axterm to retry.',
    );
}

function loadDesktopAppIcon() {
  if (app.isPackaged && process.platform !== 'linux') return;
  const iconPath = app.isPackaged
    ? resolve(process.resourcesPath, 'axterm-icon.png')
    : process.env.AXTERM_DESKTOP_ICON?.trim() ||
      resolve(import.meta.dirname, '../../build/icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    console.error(`[Axterm] Could not load the application icon: ${iconPath}`);
    return;
  }
  // X11 rejects the 1024 px asset as a window icon; keep the full size copy for
  // desktop launchers and publish a 128 px icon for the running window.
  desktopAppIcon = process.platform === 'linux' ? icon.resize({ width: 128, height: 128 }) : icon;
  if (process.platform === 'darwin') app.dock?.setIcon(icon);
}

function createWindow() {
  const preferences =
    hostCapabilities?.preferencesForWindowCreation() ?? DEFAULT_DESKTOP_WINDOW_PREFERENCES;
  const customTitleBar = preferences.titleBarStyle === 'custom';
  const createdWindow = new BrowserWindow({
    title: desktopProductName,
    ...(preferences.bounds ?? DEFAULT_DESKTOP_WINDOW_SIZE),
    minWidth: 800,
    minHeight: 580,
    backgroundColor: '#101216',
    opacity: preferences.opacity,
    show: false,
    frame: !customTitleBar,
    titleBarStyle: customTitleBar ? 'hidden' : 'default',
    ...(desktopAppIcon ? { icon: desktopAppIcon } : {}),
    ...(process.platform === 'darwin' && customTitleBar
      ? { trafficLightPosition: { x: 9, y: 10 } }
      : {}),
    webPreferences: {
      preload: resolve(import.meta.dirname, '../preload/index.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  windowRequested = false;
  window = createdWindow;
  desktopWindows.add(createdWindow);
  createdWindow.on('focus', () => {
    window = createdWindow;
  });
  hostCapabilities?.markTitleBarStyleApplied(preferences.titleBarStyle);
  createdWindow.webContents.setZoomFactor(preferences.zoomFactor);
  if (process.platform === 'darwin' && customTitleBar)
    createdWindow.setWindowButtonVisibility(true);
  const windowBoundsPersistence = new WindowBoundsPersistence(
    createdWindow,
    (bounds) => hostCapabilities?.persistWindowBounds(bounds) ?? Promise.resolve(),
    250,
    () => console.error('Failed to save desktop window bounds'),
  );
  windowBoundsPersistences.set(createdWindow, windowBoundsPersistence);
  if (preferences.bounds)
    void hostCapabilities
      ?.persistWindowBounds(createdWindow.getNormalBounds())
      .catch(() => console.error('Failed to save corrected desktop window bounds'));
  createdWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  createdWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    createdWindow.setTitle(desktopProductName);
  });
  createdWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedDocument(url, allowedOrigin)) event.preventDefault();
  });
  createdWindow.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedDocument(url, allowedOrigin)) event.preventDefault();
  });
  createdWindow.webContents.session.setPermissionRequestHandler(
    (requestingWebContents, permission, callback, details) =>
      callback(
        requestingWebContents === createdWindow.webContents &&
          details.isMainFrame &&
          isTrustedDocument(requestingWebContents.getURL(), allowedOrigin) &&
          isTrustedClipboardPermission(permission, details.requestingUrl, allowedOrigin),
      ),
  );
  createdWindow.webContents.session.setPermissionCheckHandler(
    (requestingWebContents, permission, requestingOrigin, details) =>
      requestingWebContents === createdWindow.webContents &&
      details.isMainFrame &&
      isTrustedDocument(requestingWebContents.getURL(), allowedOrigin) &&
      isTrustedClipboardPermission(
        permission,
        details.requestingUrl ?? requestingWebContents.getURL(),
        allowedOrigin,
        requestingOrigin,
      ),
  );
  createdWindow.once('ready-to-show', () => {
    if (!hiddenE2EWindow) createdWindow.show();
  });
  createdWindow.on('close', (event) => {
    windowCloseGuard.handle(createdWindow, event, {
      confirmBeforeExit:
        hostCapabilities?.preferencesForWindowCreation().confirmBeforeExit ?? false,
      bypass: quitting,
    });
  });
  createdWindow.on('closed', () => {
    hostCapabilities?.windowClosed();
    desktopWindows.delete(createdWindow);
    if (window === createdWindow) window = [...desktopWindows].at(-1);
    const persistence = windowBoundsPersistences.get(createdWindow);
    windowBoundsPersistences.delete(createdWindow);
    void persistence?.dispose();
  });
  void createdWindow
    .loadURL(`${allowedOrigin}/`)
    .catch((error: unknown) => reportWorkspaceLoadFailure(error, showStartupError));
}

if (primaryInstance)
  void app
    .whenReady()
    .then(async () => {
      loadDesktopAppIcon();
      await registerRuntimeLegalDocumentProtocol();
      hostCapabilities = new HostCapabilityServer(
        resolve(app.getPath('userData'), 'vault-v2'),
        () => window,
        {
          windowPreferencesDirectory: resolve(app.getPath('userData'), 'desktop'),
          getDisplayLayout: () => ({
            displays: screen
              .getAllDisplays()
              .map(({ workArea }) => ({ workArea: { ...workArea } })),
            primary: { workArea: { ...screen.getPrimaryDisplay().workArea } },
          }),
          globalHotkey: globalHotkeyController,
          approveWindowClose: (target) => windowCloseGuard.approveNextClose(target),
          updater: createDesktopUpdaterFromEnvironment({
            currentVersion: APP_VERSION,
            downloadDirectory: resolve(app.getPath('userData'), 'updates'),
            openInstaller: (path) => shell.openPath(path),
            ...(app.isPackaged
              ? { packagedRecordPath: resolve(process.resourcesPath, 'AXTERM_UPDATE_FEED.json') }
              : {}),
          }),
        },
      );
      await hostCapabilities.start();
      powerMonitor.on('suspend', recordSuspend);
      powerMonitor.on('resume', recordResume);
      if (app.isPackaged || process.env.AXTERM_REGISTER_PROTOCOLS === '1')
        for (const scheme of AXTERM_DEEP_LINK_SCHEMES) app.setAsDefaultProtocolClient(scheme);
      supervisor = createSupervisor(hostCapabilities);
      ipcMain.handle('desktop:bootstrap', (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (
          !senderWindow ||
          !desktopWindows.has(senderWindow) ||
          event.senderFrame !== event.sender.mainFrame ||
          !isTrustedDocument(event.senderFrame.url, allowedOrigin)
        )
          throw new Error('Bootstrap forbidden');
        if (!supervisor) throw new Error('Runtime unavailable');
        return supervisor.resolve();
      });
      supervisor.start();
      void drainCommandLines();
      app.on('activate', () => {
        if (!desktopWindows.size) focusWindow();
      });
    })
    .catch(showStartupError);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  powerMonitor.removeListener('suspend', recordSuspend);
  powerMonitor.removeListener('resume', recordResume);
  ipcMain.removeHandler('desktop:bootstrap');
  void (async () => {
    await Promise.all(
      [...windowBoundsPersistences.values()].map((persistence) => persistence.flush()),
    );
    await supervisor?.stop();
    await hostCapabilities?.close();
  })().finally(() => app.quit());
});
