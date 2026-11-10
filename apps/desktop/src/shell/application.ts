import { ShellPowerLifecycle } from './power-lifecycle.ts';
import { selectGlobalHotkeyWindow, toggleGlobalHotkeyWindow } from './global-hotkey-controller.ts';
import { reportWorkspaceLoadFailure } from './navigation-failure.ts';
import { createDesktopUpdaterFromEnvironment } from './signed-release-updater.ts';
import { assertShellHomeReady } from './data-copy.ts';
import { RuntimeLegalDocuments, resolvePackagedRuntimeLegalDirectory } from './legal.ts';
import { MacosTrayController } from './macos-tray.ts';
import { createMacosTrayIcon } from './macos-tray-icon.ts';
import { createRequire } from 'node:module';
import { DesktopKeyboardBridge } from './keyboard.ts';
import { DEFAULT_DESKTOP_WINDOW_SIZE, ShellWindowPreferences } from './window-preferences.ts';
import { NativeWebViewController } from './web-views.ts';
import { DesktopLaunchQueue } from './launch-queue.ts';
import {
  parseDesktopCommandLine,
  extractDesktopDeepLinks,
  type DesktopCommandLineResult,
} from './command-line.ts';
import { NativeError } from '@axterm/infra-desktop-native';
import {
  app,
  shell,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
  globalShortcut,
  screen,
  powerMonitor,
  type IpcMainInvokeEvent,
} from 'electron';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { prepareProfileRecovery } from '@axterm/infra-profile-recovery';
import { join, isAbsolute, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EncryptedVault } from '@axterm/infra-credential-vault';
import type { DesktopBootPayload } from '@axterm/web/bootstrap';
import { DesktopHostProcess, type HostReady } from './host-process.ts';
import { APP_URL, WindowTransport, windowPartition } from './window-transport.ts';
import { isApplicationDocument } from './window-policy.ts';
import { readLoginEnvironment } from './login-environment.ts';
import { ElectronFileChooser } from './file-chooser.ts';
import type { NativeFileChooser, NativeFileApplications } from '@axterm/infra-desktop-native';

export interface DesktopShellOptions {
  readonly home: string;
  readonly webRoot: string;
  readonly hostEntry: string;
  readonly preload: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly visible?: boolean;
  /** Native dialogs are injected only by the main-process integration harness. */
  readonly confirmQuit?: () => Promise<boolean>;
  readonly recover?: () => Promise<'restart' | 'backup-restart' | 'quit'>;
  readonly fileChooser?: () => NativeFileChooser;
  readonly fileApplications?: NativeFileApplications;
  readonly openExternal?: (url: string) => Promise<void>;
  readonly openInstaller?: (path: string) => Promise<string>;
}
type Failure =
  'HOST_FAILED' | 'RENDERER_FAILED' | 'PRELOAD_FAILED' | 'CLIENT_BOOT_FAILED' | 'SHELL_FAILED';

