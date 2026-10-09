import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, rename as renamePath } from 'node:fs/promises';
import { basename, dirname, extname, join, parse, relative, sep } from 'node:path';
import type {
  FileRenamePreview,
  FileRenameResult,
  PreviewFileRenameInput,
  RenameWidgetInstanceInput,
  StartLocalFtpServerInput,
  StartLocalFileServerInput,
  StartLocalSshServerInput,
  StartMcpServerInput,
  WidgetDefinition,
  WidgetInstance,
} from '@workspace/contracts';
import {
  previewFileRenameSchema,
  startLocalFileServerSchema,
  startLocalFtpServerSchema,
  startLocalSshServerSchema,
  startMcpServerSchema,
} from '@workspace/contracts';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type {
  LocalFileServerAdapter,
  LocalFtpServerAdapter,
  LocalSshServerAdapter,
  McpServerAdapter,
  McpToolGateway,
  RunningMcpServer,
  RunningWidgetServer,
} from '../ports/widget-server';
import { ApplicationError } from './errors';
import type { RealtimeHub } from './realtime-hub';

interface ManagedWidgetInstance {
  metadata: WidgetInstance;
  server: RunningWidgetServer | RunningMcpServer;
  credentialRef?: string;
}

interface ManagedFileRenameItem {
  sourcePath: string;
  targetPath: string;
  source: string;
  target: string;
  state: 'ready' | 'unchanged' | 'conflict';
  size: number;
  mtimeMs: number;
}

interface ManagedFileRenamePreview {
  metadata: FileRenamePreview;
  items: ManagedFileRenameItem[];
}

const definitions: WidgetDefinition[] = [
  {
    id: 'file-renamer',
    name: 'File Renamer',
    description: 'Batch rename files in a granted folder using a reviewed template.',
    version: '1.0.0',
    type: 'once',
    builtin: true,
    singleInstance: false,
  },
  {
    id: 'local-file-server',
    name: 'Static File Server',
    description: 'Serve files from a granted local folder over a bounded HTTP server.',
    version: '1.0.0',
    type: 'instance',
    builtin: true,
    singleInstance: false,
  },
  {
    id: 'local-ftp-server',
    name: 'Local FTP Server',
    description: 'Share a granted folder through a bounded local FTP server.',
    version: '1.0.0',
    type: 'instance',
    builtin: true,
    singleInstance: false,
  },
  {
    id: 'local-ssh-server',
    name: 'SSH Server',
    description: 'Expose a granted folder through a local SSH, shell and SFTP server.',
    version: '1.0.0',
    type: 'instance',
    builtin: true,
    singleInstance: false,
  },
  {
    id: 'mcp-server',
    name: 'MCP Server',
    description: 'Expose the bounded Axterm AI Tool Registry through authenticated MCP.',
    version: '1.0.0',
    type: 'instance',
    builtin: true,
    singleInstance: true,
  },
];

export class WidgetService {
  private readonly instances = new Map<string, ManagedWidgetInstance>();
  private readonly renamePreviews = new Map<string, ManagedFileRenamePreview>();
  private readonly renameReceipts = new Map<string, FileRenameResult>();
  private mcpToolGateway: McpToolGateway | undefined;

  constructor(
    private readonly generation: string,
    private readonly host: HostCapabilityClient | undefined,
    private readonly localFileServer: LocalFileServerAdapter,
    private readonly localFtpServer: LocalFtpServerAdapter,
    private readonly localSshServer: LocalSshServerAdapter,
    private readonly realtime: RealtimeHub,
    private readonly mcpServer?: McpServerAdapter,
  ) {}

  setMcpToolGateway(gateway: McpToolGateway): void {
    this.mcpToolGateway = gateway;
  }

  listDefinitions(): WidgetDefinition[] {
    return definitions.map((definition) => ({ ...definition }));
  }

  listInstances(): WidgetInstance[] {
    return [...this.instances.values()].map((managed) => this.snapshot(managed));
  }

  getInstance(id: string): WidgetInstance {
    return this.snapshot(this.require(id));
  }

