import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream, type Dirent } from 'node:fs';
import {
  cp,
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { once } from 'node:events';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  clipboard,
  dialog,
  Notification,
  shell,
  type BrowserWindow,
  type OpenDialogOptions,
} from 'electron';
import {
  desktopWindowActionSchema,
  desktopLifecycleStateSchema,
  desktopWindowPreferencesPatchSchema,
  externalUrlSchema,
  fileGrantSchema,
  grantedDirectoryListRequestSchema,
  grantedDirectoryListingSchema,
  grantedEntriesOperationRequestSchema,
  grantedEntryCreateRequestSchema,
  grantedEntryChmodRequestSchema,
  grantedEntryPathRequestSchema,
  grantedEntryPathsRequestSchema,
  grantedEntryRenameRequestSchema,
  grantedFileOpenRequestSchema,
  grantedTransferPathRequestSchema,
  hostCredentialPutSchema,
  hostCredentialReplaceSchema,
  localDirectoryGrantRequestSchema,
  hostWebViewActionSchema,
  hostWebViewAuthResponseSchema,
  hostWebViewCreateSchema,
  hostWebViewPresentationSchema,
  notificationSchema,
  resolvedGrantSchema,
  updaterActionSchema,
  type DesktopWindowBounds,
  type DesktopLifecycleState,
  type DesktopWindowPreferences,
  type FileGrant,
} from '@workspace/contracts/desktop';
import { CredentialVault } from './credential-vault';
import {
  NativeWebViewConflictError,
  NativeWebViewController,
  NativeWebViewNotFoundError,
  NativeWebViewUnavailableError,
} from './native-web-view-controller';
import {
  DesktopGlobalHotkeyUnavailableError,
  DesktopWindowController,
  DesktopWindowUnavailableError,
} from './window-controller';
import type { GlobalHotkeyRegistrationPort } from './global-hotkey-controller';
import {
  correctWindowBounds,
  WindowPreferencesStore,
  type DesktopDisplayLayout,
} from './window-preferences';
import { DisabledDesktopUpdater, type DesktopUpdaterPort } from './signed-release-updater';

interface StoredGrant extends FileGrant {
  path: string;
  generation: string;
  managed?: boolean;
  managedRoot?: string;
}
const MAX_IMPORTED_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 10_000;
const DIRECTORY_STAT_CONCURRENCY = 32;
const IMPORTED_FILE_TTL_MS = 60 * 60 * 1_000;
const COMMAND_LINE_GRANT_TTL_MS = 2 * 60 * 1_000;
const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

interface HostCapabilityServerOptions {
  windowPreferencesDirectory?: string;
  getDisplayLayout?: () => DesktopDisplayLayout;
  getHomeDirectory?: () => string;
  selectFileGrantPath?: (
    kind: 'open-file' | 'open-directory' | 'save-file',
  ) => Promise<string | undefined>;
  openGrantedPath?: (path: string, editorExecutable?: string) => Promise<void>;
  revealGrantedPath?: (path: string) => Promise<void>;
  copyGrantedPaths?: (paths: string[]) => Promise<void>;
  globalHotkey?: GlobalHotkeyRegistrationPort;
  approveWindowClose?: (target: Pick<BrowserWindow, 'close' | 'isDestroyed'>) => void;
  updater?: DesktopUpdaterPort;
}

export class HostCapabilityServer {
  private readonly vault: CredentialVault;
  private readonly windowPreferences: WindowPreferencesStore;
  private readonly windows: DesktopWindowController;
  private readonly webViews: NativeWebViewController;
  private readonly updater: DesktopUpdaterPort;
  private appliedTitleBarStyle: DesktopWindowPreferences['titleBarStyle'] | undefined;
  private appliedAllowMultiInstance: boolean | undefined;
  private readonly grants = new Map<string, StoredGrant>();
  private readonly grantExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly importedGrantDirectory: string;
  private readonly editableGrantDirectory: string;
  private token = '';
  private generation = '';
  private baseUrl = '';
  private lifecycle: DesktopLifecycleState = {
    revision: 0,
    state: 'active',
    lastEvent: 'started',
    changedAt: new Date().toISOString(),
  };
  private readonly server = createServer(
    (request, response) => void this.handle(request, response),
  );

  constructor(
    directory: string,
    private readonly getWindow: () => BrowserWindow | undefined,
    private readonly options: HostCapabilityServerOptions = {},
  ) {
    this.importedGrantDirectory = join(directory, 'file-grants');
    this.editableGrantDirectory = join(directory, 'editable-files');
    this.vault = new CredentialVault(directory);
    this.windowPreferences = new WindowPreferencesStore(
      options.windowPreferencesDirectory ?? directory,
    );
    this.windows = new DesktopWindowController(getWindow, {
      preferences: this.windowPreferences,
      ...(options.getDisplayLayout ? { getDisplayLayout: options.getDisplayLayout } : {}),
      getAppliedTitleBarStyle: () => this.appliedTitleBarStyle,
      getAppliedAllowMultiInstance: () => this.appliedAllowMultiInstance,
      ...(options.globalHotkey ? { globalHotkey: options.globalHotkey } : {}),
      ...(options.approveWindowClose ? { approveClose: options.approveWindowClose } : {}),
    });
    this.webViews = new NativeWebViewController(getWindow);
    this.updater = options.updater ?? new DisabledDesktopUpdater();
  }