/** Native ownership only. All product services and task facts live in the separate Host. */
export class DesktopShell {
  private readonly windows = new Map<BrowserWindow, WindowTransport>();
  private readonly vault: EncryptedVault;
  private readonly legal = new RuntimeLegalDocuments({
    packaged: app.isPackaged,
    directory: app.isPackaged
      ? resolvePackagedRuntimeLegalDirectory(process.resourcesPath, process.platform)
      : join(dirname(createRequire(import.meta.url).resolve('electron/package.json')), 'dist'),
  });
  private readonly lifetime = new AbortController();
  private readonly login: Promise<NodeJS.ProcessEnv>;
  private boot = Promise.withResolvers<HostReady>();
  private host: DesktopHostProcess | undefined;
  private readonly epochs = new Map<number, number>();
  private windowSequence = 0;
  private readonly windowIdentities = new Map<
    BrowserWindow,
    { id: string; lifetime: AbortController; presentationSlot: string }
  >();
  private readonly launches = new DesktopLaunchQueue();
  private readonly bootAdmissions = new Set<number>();
  private tray: MacosTrayController | undefined;
  private recovering = false;
  private recoveryDialogUsed = false;
  private quitting = false;
  private quitRequest: Promise<boolean> | undefined;
  private shutdown: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private menu: Menu | null = null;
  private readonly keyboard: DesktopKeyboardBridge;
  private readonly windowPreferences: ShellWindowPreferences;
  private readonly lifecycle: ShellPowerLifecycle;
  private preferencesReady = false;
  private readonly earlyLaunches: { parsed: DesktopCommandLineResult; secondary: boolean }[] = [];
  constructor(private readonly options: DesktopShellOptions) {
    ipcMain.handle('desktop:bootstrap', this.bootstrap);
    ipcMain.handle('desktop:directory-drop', this.directoryDrop);
    this.keyboard = new DesktopKeyboardBridge(
      () => (this.recovering || this.quitting ? undefined : this.host?.authority()?.generation),
      undefined,
      (active) => this.windowPreferences?.setRecording(active),
    );
    this.windowPreferences = new ShellWindowPreferences({
      windows: () => [...this.windows.keys()],
      focused: () => {
        const focused = BrowserWindow.getFocusedWindow();
        return focused && this.windows.has(focused) ? focused : undefined;
      },
      hotkeys: globalShortcut,
      displays: () => ({
        primary: screen.getPrimaryDisplay().workArea,
        areas: screen.getAllDisplays().map((display) => display.workArea),
      }),
      activate: (toggle) => {
        if (this.quitting || this.recovering) return;
        const focused = BrowserWindow.getFocusedWindow();
        const target = selectGlobalHotkeyWindow(this.windows.keys(), focused);
        if (toggle && target) toggleGlobalHotkeyWindow(target);
        else this.activate();
      },
      initialized: () => {
        if (this.quitting || this.recovering) return;
        this.preferencesReady = true;
        if (!this.windows.size) this.createWindow();
        for (const request of this.earlyLaunches.splice(0))
          this.receiveCommandLine(request.parsed, request.secondary);
      },
    });
    this.lifecycle = new ShellPowerLifecycle(powerMonitor);
    this.vault = new EncryptedVault(join(options.home, 'vault-v2'));
    this.observeBoot();
    this.login = readLoginEnvironment(options.environment, this.lifetime.signal);
    app.on('activate', this.activate);
    app.on('second-instance', this.secondInstance);
    app.on('open-url', this.openUrl);
    app.on('before-quit', this.beforeQuit);
    app.on('window-all-closed', this.keepAlive);
    this.installMenu();
  }
  start(): Promise<void> {
    return (this.starting ??= this.initialize());
  }
  private async initialize(): Promise<void> {
    // Native creation uses the Host's accepted presentation snapshot; CLI input stays queued.
    try {
      await assertShellHomeReady(this.options.home);
      await this.vault.open();
      const environment = await this.login;
      if (!this.lifetime.signal.aborted) this.startHost(environment);
    } catch {
      await this.failed('SHELL_FAILED');
    }
  }
  private observeBoot(): void {
    void this.boot.promise.catch(() => {});
  }
  createWindow(): BrowserWindow {
    if (this.quitting) throw new Error('DESKTOP_CLOSING');
    const preferences = this.windowPreferences.creation(),
      custom = preferences.titleBarStyle === 'custom';
    const window = new BrowserWindow({
      title: 'Axterm',
      ...(preferences.bounds ?? DEFAULT_DESKTOP_WINDOW_SIZE),
      minWidth: 800,
      minHeight: 580,
      backgroundColor: '#101216',
      opacity: preferences.opacity,
      frame: !custom,
      titleBarStyle: custom ? 'hidden' : 'default',
      ...(process.platform === 'darwin' && custom ? { trafficLightPosition: { x: 9, y: 10 } } : {}),
      show: this.options.visible !== false,
      webPreferences: {
        preload: this.options.preload,
        partition: windowPartition(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        backgroundThrottling: false,
      },
    });
    const transport = new WindowTransport(window, {
      webRoot: this.options.webRoot,
      authority: () => (this.recovering || this.quitting ? undefined : this.host?.authority()),
      shellDocument: (path) => this.recoveryDocument(path),
      runtimeLegalDocument: (request, signal) => this.legal.serve(request, signal),
    });
    this.windows.set(window, transport);
    this.windowPreferences.attach(window);
    this.keyboard.attach(window);
    this.windowIdentities.set(window, {
      id: randomUUID(),
      lifetime: new AbortController(),
      presentationSlot: 'desktop_' + this.windowSequence++,
    });
    window.on('close', (event) => {
      if (!this.quitting) {
        event.preventDefault();
        window.hide();
      }
    });
    window.once('closed', () => {
      transport.dispose();
      this.retireWindowIdentity(window);
      this.windows.delete(window);
    });
    const contents = window.webContents;
    this.epochs.set(contents.id, 0);
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) {
        if (this.bootAdmissions.has(contents.id)) {
          const presentationSlot = this.windowIdentities.get(window)!.presentationSlot;
          this.retireWindowIdentity(window);
          this.windowIdentities.set(window, {
            id: randomUUID(),
            lifetime: new AbortController(),
            presentationSlot,
          });
        }
        this.epochs.set(contents.id, (this.epochs.get(contents.id) ?? 0) + 1);
        this.bootAdmissions.delete(contents.id);
      }
    });
    contents.once('destroyed', () => {
      this.epochs.delete(contents.id);
      this.bootAdmissions.delete(contents.id);
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-navigate', (event, url) => {
      if (!isApplicationDocument(url)) event.preventDefault();
    });
    contents.on('will-redirect', (event, url) => {
      if (!isApplicationDocument(url)) event.preventDefault();
    });
    contents.on('render-process-gone', () => {
      if (!this.quitting) this.reportFailure('RENDERER_FAILED');
    });
    contents.on('preload-error', () => {
      if (!this.quitting) this.reportFailure('PRELOAD_FAILED');
    });
    void window.loadURL(APP_URL).catch((cause: unknown) => {
      reportWorkspaceLoadFailure(cause, () => {
        if (!this.quitting) this.reportFailure('CLIENT_BOOT_FAILED');
      });
    });
    return window;
  }
  snapshot(): { windows: number; phase: string; generation?: string; origin?: string } {
    return { windows: this.windows.size, ...(this.host?.snapshot() ?? { phase: 'starting' }) };
  }
  private startHost(environment: NodeJS.ProcessEnv): void {
    this.preferencesReady = false;
    this.windowPreferences.beginGeneration();
    const boot = this.boot;
    this.host = new DesktopHostProcess({
      executable: process.execPath,
      entry: this.options.hostEntry,
      home: this.options.home,
      environment,
      vault: this.vault,
      windows: this.windowPreferences,
      lifecycle: this.lifecycle,
      updater: createDesktopUpdaterFromEnvironment({
        currentVersion: app.getVersion(),
        downloadDirectory: join(this.options.home, 'desktop', 'updates'),
        openInstaller: this.options.openInstaller ?? ((path) => shell.openPath(path)),
        environment: this.options.environment,
        ...(app.isPackaged
          ? { packagedRecordPath: join(process.resourcesPath, 'AXTERM_UPDATE_FEED.json') }
          : {}),
      }),
      openExternal: this.options.openExternal ?? ((url) => shell.openExternal(url)),
      webViews: new NativeWebViewController(
        (id) => {
          if (this.quitting || this.recovering) return undefined;
          for (const [window, identity] of this.windowIdentities)
            if (identity.id === id && !window.isDestroyed())
              return { window, signal: identity.lifetime.signal };
          return undefined;
        },
        {
          attachKeyboard: (window, contents, id, visible) =>
            this.keyboard.attachGuest(window, contents, id, visible),
        },
      ),
      nextLaunch: (id, files, signal) => {
        const identity = [...this.windowIdentities.values()].find((value) => value.id === id);
        if (!identity || this.quitting || this.recovering) throw new NativeError('FORBIDDEN');
        return this.launches.next(id, files, AbortSignal.any([identity.lifetime.signal, signal]));
      },
      fileApplications: this.options.fileApplications ?? {
        open: async (path) => {
          const error = await shell.openPath(path);
          if (error) throw new Error('NATIVE_FILE_OPEN_FAILED');
        },
        reveal: async (path) => {
          shell.showItemInFolder(path);
        },
      },
      fileChooser:
        this.options.fileChooser?.() ??
        new ElectronFileChooser(() => {
          const focused = BrowserWindow.getFocusedWindow();
          return focused && this.windows.has(focused)
            ? focused
            : [...this.windows.keys()].find((window) => !window.isDestroyed());
        }),
      fatal: () => {
        this.reportFailure('HOST_FAILED');
      },
    });
    void this.host.ready().then(
      (value) => boot.resolve(value),
      () => boot.reject(new Error('DESKTOP_HOST_FAILED')),
    );
  }
  private readonly bootstrap = async (
    event: IpcMainInvokeEvent,
    input: unknown,
  ): Promise<DesktopBootPayload | void> => {
    if (!this.ownsEvent(event) || typeof input !== 'object' || input === null)
      throw new Error('DESKTOP_BOOTSTRAP_INVALID');
    const keys = Object.keys(input).sort().join(',');
    if (
      'type' in input &&
      input.type === 'failed' &&
      keys === 'code,type' &&
      'code' in input &&
      input.code === 'CLIENT_BOOT_FAILED'
    ) {
      this.reportFailure('CLIENT_BOOT_FAILED');
      return;
    }
    if (!('type' in input) || input.type !== 'ready' || keys !== 'type')
      throw new Error('DESKTOP_BOOTSTRAP_INVALID');
    if (this.bootAdmissions.has(event.sender.id))
      throw new Error('DESKTOP_BOOTSTRAP_ALREADY_REQUESTED');
    this.bootAdmissions.add(event.sender.id);
    const epoch = this.epochs.get(event.sender.id);
    const boot = this.boot;
    const ready = await boot.promise;
    if (
      epoch !== this.epochs.get(event.sender.id) ||
      boot !== this.boot ||
      !this.ownsEvent(event) ||
      !this.host?.authority()
    )
      throw new Error('DESKTOP_BOOTSTRAP_RETIRED');
    return {
      injections: ready.injections,
      streamBaseUrl: ready.origin,
      windowId: this.windowIdentities.get(BrowserWindow.fromWebContents(event.sender)!)!.id,
      presentationSlot: this.windowIdentities.get(BrowserWindow.fromWebContents(event.sender)!)!
        .presentationSlot,
      platform: process.platform as DesktopBootPayload['platform'],
    };
  };
  private readonly directoryDrop = async (
    event: IpcMainInvokeEvent,
    input: unknown,
  ): Promise<{ ticket: string; tickets: readonly string[] }> => {
    if (
      !this.ownsEvent(event) ||
      !Array.isArray(input) ||
      !input.length ||
      input.length > 32 ||
      input.some(
        (path) =>
          typeof path !== 'string' ||
          !path ||
          path.length > 4096 ||
          !isAbsolute(path) ||
          Array.from(path).some((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127;
          }),
      )
    )
      throw Error('DESKTOP_DROP_INVALID');
    const host = this.host,
      epoch = this.epochs.get(event.sender.id);
    if (!host?.authority()) throw Error('DESKTOP_DROP_UNAVAILABLE');
    const tickets: string[] = [];
    try {
      for (const path of input) tickets.push(await host.issueDirectoryDrop(path));
      if (
        host !== this.host ||
        epoch !== this.epochs.get(event.sender.id) ||
        !this.ownsEvent(event)
      )
        throw Error('DESKTOP_DROP_RETIRED');
      return { ticket: tickets[0]!, tickets };
    } catch {
      for (const ticket of tickets) host.discardDirectoryDrop(ticket);
      throw Error('DESKTOP_DROP_FAILED');
    }
  };
  private ownsEvent(event: IpcMainInvokeEvent): boolean {
    if (this.quitting || this.recovering || !event.senderFrame) return false;
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !this.windows.has(window)) return false;
    const main = event.sender.mainFrame;
    return (
      event.senderFrame.processId === main.processId &&
      event.senderFrame.routingId === main.routingId &&
      isApplicationDocument(main.url) &&
      isApplicationDocument(event.senderFrame.url)
    );
  }
  receiveArguments(argv: readonly string[], workingDirectory?: string, secondary = false): void {
    this.receiveCommandLine(parseDesktopCommandLine(argv, workingDirectory), secondary);
  }
  receiveCommandLine(parsed: DesktopCommandLineResult, secondary = false): void {
    if (this.quitting || this.recovering) return;
    if (parsed.kind === 'error') {
      console.error('DESKTOP_CLI_INVALID');
      return;
    }
    if (!this.preferencesReady) {
      if (this.earlyLaunches.length >= 32) console.error('DESKTOP_CLI_QUEUE_REJECTED');
      else this.earlyLaunches.push({ parsed: structuredClone(parsed), secondary });
      return;
    }
    const focused = BrowserWindow.getFocusedWindow();
    const window =
      parsed.newWindow || (secondary && this.windowPreferences.preferences.allowMultiInstance)
        ? this.createWindow()
        : focused && this.windows.has(focused)
          ? focused
          : ([...this.windows.keys()].find((value) => !value.isDestroyed()) ?? this.createWindow());
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (parsed.kind !== 'session') return;
    const identity = this.windowIdentities.get(window);
    if (!identity || !this.launches.enqueue(identity.id, parsed))
      console.error('DESKTOP_CLI_QUEUE_REJECTED');
  }
  private retireWindowIdentity(window: BrowserWindow): void {
    const identity = this.windowIdentities.get(window);
    if (!identity) return;
    identity.lifetime.abort();
    this.launches.retireWindow(identity.id);
    this.windowIdentities.delete(window);
  }
  private readonly secondInstance = (
    _event: Electron.Event,
    argv: string[],
    workingDirectory: string,
  ): void => {
    this.receiveArguments(argv, workingDirectory, true);
  };
  private readonly openUrl = (event: Electron.Event, source: string): void => {
    event.preventDefault();
    if (!extractDesktopDeepLinks([source]).length) return;
    this.receiveArguments([source]);
  };
  private readonly activate = (): void => {
    if (this.quitting) return;
    if (!this.preferencesReady) {
      this.receiveCommandLine({ kind: 'none', newWindow: false });
      return;
    }
    const window = [...this.windows.keys()].find((window) => !window.isDestroyed());
    if (!window) {
      this.createWindow();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  private readonly beforeQuit = (event: Electron.Event): void => {
    if (!this.quitting) {
      event.preventDefault();
      void this.requestQuit();
    }
  };
  private readonly keepAlive = (): void => {};
  requestQuit(): Promise<boolean> {
    return (this.quitRequest ??= this.confirmAndQuit().finally(() => {
      this.quitRequest = undefined;
    }));
  }
  private async confirmAndQuit(): Promise<boolean> {
    if (this.quitting) return true;
    const state = await this.host?.inspect().catch(() => ({ active: true, known: false }));
    if (
      !state ||
      !state.known ||
      state.active ||
      this.windowPreferences.preferences.confirmBeforeExit
    ) {
      const confirmed = this.options.confirmQuit
        ? await this.options.confirmQuit()
        : (
            await dialog.showMessageBox({
              type: 'warning',
              title: 'Axterm',
              message: 'Active tasks may be interrupted.',
              detail: 'Quit Axterm and stop its background tasks?',
              buttons: ['Cancel', 'Quit'],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            })
          ).response === 1;
      if (!confirmed) return false;
    }
    await this.stop();
    app.quit();
    return true;
  }
  private reportFailure(code: Failure): void {
    void this.failed(code).catch(async () => {
      await this.stop().catch(() => {});
      app.exit(1);
    });
  }
  private async failed(code: Failure): Promise<void> {
    if (this.quitting || this.recovering) return;
    this.recovering = true;
    this.earlyLaunches.length = 0;
    if (!this.windows.size) this.createWindow();
    this.launches.clear();
    this.boot.reject(new Error('DESKTOP_STARTUP_FAILED'));
    const stopping = this.host?.stop();
    void stopping?.catch(() => {});
    const recoveryPages: Promise<unknown>[] = [];
    for (const [window, transport] of this.windows) {
      transport.retireGeneration();
      if (!window.isDestroyed())
        recoveryPages.push(window.loadURL('axterm-app://shell/recovery').catch(() => {}));
    }
    const report = JSON.stringify({
      version: 1,
      code,
      time: new Date().toISOString(),
      platform: process.platform,
      generation: this.host?.generation,
    });
    try {
      const directory = join(this.options.home, 'desktop', 'crashes');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = join(directory, `${Date.now()}-${randomUUID()}.json`);
      const temporary = `${target}.tmp`;
      await writeFile(temporary, report, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } catch {
      /* No raw failure details or secrets may enter a native dialog. */
    }
    await stopping;
    // A native modal can suspend the renderer's pending load event. Let the local
    // recovery document finish first, but keep native recovery available if a
    // damaged/unresponsive renderer never acknowledges navigation.
    let navigationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(recoveryPages),
        new Promise<void>((resolve) => {
          navigationTimer = setTimeout(resolve, 1_000);
        }),
      ]);
    } finally {
      clearTimeout(navigationTimer);
    }
    this.host = undefined;
    if (this.quitting || this.lifetime.signal.aborted) return;
    if (this.recoveryDialogUsed) return;
    this.recoveryDialogUsed = true;
    const action = this.options.recover
      ? await this.options.recover()
      : (['restart', 'backup-restart', 'quit'] as const)[
          (
            await dialog.showMessageBox({
              type: 'error',
              title: 'Axterm Recovery',
              message: 'Axterm could not continue.',
              detail:
                'Restart, or disable all Profile-installed external code and back up the Desktop Profile patch. Installed packages and user data are preserved.',
              buttons: ['Restart', 'Disable External Plugins and Restart', 'Quit'],
              defaultId: 0,
              cancelId: 2,
              noLink: true,
            })
          ).response
        ]!;
    if (action === 'quit') {
      await this.stop();
      app.quit();
      return;
    }
    if (action === 'backup-restart') {
      try {
        await prepareProfileRecovery(this.options.home, 'desktop');
      } catch {
        await this.stop();
        app.quit();
        return;
      }
    }
    this.boot = Promise.withResolvers<HostReady>();
    this.observeBoot();
    this.recovering = false;
    if (this.lifetime.signal.aborted) return;
    if (!this.windows.size) this.createWindow();
    this.startHost(await this.login);
    for (const window of this.windows.keys())
      if (!window.isDestroyed())
        void window.loadURL(APP_URL).catch(() => {
          this.reportFailure('CLIENT_BOOT_FAILED');
        });
  }
  private recoveryDocument(path: string): Response {
    if (path !== '/recovery' || !this.recovering) return new Response(null, { status: 404 });
    return new Response(
      '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Axterm Recovery</title></head><body><h1>Axterm Recovery</h1><p>Use the native recovery dialog to continue.</p></body></html>',
      { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }
  private installMenu(): void {
    this.menu = Menu.getApplicationMenu();
    const menu = Menu.buildFromTemplate([
      ...(process.platform === 'darwin'
        ? [
            {
              label: 'Axterm',
              submenu: [
                { role: 'about' as const },
                { type: 'separator' as const },
                {
                  label: 'Quit Axterm',
                  accelerator: 'Command+Q',
                  click: () => {
                    void this.requestQuit();
                  },
                },
              ],
            },
          ]
        : []),
      {
        label: 'File',
        submenu: [
          {
            label: 'New Window',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: () => {
              this.receiveCommandLine({ kind: 'none', newWindow: true });
            },
          },
          { role: 'close' },
          ...(process.platform !== 'darwin'
            ? [
                {
                  label: 'Quit',
                  click: () => {
                    void this.requestQuit();
                  },
                },
              ]
            : []),
        ],
      },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]);
    Menu.setApplicationMenu(menu);
    this.tray = new MacosTrayController(
      'Axterm',
      this.activate,
      {
        createTray: () => {
          const tray = new Tray(createMacosTrayIcon(nativeImage));
          tray.on('click', this.activate);
          return tray;
        },
        buildMenu: (items) => Menu.buildFromTemplate(items),
      },
      process.platform,
      {
        newWindow: () => this.receiveCommandLine({ kind: 'none', newWindow: true }),
        quit: () => {
          void this.requestQuit();
        },
      },
    );
    this.tray.start();
  }

  stop(): Promise<void> {
    return (this.shutdown ??= (async () => {
      this.quitting = true;
      this.earlyLaunches.length = 0;
      this.lifetime.abort();
      this.boot.reject(new Error('DESKTOP_CLOSING'));
      ipcMain.removeHandler('desktop:bootstrap');
      ipcMain.removeHandler('desktop:directory-drop');
      this.keyboard.dispose();
      this.lifecycle.close();
      app.off('activate', this.activate);
      app.off('second-instance', this.secondInstance);
      app.off('open-url', this.openUrl);
      app.off('before-quit', this.beforeQuit);
      // Host preferences must read final normal geometry before native owners disappear.
      const drained = await Promise.allSettled([
        this.launches.close(),
        this.host?.stop(),
        this.login,
        this.legal.close(),
      ]);
      for (const [window, transport] of this.windows) {
        this.retireWindowIdentity(window);
        transport.dispose();
        if (!window.isDestroyed()) window.destroy();
      }
      this.windows.clear();
      this.tray?.close();
      Menu.setApplicationMenu(this.menu);
      drained.push(...(await Promise.allSettled([this.windowPreferences.dispose()])));
      this.host = undefined;
      let vaultFailed = false;
      try {
        await this.vault.close();
      } catch {
        vaultFailed = true;
      }
      app.off('window-all-closed', this.keepAlive);
      if (vaultFailed || drained.some((result) => result.status === 'rejected'))
        throw new Error('DESKTOP_SHUTDOWN_FAILED');
    })());
  }
}