  async previewFileRename(input: PreviewFileRenameInput): Promise<FileRenamePreview> {
    this.clearExpiredPreviews();
    if (this.renamePreviews.size >= 16)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'The active file rename preview limit has been reached',
        503,
      );
    const config = previewFileRenameSchema.parse(input);
    const grant = await this.requireHost().resolveGrant(config.grantId);
    if (
      grant.kind !== 'directory' ||
      !grant.permissions.includes('read') ||
      !grant.permissions.includes('write')
    )
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'The selected grant does not allow modifying a directory',
        400,
      );
    const rootPath = await realpath(grant.path);
    const paths = await collectRenameFiles(rootPath, config.includeSubfolders);
    const fileTypes = normalizeFileTypes(config.fileTypes);
    const selected = paths
      .filter((path) => fileTypes === '*' || fileTypes.has(extname(path).slice(1).toLowerCase()))
      .sort((left, right) => left.localeCompare(right));
    const items: ManagedFileRenameItem[] = [];
    for (const [index, sourcePath] of selected.entries()) {
      const stats = await lstat(sourcePath);
      const targetName = renderRenameTemplate(
        config.template,
        sourcePath,
        stats.birthtimeMs || stats.mtimeMs,
        index,
        config.startNumber,
        config.preserveCase,
      );
      validateRenameTargetName(targetName);
      const targetPath = join(dirname(sourcePath), targetName);
      const source = portableRelative(rootPath, sourcePath);
      const target = portableRelative(rootPath, targetPath);
      let state: ManagedFileRenameItem['state'] = sourcePath === targetPath ? 'unchanged' : 'ready';
      if (state === 'ready' && (await pathExists(targetPath))) state = 'conflict';
      items.push({
        sourcePath,
        targetPath,
        source,
        target,
        state,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    }
    const duplicateTargets = duplicateValues(
      items.filter(({ state }) => state !== 'unchanged').map(({ targetPath }) => targetPath),
    );
    for (const item of items) if (duplicateTargets.has(item.targetPath)) item.state = 'conflict';
    const id = randomUUID();
    const createdAt = new Date();
    const publicItems = items.map(({ source, target, state }) => ({ source, target, state }));
    const ready = items.filter(({ state }) => state === 'ready').length;
    const conflicts = items.filter(({ state }) => state === 'conflict').length;
    const metadata: FileRenamePreview = {
      id,
      rootName: grant.name,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 2 * 60_000).toISOString(),
      total: items.length,
      ready,
      conflicts,
      canRun: ready > 0 && conflicts === 0,
      items: publicItems,
    };
    this.renamePreviews.set(id, { metadata, items });
    this.realtime.publish('widget.file-renamer.previewed', {
      previewId: id,
      total: items.length,
      ready,
      conflicts,
    });
    return structuredClone(metadata);
  }

  async runFileRename(
    previewId: string,
    idempotencyKey: string | undefined,
  ): Promise<FileRenameResult> {
    if (!idempotencyKey)
      throw new ApplicationError('PRECONDITION_REQUIRED', 'Idempotency-Key is required', 428);
    const previous = this.renameReceipts.get(idempotencyKey);
    if (previous) {
      if (previous.previewId !== previewId)
        throw new ApplicationError('CONFLICT', 'Idempotency-Key was already used', 409);
      return structuredClone(previous);
    }
    this.clearExpiredPreviews();
    const preview = this.renamePreviews.get(previewId);
    if (!preview)
      throw new ApplicationError('INVALID_STATE', 'File rename preview is missing or expired', 409);
    if (!preview.metadata.canRun)
      throw new ApplicationError('INVALID_STATE', 'File rename preview contains conflicts', 409);
    this.renamePreviews.delete(previewId);
    const ready = preview.items.filter(({ state }) => state === 'ready');
    for (const item of ready) {
      const current = await lstat(item.sourcePath).catch(() => undefined);
      if (
        !current ||
        !current.isFile() ||
        current.size !== item.size ||
        current.mtimeMs !== item.mtimeMs
      )
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'A source file changed after the rename preview',
          412,
        );
      if (await pathExists(item.targetPath))
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'A target file appeared after the rename preview',
          412,
        );
    }
    const staged: Array<ManagedFileRenameItem & { temporaryPath: string }> = [];
    const completed: Array<ManagedFileRenameItem & { temporaryPath: string }> = [];
    try {
      for (const item of ready) {
        const temporaryPath = join(
          dirname(item.sourcePath),
          `.${basename(item.sourcePath)}.axterm-${randomUUID()}`,
        );
        await renamePath(item.sourcePath, temporaryPath);
        staged.push({ ...item, temporaryPath });
      }
      for (const item of staged) {
        await renamePath(item.temporaryPath, item.targetPath);
        completed.push(item);
      }
    } catch {
      await Promise.allSettled(
        completed.toReversed().map((item) => renamePath(item.targetPath, item.sourcePath)),
      );
      const completedTemps = new Set(completed.map(({ temporaryPath }) => temporaryPath));
      await Promise.allSettled(
        staged
          .filter(({ temporaryPath }) => !completedTemps.has(temporaryPath))
          .toReversed()
          .map((item) => renamePath(item.temporaryPath, item.sourcePath)),
      );
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'File rename failed and a rollback was attempted',
        503,
      );
    }
    const result: FileRenameResult = {
      previewId,
      renamed: ready.length,
      items: ready.map(({ source, target, state }) => ({ source, target, state })),
      finishedAt: new Date().toISOString(),
    };
    this.renameReceipts.set(idempotencyKey, result);
    while (this.renameReceipts.size > 64)
      this.renameReceipts.delete(this.renameReceipts.keys().next().value!);
    this.realtime.publish('widget.file-renamer.completed', {
      previewId,
      renamed: result.renamed,
    });
    return structuredClone(result);
  }

  async startLocalFileServer(input: StartLocalFileServerInput): Promise<WidgetInstance> {
    const config = startLocalFileServerSchema.parse(input);
    if (this.instances.size >= 8)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'The active Widget instance limit has been reached',
        503,
      );
    const host = this.requireHost();
    const grant = await host.resolveGrant(config.grantId);
    if (grant.kind !== 'directory' || !grant.permissions.includes('read'))
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'The selected grant does not allow reading a directory',
        400,
      );
    const now = new Date().toISOString();
    const id = randomUUID();
    const starting: WidgetInstance = {
      id,
      widgetId: 'local-file-server',
      title: config.title,
      state: 'starting',
      bindHost: config.host,
      port: config.port,
      serverInfo: null,
      ownerGeneration: this.generation,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    try {
      const server = await this.localFileServer.start({
        rootPath: grant.path,
        host: config.host,
        port: config.port,
        index: config.index,
        dotfiles: config.dotfiles,
        cacheControl: config.cacheControl,
        maxAgeMs: config.maxAgeMs,
        lastModified: config.lastModified,
        etag: config.etag,
        acceptRanges: config.acceptRanges,
        redirect: config.redirect,
      });
      const metadata: WidgetInstance = {
        ...starting,
        state: 'running',
        bindHost: server.host,
        port: server.port,
        serverInfo: {
          url: server.url,
          rootName: grant.name,
          username: null,
          authentication: 'none',
        },
        updatedAt: new Date().toISOString(),
        version: 2,
      };
      this.instances.set(id, { metadata, server });
      this.publish('widget.instance.started', metadata);
      return { ...metadata };
    } catch (error) {
      const code = bindErrorCode(error);
      this.publish('widget.instance.failed', {
        id,
        widgetId: 'local-file-server',
        errorCode: code,
      });
      throw new ApplicationError(
        code === 'WIDGET_ADDRESS_IN_USE' ? 'CONFLICT' : 'CAPABILITY_UNAVAILABLE',
        code === 'WIDGET_ADDRESS_IN_USE'
          ? 'The requested Widget address is already in use'
          : 'The local file server could not be started',
        code === 'WIDGET_ADDRESS_IN_USE' ? 409 : 503,
      );
    }
  }

  async startLocalFtpServer(input: StartLocalFtpServerInput): Promise<WidgetInstance> {
    const config = startLocalFtpServerSchema.parse(input);
    const grant = await this.resolveWritableDirectory(config.grantId);
    return this.startServerInstance(
      'local-ftp-server',
      config.title,
      config.host,
      config.port,
      grant.name,
      config.anonymous ? null : config.username,
      config.anonymous ? 'none' : 'password',
      () =>
        this.localFtpServer.start({
          rootPath: grant.path,
          host: config.host,
          port: config.port,
          anonymous: config.anonymous,
          username: config.username,
          ...(config.password ? { password: config.password } : {}),
          passivePortStart: config.passivePortStart,
          passivePortEnd: config.passivePortEnd,
        }),
    );
  }

  async startLocalSshServer(input: StartLocalSshServerInput): Promise<WidgetInstance> {
    const config = startLocalSshServerSchema.parse(input);
    const grant = await this.resolveWritableDirectory(config.grantId);
    return this.startServerInstance(
      'local-ssh-server',
      config.title,
      config.host,
      config.port,
      grant.name,
      config.username,
      'password',
      () =>
        this.localSshServer.start({
          rootPath: grant.path,
          host: config.host,
          port: config.port,
          username: config.username,
          password: config.password,
        }),
    );
  }

  async startMcpServer(input: StartMcpServerInput): Promise<WidgetInstance> {
    const config = startMcpServerSchema.parse(input);
    if ([...this.instances.values()].some(({ metadata }) => metadata.widgetId === 'mcp-server'))
      throw new ApplicationError('CONFLICT', 'Only one MCP Server Widget may run at a time', 409);
    if (!this.mcpServer || !this.mcpToolGateway)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'MCP Server is unavailable', 503);
    if (this.instances.size >= 8)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'The active Widget instance limit has been reached',
        503,
      );
    const apiKey = await this.requireHost().resolveCredential(config.credentialRef);
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      const server = await this.mcpServer.start({
        host: config.host,
        port: config.port,
        apiKey,
        enabledTools: config.enabledTools,
        gateway: this.mcpToolGateway,
      });
      const status = server.status();
      const metadata: WidgetInstance = {
        id,
        widgetId: 'mcp-server',
        title: config.title,
        state: 'running',
        bindHost: server.host,
        port: server.port,
        serverInfo: {
          url: server.url,
          rootName: 'AI Tool Registry',
          username: null,
          authentication: 'bearer',
          protocol: 'mcp',
          ...status,
        },
        ownerGeneration: this.generation,
        createdAt: now,
        updatedAt: new Date().toISOString(),
        version: 2,
      };
      this.instances.set(id, { metadata, server, credentialRef: config.credentialRef });
      this.publish('widget.instance.started', metadata);
      return structuredClone(metadata);
    } catch (error) {
      const code = bindErrorCode(error);
      this.publish('widget.instance.failed', { id, widgetId: 'mcp-server', errorCode: code });
      throw new ApplicationError(
        code === 'WIDGET_ADDRESS_IN_USE' ? 'CONFLICT' : 'CAPABILITY_UNAVAILABLE',
        code === 'WIDGET_ADDRESS_IN_USE'
          ? 'The requested MCP Server address is already in use'
          : 'The MCP Server Widget could not be started',
        code === 'WIDGET_ADDRESS_IN_USE' ? 409 : 503,
      );
    }
  }

  rename(id: string, input: RenameWidgetInstanceInput): WidgetInstance {
    const managed = this.require(id);
    managed.metadata = {
      ...managed.metadata,
      title: input.title,
      updatedAt: new Date().toISOString(),
      version: managed.metadata.version + 1,
    };
    this.publish('widget.instance.renamed', managed.metadata);
    return { ...managed.metadata };
  }

  async stop(id: string): Promise<WidgetInstance> {
    const managed = this.require(id);
    if (managed.metadata.state === 'stopping')
      throw new ApplicationError('INVALID_STATE', 'Widget instance is already stopping', 409);
    managed.metadata = {
      ...managed.metadata,
      state: 'stopping',
      updatedAt: new Date().toISOString(),
      version: managed.metadata.version + 1,
    };
    this.publish('widget.instance.stopping', managed.metadata);
    try {
      await managed.server.stop();
    } catch {
      managed.metadata = {
        ...managed.metadata,
        state: 'failed',
        errorCode: 'WIDGET_STOP_FAILED',
        updatedAt: new Date().toISOString(),
        version: managed.metadata.version + 1,
      };
      this.publish('widget.instance.failed', managed.metadata);
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'The Widget instance could not be stopped',
        503,
      );
    }
    managed.metadata = {
      ...managed.metadata,
      state: 'stopped',
      updatedAt: new Date().toISOString(),
      version: managed.metadata.version + 1,
    };
    if (managed.credentialRef)
      await this.host?.deleteCredential(managed.credentialRef).catch(() => {});
    this.instances.delete(id);
    this.publish('widget.instance.stopped', managed.metadata);
    return { ...managed.metadata };
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.instances.keys()].map((id) => this.stop(id)));
    await Promise.allSettled(
      [...this.instances.values()].flatMap(({ credentialRef }) =>
        credentialRef && this.host ? [this.host.deleteCredential(credentialRef)] : [],
      ),
    );
    this.instances.clear();
    this.renamePreviews.clear();
    this.renameReceipts.clear();
  }

  resourceCount(): number {
    return this.instances.size;
  }

  private require(id: string): ManagedWidgetInstance {
    const instance = this.instances.get(id);
    if (!instance) throw new ApplicationError('NOT_FOUND', 'Widget instance not found', 404);
    return instance;
  }

  private snapshot(managed: ManagedWidgetInstance): WidgetInstance {
    if (managed.metadata.serverInfo && 'status' in managed.server) {
      managed.metadata = {
        ...managed.metadata,
        serverInfo: { ...managed.metadata.serverInfo, ...managed.server.status() },
      };
    }
    return structuredClone(managed.metadata);
  }

  private requireHost(): HostCapabilityClient {
    if (!this.host)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Desktop file grants are unavailable',
        503,
      );
    return this.host;
  }

  private async resolveWritableDirectory(grantId: string) {
    const grant = await this.requireHost().resolveGrant(grantId);
    if (
      grant.kind !== 'directory' ||
      !grant.permissions.includes('read') ||
      !grant.permissions.includes('write')
    )
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'The selected grant does not allow sharing a writable directory',
        400,
      );
    return grant;
  }

  private async startServerInstance(
    widgetId: 'local-ftp-server' | 'local-ssh-server',
    title: string,
    host: string,
    port: number,
    rootName: string,
    username: string | null,
    authentication: 'none' | 'password',
    start: () => Promise<RunningWidgetServer>,
  ): Promise<WidgetInstance> {
    if (this.instances.size >= 8)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'The active Widget instance limit has been reached',
        503,
      );
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      const server = await start();
      const metadata: WidgetInstance = {
        id,
        widgetId,
        title,
        state: 'running',
        bindHost: server.host,
        port: server.port,
        serverInfo: { url: server.url, rootName, username, authentication },
        ownerGeneration: this.generation,
        createdAt: now,
        updatedAt: new Date().toISOString(),
        version: 2,
      };
      this.instances.set(id, { metadata, server });
      this.publish('widget.instance.started', metadata);
      return { ...metadata };
    } catch (error) {
      const code = bindErrorCode(error);
      this.publish('widget.instance.failed', { id, widgetId, errorCode: code });
      throw new ApplicationError(
        code === 'WIDGET_ADDRESS_IN_USE' ? 'CONFLICT' : 'CAPABILITY_UNAVAILABLE',
        code === 'WIDGET_ADDRESS_IN_USE'
          ? 'The requested Widget address is already in use'
          : 'The local server Widget could not be started',
        code === 'WIDGET_ADDRESS_IN_USE' ? 409 : 503,
      );
    }
  }

  private clearExpiredPreviews() {
    const now = Date.now();
    for (const [id, preview] of this.renamePreviews)
      if (Date.parse(preview.metadata.expiresAt) <= now) this.renamePreviews.delete(id);
  }

  private publish(type: string, instance: WidgetInstance | Record<string, unknown>) {
    this.realtime.publish(type, instance);
  }
}