  async start(): Promise<void> {
    await Promise.all([this.vault.open(), this.windowPreferences.open()]);
    this.appliedAllowMultiInstance = this.windowPreferences.get().allowMultiInstance;
    this.options.globalHotkey?.update(this.windowPreferences.get().globalHotkey);
    const listening = once(this.server, 'listening');
    this.server.listen(0, '127.0.0.1');
    await listening;
    const address = this.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Host capability server did not bind');
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  activate(generation: string) {
    this.webViews.closeAll();
    this.generation = generation;
    this.token = randomBytes(32).toString('base64url');
    for (const [id, grant] of this.grants)
      if (grant.generation !== generation) void this.revokeGrant(id, grant);
    return { hostCapabilityUrl: this.baseUrl, hostCapabilityToken: this.token };
  }

  async grantCommandLinePath(
    requestedPath: string,
    kind: 'file' | 'directory',
    permissions: FileGrant['permissions'] = ['read'],
  ): Promise<FileGrant> {
    if (!this.generation || !isAbsolute(requestedPath) || Buffer.byteLength(requestedPath) > 4_096)
      throw new Error('Invalid command-line grant path');
    const canonicalPath = await realpath(requestedPath);
    const metadata = await lstat(canonicalPath);
    if (
      (kind === 'file' && !metadata.isFile()) ||
      (kind === 'directory' && !metadata.isDirectory())
    )
      throw new Error('Command-line grant kind does not match the selected path');
    const grantId = `grant_${randomUUID()}`;
    const expiresAt = permissions.includes('write')
      ? undefined
      : new Date(Date.now() + COMMAND_LINE_GRANT_TTL_MS).toISOString();
    const grant: StoredGrant = {
      grantId,
      kind,
      name: basename(canonicalPath),
      ...(kind === 'directory' ? { rootPath: canonicalPath } : {}),
      permissions: [...permissions],
      createdAt: new Date().toISOString(),
      ...(expiresAt ? { expiresAt } : {}),
      path: canonicalPath,
      generation: this.generation,
    };
    const result = fileGrantSchema.parse(withoutPrivateGrantFields(grant));
    this.grants.set(grantId, grant);
    if (expiresAt) {
      const timer = setTimeout(
        () => void this.revokeGrant(grantId, grant),
        COMMAND_LINE_GRANT_TTL_MS,
      );
      timer.unref();
      this.grantExpiryTimers.set(grantId, timer);
    }
    return result;
  }

  preferencesForWindowCreation(): DesktopWindowPreferences {
    const preferences = this.windowPreferences.get();
    if (!preferences.bounds || !this.options.getDisplayLayout) return preferences;
    return {
      ...preferences,
      bounds: correctWindowBounds(preferences.bounds, this.options.getDisplayLayout()),
    };
  }

  markTitleBarStyleApplied(style: DesktopWindowPreferences['titleBarStyle']): void {
    this.appliedTitleBarStyle = style;
  }

  recordLifecycle(event: 'suspend' | 'resume'): DesktopLifecycleState {
    this.lifecycle = desktopLifecycleStateSchema.parse({
      revision: this.lifecycle.revision + 1,
      state: event === 'suspend' ? 'suspended' : 'active',
      lastEvent: event,
      changedAt: new Date().toISOString(),
    });
    return { ...this.lifecycle };
  }

  persistWindowBounds(bounds: DesktopWindowBounds): Promise<DesktopWindowPreferences> {
    return this.windowPreferences.update({ bounds });
  }

  windowClosed(): void {
    this.webViews.closeAll();
  }

  async close(): Promise<void> {
    this.token = '';
    this.webViews.closeAll();
    await this.updater.close();
    await Promise.allSettled([...this.grants].map(([id, grant]) => this.revokeGrant(id, grant)));
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeAllConnections();
    });
    this.vault.close();
    this.options.globalHotkey?.close();
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    try {
      if (
        request.headers.host !== new URL(this.baseUrl).host ||
        !this.authorized(request.headers.authorization)
      )
        return send(response, 401, { code: 'UNAUTHORIZED' });
      const url = new URL(request.url ?? '/', this.baseUrl);
      if (url.search) return send(response, 400, { code: 'INVALID_REQUEST' });
      if (request.method === 'POST' && url.pathname === '/host/v1/grants/import')
        return this.importDroppedFile(request, response);
      if (request.method === 'POST' && url.pathname === '/host/v1/grants/editable')
        return this.importEditableFile(request, response);
      const body =
        request.method === 'GET' || request.method === 'DELETE'
          ? undefined
          : await readJson(request);
      if (request.method === 'GET' && url.pathname === '/host/v1/credentials')
        return send(response, 200, this.vault.list());
      if (request.method === 'POST' && url.pathname === '/host/v1/credentials') {
        const input = hostCredentialPutSchema.parse(body);
        return send(response, 201, await this.vault.put(input));
      }
      let match = /^\/host\/v1\/credentials\/([^/]+)(?:\/(resolve))?$/.exec(url.pathname);
      if (match?.[1] && request.method === 'POST' && match[2] === 'resolve')
        return send(response, 200, { secret: await this.vault.get(match[1]) });
      if (match?.[1] && request.method === 'PATCH' && !match[2]) {
        const input = hostCredentialReplaceSchema.parse(body);
        return send(response, 200, await this.vault.replace(match[1], input.secret));
      }
      if (match?.[1] && request.method === 'DELETE' && !match[2]) {
        await this.vault.delete(match[1]);
        return send(response, 204);
      }
      if (request.method === 'POST' && url.pathname.startsWith('/host/v1/dialogs/'))
        return this.openDialog(url.pathname, response);
      if (request.method === 'POST' && url.pathname === '/host/v1/grants/directory')
        return this.grantLocalDirectory(
          localDirectoryGrantRequestSchema.parse(body).path,
          response,
        );
      if (request.method === 'POST' && url.pathname === '/host/v1/web-views')
        return send(response, 201, await this.webViews.create(hostWebViewCreateSchema.parse(body)));
      match = /^\/host\/v1\/web-views\/([^/]+)(?:\/(actions|auth))?$/.exec(url.pathname);
      if (match?.[1] && request.method === 'GET' && !match[2])
        return send(response, 200, this.webViews.state(match[1]));
      if (match?.[1] && request.method === 'PATCH' && !match[2])
        return send(
          response,
          200,
          this.webViews.present(match[1], hostWebViewPresentationSchema.parse(body)),
        );
      if (match?.[1] && request.method === 'POST' && match[2] === 'actions')
        return send(
          response,
          200,
          await this.webViews.perform(match[1], hostWebViewActionSchema.parse(body)),
        );
      if (match?.[1] && request.method === 'POST' && match[2] === 'auth')
        return send(
          response,
          200,
          this.webViews.authenticate(match[1], hostWebViewAuthResponseSchema.parse(body)),
        );
      if (match?.[1] && request.method === 'DELETE' && !match[2]) {
        this.webViews.close(match[1]);
        return send(response, 204);
      }
      match =
        /^\/host\/v1\/grants\/([^/]+)(?:\/(resolve|list|entries|rename|chmod|delete|open|open-self|reveal|copy-path|operate|transfer-path))?$/.exec(
          url.pathname,
        );
      if (match?.[1] && request.method === 'POST' && match[2] === 'resolve') {
        const grant = this.grants.get(match[1]);
        if (!grant || grant.generation !== this.generation)
          return send(response, 404, { code: 'GRANT_NOT_FOUND' });
        if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) {
          await this.revokeGrant(match[1], grant);
          return send(response, 404, { code: 'GRANT_NOT_FOUND' });
        }
        return send(response, 200, grant);
      }
      if (match?.[1] && request.method === 'POST' && match[2] === 'list')
        return this.listGrantedDirectory(
          match[1],
          grantedDirectoryListRequestSchema.parse(body),
          response,
        );
      if (match?.[1] && request.method === 'POST' && match[2] === 'entries')
        return this.createGrantedEntry(
          match[1],
          grantedEntryCreateRequestSchema.parse(body),
          response,
        );
      if (match?.[1] && request.method === 'POST' && match[2] === 'rename')
        return this.renameGrantedEntry(
          match[1],
          grantedEntryRenameRequestSchema.parse(body),
          response,
        );
      if (match?.[1] && request.method === 'POST' && match[2] === 'chmod')
        return this.chmodGrantedEntry(
          match[1],
          grantedEntryChmodRequestSchema.parse(body),
          response,
        );
      if (match?.[1] && request.method === 'POST' && match[2] === 'delete')
        return this.deleteGrantedEntry(
          match[1],
          grantedEntryPathRequestSchema.parse(body).path,
          response,
        );
      if (match?.[1] && request.method === 'POST' && match[2] === 'open')
        return this.openGrantedEntry(
          match[1],
          grantedEntryPathRequestSchema.parse(body).path,
          response,
        );
      if (match?.[1] && request.method === 'POST' && match[2] === 'open-self')
        return this.openGrantedFile(match[1], grantedFileOpenRequestSchema.parse(body), response);
      if (match?.[1] && request.method === 'POST' && match[2] === 'reveal')
        return this.revealGrantedEntry(
          match[1],
          grantedEntryPathRequestSchema.parse(body).path,
          response,
        );
      if (match?.[1] && request.method === 'POST' && match[2] === 'copy-path')
        return this.copyGrantedEntryPaths(
          match[1],
          grantedEntryPathsRequestSchema.parse(body).paths,
          response,
        );
      if (match?.[1] && request.method === 'POST' && match[2] === 'operate')
        return this.operateGrantedEntries(
          match[1],
          grantedEntriesOperationRequestSchema.parse(body),
          response,
        );
      if (match?.[1] && request.method === 'POST' && match[2] === 'transfer-path')
        return this.resolveGrantedTransferPath(
          match[1],
          grantedTransferPathRequestSchema.parse(body),
          response,
        );
      if (match?.[1] && request.method === 'DELETE' && !match[2]) {
        await this.revokeGrant(match[1], this.grants.get(match[1]));
        return send(response, 204);
      }
      if (request.method === 'POST' && url.pathname === '/host/v1/external-url/open') {
        const input = externalUrlSchema.parse(body);
        const target = new URL(input.url);
        if (!['https:', 'http:'].includes(target.protocol))
          return send(response, 400, { code: 'UNSAFE_URL' });
        await shell.openExternal(target.toString());
        return send(response, 204);
      }
      if (request.method === 'POST' && url.pathname === '/host/v1/notifications') {
        const input = notificationSchema.parse(body);
        if (!Notification.isSupported()) return send(response, 503, { code: 'UNAVAILABLE' });
        new Notification(input).show();
        return send(response, 204);
      }
      if (request.method === 'GET' && url.pathname === '/host/v1/updater/status')
        return send(response, 200, this.updater.status());
      if (request.method === 'POST' && url.pathname === '/host/v1/updater/actions') {
        const input = updaterActionSchema.parse(body);
        return send(response, 202, await this.updater.perform(input.action));
      }
      if (request.method === 'GET' && url.pathname === '/host/v1/desktop/lifecycle')
        return send(response, 200, this.lifecycle);
      if (request.method === 'GET' && url.pathname === '/host/v1/desktop/window')
        return send(response, 200, this.windows.status());
      if (request.method === 'POST' && url.pathname === '/host/v1/desktop/window/actions') {
        const input = desktopWindowActionSchema.parse(body);
        return send(response, 202, this.windows.perform(input.action));
      }
      if (request.method === 'GET' && url.pathname === '/host/v1/desktop/window/preferences')
        return send(response, 200, this.windows.preferences());
      if (request.method === 'PATCH' && url.pathname === '/host/v1/desktop/window/preferences') {
        const input = desktopWindowPreferencesPatchSchema.parse(body);
        return send(response, 200, await this.windows.updatePreferences(input));
      }
      return send(response, 404, { code: 'NOT_FOUND' });
    } catch (error) {
      if (error instanceof SyntaxError || (error && typeof error === 'object' && 'issues' in error))
        return send(response, 400, { code: 'INVALID_REQUEST' });
      if (error instanceof DesktopWindowUnavailableError)
        return send(response, 503, { code: 'WINDOW_UNAVAILABLE' });
      if (error instanceof DesktopGlobalHotkeyUnavailableError)
        return send(response, 409, { code: 'GLOBAL_HOTKEY_UNAVAILABLE' });
      if (error instanceof NativeWebViewNotFoundError)
        return send(response, 404, { code: 'WEB_VIEW_NOT_FOUND' });
      if (error instanceof NativeWebViewConflictError)
        return send(response, 409, { code: 'WEB_VIEW_CONFLICT' });
      if (error instanceof NativeWebViewUnavailableError)
        return send(response, 503, { code: error.code });
      return send(response, 500, { code: 'HOST_CAPABILITY_ERROR' });
    }
  }

  private async openDialog(path: string, response: ServerResponse) {
    const requestKind = path.endsWith('open-directory')
      ? ('open-directory' as const)
      : path.endsWith('save-file')
        ? ('save-file' as const)
        : ('open-file' as const);
    const owner = this.getWindow();
    const options: OpenDialogOptions | undefined = path.endsWith('open-directory')
      ? { properties: ['openDirectory'] }
      : path.endsWith('save-file')
        ? undefined
        : { properties: ['openFile'] };
    let selected: string | undefined;
    let kind: FileGrant['kind'];
    let permissions: FileGrant['permissions'];
    if (this.options.selectFileGrantPath) {
      selected = await this.options.selectFileGrantPath(requestKind);
      kind =
        requestKind === 'open-directory'
          ? 'directory'
          : requestKind === 'save-file'
            ? 'save-target'
            : 'file';
      permissions =
        kind === 'directory' ? ['read', 'write'] : kind === 'file' ? ['read'] : ['write'];
    } else if (path.endsWith('save-file')) {
      const result = owner
        ? await dialog.showSaveDialog(owner, {})
        : await dialog.showSaveDialog({});
      if (!result.canceled) selected = result.filePath;
      kind = 'save-target';
      permissions = ['write'];
    } else {
      const result = owner
        ? await dialog.showOpenDialog(owner, options!)
        : await dialog.showOpenDialog(options!);
      if (!result.canceled) selected = result.filePaths[0];
      kind = path.endsWith('open-directory') ? 'directory' : 'file';
      permissions = kind === 'directory' ? ['read', 'write'] : ['read'];
    }
    if (!selected) return send(response, 204);
    const grantId = `grant_${randomUUID()}`;
    const grant: StoredGrant = {
      grantId,
      kind,
      name: basename(selected),
      permissions,
      createdAt: new Date().toISOString(),
      path: selected,
      ...(kind === 'directory' ? { rootPath: selected } : {}),
      generation: this.generation,
    };
    fileGrantSchema.parse(withoutPrivateGrantFields(grant));
    this.grants.set(grantId, grant);
    return send(response, 201, withoutPrivateGrantFields(grant));
  }

  private async grantLocalDirectory(requestedPath: string | undefined, response: ServerResponse) {
    const target = requestedPath ?? this.options.getHomeDirectory?.() ?? homedir();
    if (!isAbsolute(target)) return send(response, 400, { code: 'INVALID_REQUEST' });
    try {
      const canonicalPath = await realpath(target);
      const metadata = await lstat(canonicalPath);
      if (!metadata.isDirectory())
        return send(response, 400, { code: 'INVALID_GRANTED_PATH_OPERATION' });
      const grant: StoredGrant = {
        grantId: `grant_${randomUUID()}`,
        kind: 'directory',
        name: basename(canonicalPath) || canonicalPath,
        rootPath: canonicalPath,
        permissions: ['read', 'write'],
        createdAt: new Date().toISOString(),
        path: canonicalPath,
        generation: this.generation,
      };
      fileGrantSchema.parse(withoutPrivateGrantFields(grant));
      this.grants.set(grant.grantId, grant);
      return send(response, 201, withoutPrivateGrantFields(grant));
    } catch (error) {
      return sendGrantedFileError(response, error);
    }
  }

  private async importDroppedFile(request: IncomingMessage, response: ServerResponse) {
    return this.importManagedFile(request, response, false);
  }

  private async importEditableFile(request: IncomingMessage, response: ServerResponse) {
    return this.importManagedFile(request, response, true);
  }

  private async importManagedFile(
    request: IncomingMessage,
    response: ServerResponse,
    editable: boolean,
  ) {
    const encodedName = singleHeader(request.headers['x-axterm-file-name']);
    const declaredSize = Number(singleHeader(request.headers['x-axterm-file-size']));
    let name: string;
    try {
      name = decodeURIComponent(encodedName ?? '');
    } catch {
      return send(response, 400, { code: 'INVALID_FILE_NAME' });
    }
    if (
      !safeDroppedFileName(name) ||
      !Number.isSafeInteger(declaredSize) ||
      declaredSize < 0 ||
      declaredSize > (editable ? MAX_EDITABLE_FILE_BYTES : MAX_IMPORTED_FILE_BYTES)
    )
      return send(response, 400, { code: 'INVALID_DROPPED_FILE' });

    const managedRoot = editable
      ? join(this.editableGrantDirectory, randomUUID())
      : this.importedGrantDirectory;
    await mkdir(managedRoot, { recursive: true, mode: 0o700 });
    const importedPath = join(managedRoot, editable ? name : randomUUID());
    let received = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        received += Buffer.byteLength(chunk);
        callback(
          received > (editable ? MAX_EDITABLE_FILE_BYTES : MAX_IMPORTED_FILE_BYTES) ||
            received > declaredSize
            ? new Error('Imported file exceeded its declared size')
            : undefined,
          chunk,
        );
      },
    });
    try {
      await pipeline(request, limit, createWriteStream(importedPath, { flags: 'wx', mode: 0o600 }));
      if (received !== declaredSize) throw new Error('Imported file size did not match');
    } catch {
      if (editable) await rm(managedRoot, { recursive: true, force: true }).catch(() => undefined);
      else await unlink(importedPath).catch(() => undefined);
      return send(response, 400, { code: 'INVALID_DROPPED_FILE' });
    }

    const grantId = `grant_${randomUUID()}`;
    const expiresAt = new Date(Date.now() + IMPORTED_FILE_TTL_MS).toISOString();
    const grant: StoredGrant = {
      grantId,
      kind: 'file',
      name,
      permissions: editable ? ['read', 'write'] : ['read'],
      createdAt: new Date().toISOString(),
      expiresAt,
      path: importedPath,
      generation: this.generation,
      managed: true,
      ...(editable ? { managedRoot } : {}),
    };
    fileGrantSchema.parse(withoutPrivateGrantFields(grant));
    this.grants.set(grantId, grant);
    const timer = setTimeout(() => void this.revokeGrant(grantId, grant), IMPORTED_FILE_TTL_MS);
    timer.unref();
    this.grantExpiryTimers.set(grantId, timer);
    return send(response, 201, withoutPrivateGrantFields(grant));
  }

  private async listGrantedDirectory(
    grantId: string,
    input: { path: string },
    response: ServerResponse,
  ) {
    const grant = this.grants.get(grantId);
    if (!grant || grant.generation !== this.generation)
      return send(response, 404, { code: 'GRANT_NOT_FOUND' });
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) {
      await this.revokeGrant(grantId, grant);
      return send(response, 404, { code: 'GRANT_NOT_FOUND' });
    }
    if (grant.kind !== 'directory' || !grant.permissions.includes('read'))
      return send(response, 400, { code: 'GRANT_NOT_DIRECTORY' });

    try {
      const root = await realpath(grant.path);
      const target = await realpath(join(root, ...input.path.split('/').filter(Boolean)));
      const fromRoot = relative(root, target);
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
        return send(response, 400, { code: 'GRANT_PATH_OUTSIDE_ROOT' });
      const directoryEntries = await readdir(target, { withFileTypes: true });
      const source = directoryEntries
        .sort((left, right) => {
          if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
          return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
        })
        .slice(0, MAX_DIRECTORY_ENTRIES);
      const entries: Array<{
        name: string;
        path: string;
        type: 'file' | 'directory' | 'symlink' | 'other';
        size: number;
        mode?: number;
        modifiedAt?: string;
        accessedAt?: string;
        owner?: string;
        group?: string;
      }> = [];
      for (let offset = 0; offset < source.length; offset += DIRECTORY_STAT_CONCURRENCY) {
        const batch = source.slice(offset, offset + DIRECTORY_STAT_CONCURRENCY);
        const metadata = await Promise.all(
          batch.map(async (entry: Dirent) => {
            const stats = await lstat(join(target, entry.name));
            return {
              name: entry.name,
              path: input.path ? `${input.path}/${entry.name}` : entry.name,
              type: entry.isDirectory()
                ? ('directory' as const)
                : entry.isFile()
                  ? ('file' as const)
                  : entry.isSymbolicLink()
                    ? ('symlink' as const)
                    : ('other' as const),
              size: stats.size,
              mode: stats.mode,
              modifiedAt: stats.mtime.toISOString(),
              accessedAt: stats.atime.toISOString(),
              owner: String(stats.uid),
              group: String(stats.gid),
            };
          }),
        );
        entries.push(...metadata);
      }
      return send(
        response,
        200,
        grantedDirectoryListingSchema.parse({
          grantId,
          rootName: grant.name,
          path: input.path,
          entries,
          truncated: directoryEntries.length > MAX_DIRECTORY_ENTRIES,
        }),
      );
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      if (code === 'ENOENT' || code === 'ENOTDIR')
        return send(response, 404, { code: 'GRANTED_PATH_NOT_FOUND' });
      if (code === 'EACCES' || code === 'EPERM')
        return send(response, 403, { code: 'GRANTED_PATH_FORBIDDEN' });
      throw error;
    }
  }

  private async createGrantedEntry(
    grantId: string,
    input: { path: string; name: string; type: 'file' | 'directory' },
    response: ServerResponse,
  ) {
    const root = await this.resolveGrantedDirectory(grantId, 'write', response);
    if (!root) return;
    try {
      const parent = await realpath(join(root, ...input.path.split('/').filter(Boolean)));
      if (!pathWithin(root, parent))
        return send(response, 400, { code: 'GRANT_PATH_OUTSIDE_ROOT' });
      const target = join(parent, input.name);
      if (input.type === 'directory') await mkdir(target, { mode: 0o700 });
      else await writeFile(target, '', { flag: 'wx', mode: 0o600 });
      return send(response, 204);
    } catch (error) {
      return sendGrantedFileError(response, error);
    }
  }

  private async renameGrantedEntry(
    grantId: string,
    input: { path: string; name: string },
    response: ServerResponse,
  ) {
    const root = await this.resolveGrantedDirectory(grantId, 'write', response);
    if (!root) return;
    try {
      const source = await grantedEntryCandidate(root, input.path);
      await lstat(source);
      const target = join(dirname(source), input.name);
      const targetExists = await lstat(target)
        .then(() => true)
        .catch((error: unknown) => {
          if (fileErrorCode(error) === 'ENOENT') return false;
          throw error;
        });
      if (targetExists) return send(response, 409, { code: 'GRANTED_PATH_EXISTS' });
      await rename(source, target);
      return send(response, 204);
    } catch (error) {
      return sendGrantedFileError(response, error);
    }
  }

  private async deleteGrantedEntry(grantId: string, path: string, response: ServerResponse) {
    const root = await this.resolveGrantedDirectory(grantId, 'write', response);
    if (!root) return;
    try {
      const target = await grantedEntryCandidate(root, path);
      const metadata = await lstat(target);
      await rm(target, { recursive: metadata.isDirectory(), force: false });
      return send(response, 204);
    } catch (error) {
      return sendGrantedFileError(response, error);
    }
  }

  private async chmodGrantedEntry(
    grantId: string,
    input: { path: string; mode: number },
    response: ServerResponse,
  ) {
    const root = await this.resolveGrantedDirectory(grantId, 'write', response);
    if (!root) return;
    try {
      const target = await grantedEntryCandidate(root, input.path);
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink())
        return send(response, 400, { code: 'INVALID_GRANTED_PATH_OPERATION' });
      await chmod(target, input.mode);
      return send(response, 204);
    } catch (error) {
      return sendGrantedFileError(response, error);
    }
  }

  private async openGrantedEntry(grantId: string, path: string, response: ServerResponse) {
    const root = await this.resolveGrantedDirectory(grantId, 'read', response);
    if (!root) return;
    try {
      const candidate = await grantedEntryCandidate(root, path);
      const target = await realpath(candidate);
      if (!pathWithin(root, target))
        return send(response, 400, { code: 'GRANT_PATH_OUTSIDE_ROOT' });
      if (this.options.openGrantedPath) await this.options.openGrantedPath(target);
      else {
        const error = await shell.openPath(target);
        if (error) throw new Error(error);
      }
      return send(response, 204);
    } catch (error) {
      return sendGrantedFileError(response, error);
    }
  }

  private async openGrantedFile(
    grantId: string,
    input: { editorExecutable?: string | undefined },
    response: ServerResponse,
  ) {
    const grant = this.grants.get(grantId);
    if (!grant || grant.generation !== this.generation)
      return send(response, 404, { code: 'GRANT_NOT_FOUND' });
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) {
      await this.revokeGrant(grantId, grant);
      return send(response, 404, { code: 'GRANT_NOT_FOUND' });
    }
    if (grant.kind !== 'file' || !grant.permissions.includes('read'))
      return send(response, 403, { code: 'GRANT_PERMISSION_DENIED' });
    try {
      const target = await realpath(grant.path);
      if (input.editorExecutable) {
        const editorExecutable = await resolveEditorExecutable(input.editorExecutable);
        if (this.options.openGrantedPath)
          await this.options.openGrantedPath(target, editorExecutable);
        else await launchExternalEditor(editorExecutable, target);
      } else if (this.options.openGrantedPath) await this.options.openGrantedPath(target);
      else {
        const error = await shell.openPath(target);
        if (error) throw new Error(error);
      }
      return send(response, 204);
    } catch (error) {
      return sendGrantedFileError(response, error);
    }
  }

  private async revealGrantedEntry(grantId: string, path: string, response: ServerResponse) {
    const root = await this.resolveGrantedDirectory(grantId, 'read', response);
    if (!root) return;
    try {
      const candidate = await grantedEntryCandidate(root, path);
      const target = await realpath(candidate);
      if (!pathWithin(root, target))
        return send(response, 400, { code: 'GRANT_PATH_OUTSIDE_ROOT' });
      if (this.options.revealGrantedPath) await this.options.revealGrantedPath(target);
      else shell.showItemInFolder(target);
      return send(response, 204);
    } catch (error) {
      return sendGrantedFileError(response, error);
    }
  }

  private async copyGrantedEntryPaths(grantId: string, paths: string[], response: ServerResponse) {
    const root = await this.resolveGrantedDirectory(grantId, 'read', response);
    if (!root) return;
    try {
      const targets: string[] = [];
      for (const path of paths) {
        const target = await grantedEntryCandidate(root, path);
        await lstat(target);
        targets.push(target);
      }
      if (this.options.copyGrantedPaths) await this.options.copyGrantedPaths(targets);
      else clipboard.writeText(targets.join('\n'));
      return send(response, 204);
    } catch (error) {
      return sendGrantedFileError(response, error);
    }
  }

  private async resolveGrantedTransferPath(
    grantId: string,
    input: { path: string; intent: 'read' | 'write-target' },
    response: ServerResponse,
  ) {
    const permission = input.intent === 'read' ? 'read' : 'write';
    const root = await this.resolveGrantedDirectory(grantId, permission, response);
    if (!root) return;
    try {
      const candidate = input.path ? await grantedEntryCandidate(root, input.path) : root;
      let target = candidate;
      let kind: FileGrant['kind'] = 'save-target';
      if (input.intent === 'read') {
        const metadata = await lstat(candidate);
        if (metadata.isSymbolicLink())
          return send(response, 400, { code: 'INVALID_GRANTED_PATH_OPERATION' });
        target = await realpath(candidate);
        if (!pathWithin(root, target))
          return send(response, 400, { code: 'GRANT_PATH_OUTSIDE_ROOT' });
        kind = metadata.isDirectory() ? 'directory' : 'file';
      } else {
        const metadata = await lstat(candidate).catch((error: unknown) => {
          if (fileErrorCode(error) === 'ENOENT') return undefined;
          throw error;
        });
        if (metadata?.isSymbolicLink())
          return send(response, 400, { code: 'INVALID_GRANTED_PATH_OPERATION' });
        if (metadata) {
          target = await realpath(candidate);
          if (!pathWithin(root, target))
            return send(response, 400, { code: 'GRANT_PATH_OUTSIDE_ROOT' });
        }
      }
      const parent = this.grants.get(grantId)!;
      return send(
        response,
        200,
        resolvedGrantSchema.parse({
          grantId,
          kind,
          name: basename(target),
          permissions: [permission],
          createdAt: parent.createdAt,
          path: target,
        }),
      );
    } catch (error) {
      return sendGrantedFileError(response, error);
    }
  }

  private async operateGrantedEntries(
    grantId: string,
    input: {
      paths: string[];
      destination: string;
      operation: 'copy' | 'move';
      conflict: 'skip' | 'overwrite' | 'rename';
    },
    response: ServerResponse,
  ) {
    const root = await this.resolveGrantedDirectory(grantId, 'write', response);
    if (!root) return;
    if (
      input.operation === 'copy' &&
      !(await this.resolveGrantedDirectory(grantId, 'read', response))
    )
      return;
    try {
      const destination = await realpath(
        join(root, ...input.destination.split('/').filter(Boolean)),
      );
      if (!pathWithin(root, destination))
        return send(response, 400, { code: 'GRANT_PATH_OUTSIDE_ROOT' });
      const seen = new Set<string>();
      const budget = { remaining: 20_000 };
      for (const path of input.paths) {
        const source = await grantedEntryCandidate(root, path);
        if (seen.has(source)) continue;
        seen.add(source);
        const metadata = await lstat(source);
        if (metadata.isSymbolicLink()) continue;
        if (metadata.isDirectory() && pathWithin(source, destination))
          throw Object.assign(new Error('Cannot place a directory inside itself'), {
            code: 'EINVAL',
          });
        const requestedTarget = join(destination, basename(source));
        if (requestedTarget === source && input.operation === 'move') continue;
        const target = await resolveGrantedOperationTarget(
          source,
          requestedTarget,
          input.operation,
          input.conflict,
          metadata.isDirectory(),
        );
        if (!target) continue;
        if (input.operation === 'move') await rename(source, target);
        else await copyGrantedTree(source, target, budget);
      }
      return send(response, 204);
    } catch (error) {
      return sendGrantedFileError(response, error);
    }
  }

  private async resolveGrantedDirectory(
    grantId: string,
    permission: 'read' | 'write',
    response: ServerResponse,
  ): Promise<string | undefined> {
    const grant = this.grants.get(grantId);
    if (!grant || grant.generation !== this.generation) {
      send(response, 404, { code: 'GRANT_NOT_FOUND' });
      return undefined;
    }
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) {
      await this.revokeGrant(grantId, grant);
      send(response, 404, { code: 'GRANT_NOT_FOUND' });
      return undefined;
    }
    if (grant.kind !== 'directory' || !grant.permissions.includes(permission)) {
      send(response, 403, { code: 'GRANT_PERMISSION_DENIED' });
      return undefined;
    }
    try {
      return await realpath(grant.path);
    } catch (error) {
      sendGrantedFileError(response, error);
      return undefined;
    }
  }

  private async revokeGrant(id: string, candidate: StoredGrant | undefined): Promise<void> {
    const grant = candidate ?? this.grants.get(id);
    this.grants.delete(id);
    const timer = this.grantExpiryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.grantExpiryTimers.delete(id);
    if (grant?.managedRoot)
      await rm(grant.managedRoot, { recursive: true, force: true }).catch(() => undefined);
    else if (grant?.managed) await unlink(grant.path).catch(() => undefined);
  }

  private authorized(header: string | undefined) {
    if (!header?.startsWith('Bearer ') || !this.token) return false;
    const candidate = Buffer.from(header.slice(7));
    const expected = Buffer.from(this.token);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
}