async function collectRenameFiles(rootPath: string, recursive: boolean): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, depth: number) {
    if (depth > 32)
      throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Directory nesting exceeds 32 levels', 413);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && recursive) await visit(candidate, depth + 1);
      else if (entry.isFile()) files.push(candidate);
      if (files.length > 1_000)
        throw new ApplicationError(
          'PAYLOAD_TOO_LARGE',
          'File rename is limited to 1,000 files',
          413,
        );
    }
  }
  await visit(rootPath, 0);
  return files;
}

function normalizeFileTypes(value: string): '*' | Set<string> {
  if (value.trim() === '*') return '*';
  const values = value
    .split(',')
    .map((entry) => entry.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);
  if (!values.length)
    throw new ApplicationError('VALIDATION_ERROR', 'At least one file type is required', 400);
  return new Set(values);
}

function renderRenameTemplate(
  template: string,
  sourcePath: string,
  timestamp: number,
  index: number,
  startNumber: number,
  preserveCase: boolean,
): string {
  const source = parse(sourcePath);
  const date = new Date(timestamp);
  const values: Record<string, (argument?: string) => string> = {
    n: (padding) =>
      padding
        ? String(startNumber + index).padStart(Math.min(Number(padding) || 0, 20), '0')
        : String(startNumber + index),
    name: () => (preserveCase ? source.name : source.name.toLowerCase()),
    ext: () => source.ext.slice(1),
    date: () => date.toISOString().slice(0, 10),
    time: () => date.toTimeString().slice(0, 8).replaceAll(':', '-'),
    random: () => randomUUID().replaceAll('-', '').slice(0, 6),
    parent: () => basename(source.dir),
  };
  let result = template;
  for (const [tag, render] of Object.entries(values))
    result = result.replace(new RegExp(`\\{${tag}(?::([^}]+))?\\}`, 'g'), (_, argument) =>
      render(typeof argument === 'string' ? argument : undefined),
    );
  return result;
}

function validateRenameTargetName(name: string) {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.length > 255 ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  )
    throw new ApplicationError('VALIDATION_ERROR', 'Template produced an invalid file name', 400);
}

function portableRelative(rootPath: string, path: string): string {
  return relative(rootPath, path).split(sep).join('/');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function duplicateValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function bindErrorCode(error: unknown): 'WIDGET_ADDRESS_IN_USE' | 'WIDGET_START_FAILED' {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
    ? 'WIDGET_ADDRESS_IN_USE'
    : 'WIDGET_START_FAILED';
}