async function resolveEditorExecutable(input: string): Promise<string> {
  if (!isAbsolute(input) || input.includes('\0'))
    throw Object.assign(new Error('The editor executable must be an absolute path'), {
      code: 'EINVAL',
    });
  const executable = await realpath(input);
  const metadata = await lstat(executable);
  if (!metadata.isFile())
    throw Object.assign(new Error('The editor executable is not a file'), { code: 'EINVAL' });
  return executable;
}

async function launchExternalEditor(executable: string, target: string): Promise<void> {
  const child = spawn(executable, [target], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise<void>((resolveLaunch, rejectLaunch) => {
    const reject = (error: Error) => rejectLaunch(error);
    child.once('error', reject);
    child.once('spawn', () => {
      child.off('error', reject);
      child.on('error', () => {});
      child.unref();
      resolveLaunch();
    });
  });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeDroppedFileName(value: string): boolean {
  const forbidden = new Set([0, 10, 13, 34, 39]);
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    basename(value) === value &&
    [...value].every((character) => !forbidden.has(character.codePointAt(0) ?? 0))
  );
}

async function resolveGrantedOperationTarget(
  source: string,
  requestedTarget: string,
  operation: 'copy' | 'move',
  conflict: 'skip' | 'overwrite' | 'rename',
  directory: boolean,
): Promise<string | undefined> {
  const exists = await lstat(requestedTarget).then(
    () => true,
    (error: unknown) => {
      if (fileErrorCode(error) === 'ENOENT') return false;
      throw error;
    },
  );
  if (!exists) return requestedTarget;
  if (requestedTarget === source && operation === 'move') return undefined;
  if (conflict === 'skip') return undefined;
  if (conflict === 'overwrite') {
    if (requestedTarget === source)
      throw Object.assign(new Error('Cannot overwrite an entry with itself'), { code: 'EINVAL' });
    const metadata = await lstat(requestedTarget);
    await rm(requestedTarget, { recursive: metadata.isDirectory(), force: false });
    return requestedTarget;
  }
  const name = basename(requestedTarget);
  const extension = directory ? '' : extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = 1; index <= 999; index += 1) {
    const candidate = join(dirname(requestedTarget), `${stem}(copy-${index})${extension}`);
    const candidateExists = await lstat(candidate).then(
      () => true,
      (error: unknown) => {
        if (fileErrorCode(error) === 'ENOENT') return false;
        throw error;
      },
    );
    if (!candidateExists) return candidate;
  }
  throw Object.assign(new Error('No available conflict name'), { code: 'EEXIST' });
}

async function copyGrantedTree(
  source: string,
  target: string,
  budget: { remaining: number },
): Promise<void> {
  await cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    filter: async (candidate) => {
      budget.remaining -= 1;
      if (budget.remaining < 0)
        throw Object.assign(new Error('Copy exceeds the entry limit'), { code: 'E2BIG' });
      return !(await lstat(candidate)).isSymbolicLink();
    },
  });
}

async function grantedEntryCandidate(root: string, path: string): Promise<string> {
  const candidate = join(root, ...path.split('/'));
  const parent = await realpath(dirname(candidate));
  if (!pathWithin(root, parent))
    throw Object.assign(new Error('Path escaped grant'), { code: 'EACCES' });
  return join(parent, basename(candidate));
}

function pathWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function fileErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

function sendGrantedFileError(response: ServerResponse, error: unknown) {
  const code = fileErrorCode(error);
  if (code === 'ENOENT' || code === 'ENOTDIR')
    return send(response, 404, { code: 'GRANTED_PATH_NOT_FOUND' });
  if (code === 'EACCES' || code === 'EPERM')
    return send(response, 403, { code: 'GRANTED_PATH_FORBIDDEN' });
  if (code === 'EEXIST' || code === 'ENOTEMPTY')
    return send(response, 409, { code: 'GRANTED_PATH_EXISTS' });
  if (code === 'EISDIR' || code === 'EINVAL')
    return send(response, 400, { code: 'INVALID_GRANTED_PATH_OPERATION' });
  if (code === 'E2BIG') return send(response, 413, { code: 'GRANTED_OPERATION_TOO_LARGE' });
  return send(response, 500, { code: 'HOST_CAPABILITY_ERROR' });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 150_000) throw new SyntaxError('Body too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function send(response: ServerResponse, status: number, body?: unknown) {
  response.writeHead(status, body === undefined ? {} : jsonHeaders);
  response.end(body === undefined ? undefined : JSON.stringify(body));
}
function withoutPrivateGrantFields(grant: StoredGrant): FileGrant {
  const {
    path: _path,
    generation: _generation,
    managed: _managed,
    managedRoot: _managedRoot,
    ...publicGrant
  } = grant;
  return publicGrant;
}
