import { isAbsolute } from 'node:path';
import { lstat, realpath, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { root, type Root } from '@openclaw/fs-safe/root';
import { grantedDirectoryPathSchema } from '@axterm/plugin-api/files';
import type { FileGrant, FileGrantRequest } from '@axterm/plugin-api/files';
import type { NativeHandlers, NativeMethod } from './protocol.ts';
import { NativeError } from './protocol.ts';
import { NativeFileGrantRegistry } from './grants.ts';
import { NativeManagedImports } from './managed-imports.ts';
export interface NativeFileApplications {
  open(path: string): Promise<void>;
  reveal(path: string): Promise<void>;
}
export interface NativeFileChooser {
  choose(
    kind: 'open-file' | 'open-directory' | 'save-file',
    signal: AbortSignal,
  ): Promise<string | undefined>;
  defaultDirectory(kind: 'home' | 'downloads'): string;
  /** Called only after generation authority has retired; must drain outstanding native panels. */
  retire(): void | Promise<void>;
}
export type NativeFileHandlers = Pick<NativeHandlers, Extract<NativeMethod, `fileGrant.${string}`>>;
/** Native authority only. No listing, editing, transfer or file-body RPC is registered here. */
export class ShellFileGrantCapabilities {
  readonly registry: NativeFileGrantRegistry;
  private readonly managed: NativeManagedImports | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  private selecting = false;
  private readonly applicationJobs = new Map<string, Promise<true>>();
  private readonly applicationRecent = new Set<string>();
  private readonly failedPins = new Set<Awaited<ReturnType<Root['open']>>>();
  private readonly drops = new Map<
    string,
    { path: string; device: bigint; inode: bigint; expiresAt: number }
  >();
  private active = true;
  private closing: Promise<void> | undefined;
  constructor(
    generation: string,
    private readonly chooser?: NativeFileChooser,
    managedDirectory?: string,
    private readonly applications?: NativeFileApplications,
  ) {
    this.registry = new NativeFileGrantRegistry(generation);
    this.managed =
      managedDirectory === undefined
        ? undefined
        : new NativeManagedImports(this.registry, managedDirectory);
  }
  issueDirectoryDrop(path: string): Promise<string> {
    if (this.pending.size >= 32) return Promise.reject(new NativeError('LIMIT'));
    return this.track(
      (async () => {
        if (!this.active) throw new NativeError('CLOSED');
        for (const [id, drop] of this.drops)
          if (drop.expiresAt <= Date.now()) this.drops.delete(id);
        if (this.drops.size >= 64) throw new NativeError('LIMIT');
        const metadata = await lstat(path, { bigint: true });
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
          throw new NativeError('FORBIDDEN');
        const canonical = await realpath(path),
          verified = await lstat(canonical, { bigint: true });
        if (
          !verified.isDirectory() ||
          verified.dev !== metadata.dev ||
          verified.ino !== metadata.ino
        )
          throw new NativeError('STALE');
        if (!this.active) throw new NativeError('CLOSED');
        if (this.drops.size >= 64) throw new NativeError('LIMIT');
        const ticket = randomUUID();
        this.drops.set(ticket, {
          path: canonical,
          device: verified.dev,
          inode: verified.ino,
          expiresAt: Date.now() + 60_000,
        });
        return ticket;
      })(),
    );
  }
  discardDirectoryDrop(ticket: string) {
    this.drops.delete(ticket);
  }
  handlers(): NativeFileHandlers {
    return {
      'fileGrant.import.prepare': (input, signal) =>
        this.track(Promise.resolve().then(() => this.imports().prepare(input, signal))),
      'fileGrant.import.commit': ({ id }, signal) =>
        this.track(Promise.resolve().then(() => this.imports().commit(id, signal))),
      'fileGrant.import.discard': ({ id }) =>
        this.track(
          Promise.resolve().then(async () => {
            await this.imports().discard(id);
            return true as const;
          }),
        ),
      'fileGrant.open': (input, signal) => this.track(this.admitApplication('open', input, signal)),
      'fileGrant.reveal': (input, signal) =>
        this.track(this.admitApplication('reveal', input, signal)),
      'fileGrant.application.drain': ({ key }) =>
        this.track(
          Promise.resolve().then(async () => {
            if (!this.active) throw new NativeError('CLOSED');
            await this.applicationJobs.get(key)?.catch(() => {});
            return true as const;
          }),
        ),
      'fileGrant.create': (input, signal) => this.track(this.create(input, signal)),
      'fileGrant.list': ({ offset, limit, revision }) => {
        const page = this.registry.list(offset, limit, revision);
        return { ...page, items: [...page.items] };
      },
      'fileGrant.authorize': ({ grantId, permission }, signal) =>
        this.track(this.registry.authorize(grantId, permission, signal)),
      'fileGrant.revoke': ({ grantId }) =>
        this.track(
          Promise.resolve().then(async () => {
            this.registry.revoke(grantId);
            await this.managed?.discard(grantId);
            return true as const;
          }),
        ),
    };
  }
  resourceCount(): number {
    return this.pending.size + this.failedPins.size + (this.managed?.resourceCount() ?? 0);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.active = false;
    this.registry.close();
    this.drops.clear();
    return (this.closing = (async () => {
      const [managed, chooser] = await Promise.allSettled([
        this.managed?.close(),
        Promise.resolve().then(() => this.chooser?.retire()),
        Promise.allSettled([...this.pending]),
      ]);
      await Promise.allSettled(
        [...this.failedPins].map(async (pin) => {
          await pin[Symbol.asyncDispose]();
          this.failedPins.delete(pin);
        }),
      );
      if (this.failedPins.size) throw new NativeError('IO');
      if (managed.status === 'rejected' || chooser.status === 'rejected')
        throw new NativeError('IO');
    })());
  }
  private admitApplication(
    action: 'open' | 'reveal',
    input: { key: string; grantId: string; path: string },
    signal: AbortSignal,
  ): Promise<true> {
    if (!this.active) return Promise.reject(new NativeError('CLOSED'));
    if (this.applicationJobs.has(input.key) || this.applicationRecent.has(input.key))
      return Promise.reject(new NativeError('CONFLICT'));
    if (this.applicationJobs.size >= 32) return Promise.reject(new NativeError('LIMIT'));
    const task = Promise.resolve().then(() => this.performApplication(action, input, signal));
    this.applicationJobs.set(input.key, task);
    void task
      .finally(() => {
        this.applicationJobs.delete(input.key);
        this.applicationRecent.add(input.key);
        if (this.applicationRecent.size > 256)
          this.applicationRecent.delete(this.applicationRecent.values().next().value!);
      })
      .catch(() => {});
    return task;
  }
  private async performApplication(
    action: 'open' | 'reveal',
    input: { grantId: string; path: string },
    signal: AbortSignal,
  ): Promise<true> {
    if (!this.active) throw new NativeError('CLOSED');
    if (!this.applications) throw new NativeError('UNAVAILABLE');
    if (this.pending.size >= 32) throw new NativeError('LIMIT');
    const authority = await this.registry.authorize(input.grantId, 'read', signal);
    const relative =
      authority.grant.kind === 'directory'
        ? grantedDirectoryPathSchema.parse(input.path)
        : authority.fileName!;
    if (
      authority.grant.kind === 'save-target' ||
      (authority.grant.kind !== 'directory' && input.path && input.path !== relative)
    )
      throw new NativeError('FORBIDDEN');
    const same = (
      stat: { dev: bigint; ino: bigint },
      identity: { device: string; inode: string },
    ) => String(stat.dev) === identity.device && String(stat.ino) === identity.inode;
    const verifyRoot = async () => {
      signal.throwIfAborted();
      if (!this.active) throw new NativeError('CLOSED');
      await this.registry.authorize(input.grantId, 'read', signal);
      const metadata = await lstat(authority.rootPath, { bigint: true });
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        !same(metadata, authority.rootIdentity)
      )
        throw new NativeError('STALE');
    };
    let opened: Awaited<ReturnType<Root['open']>> | undefined;
    let admitted = false;
    try {
      await verifyRoot();
      const filesystem = await root(authority.rootPath, {
        symlinks: 'reject',
        hardlinks: 'reject',
      });
      if (filesystem.rootReal !== authority.rootPath) throw new NativeError('STALE');
      const metadata = await filesystem.stat(relative);
      if (metadata.isSymbolicLink || (!metadata.isFile && !metadata.isDirectory))
        throw new NativeError('FORBIDDEN');
      if (metadata.isFile) {
        opened = await filesystem.open(relative, { symlinks: 'reject', hardlinks: 'reject' });
        if (
          authority.fileIdentity &&
          !same(await opened.handle.stat({ bigint: true }), authority.fileIdentity)
        )
          throw new NativeError('STALE');
      }
      const path = relative ? await filesystem.resolve(relative) : filesystem.rootReal;
      const targetIdentity = opened
        ? await opened.handle.stat({ bigint: true })
        : await lstat(path, { bigint: true });
      const verifyTarget = async () => {
        await verifyRoot();
        const current = await lstat(path, { bigint: true });
        if (
          current.isSymbolicLink() ||
          (current.isFile() && current.nlink !== 1n) ||
          String(current.dev) !== String(targetIdentity.dev) ||
          String(current.ino) !== String(targetIdentity.ino)
        )
          throw new NativeError('STALE');
      };
      await verifyTarget();
      admitted = true;
      await this.applications[action](path);
      await verifyTarget();
      return true;
    } catch (error) {
      if (admitted) throw new NativeError('MUTATION_FAILED');
      if (error instanceof NativeError) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      throw new NativeError(
        signal.aborted
          ? 'CANCELLED'
          : [
                'symlink',
                'hardlink',
                'symlink-disallowed',
                'hardlink-disallowed',
                'outside-workspace',
              ].includes(code)
            ? 'FORBIDDEN'
            : code === 'ENOENT'
              ? 'NOT_FOUND'
              : 'IO',
      );
    } finally {
      if (opened) await this.releasePin(opened);
    }
  }
  private async releasePin(pin: Awaited<ReturnType<Root['open']>>): Promise<void> {
    try {
      await pin[Symbol.asyncDispose]();
    } catch {
      this.failedPins.add(pin);
      throw new NativeError('IO');
    }
  }
  private imports(): NativeManagedImports {
    if (!this.active) throw new NativeError('CLOSED');
    if (!this.managed) throw new NativeError('UNAVAILABLE');
    return this.managed;
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  private async create(input: FileGrantRequest, signal: AbortSignal): Promise<FileGrant | null> {
    if (!this.active) throw new NativeError('CLOSED');
    signal.throwIfAborted();
    if (input.kind === 'dropped-directory') {
      const drop = this.drops.get(input.ticket);
      this.drops.delete(input.ticket);
      if (!drop || drop.expiresAt <= Date.now()) throw new NativeError('NOT_FOUND');
      const current = await lstat(drop.path, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== drop.device ||
        current.ino !== drop.inode
      )
        throw new NativeError('STALE');
      const grant = await this.registry.createTrustedPath(
        drop.path,
        'directory',
        ['read', 'write'],
        undefined,
        signal,
      );
      try {
        const authority = await this.registry.authorize(grant.grantId, 'read', signal);
        if (
          authority.rootIdentity.device !== String(drop.device) ||
          authority.rootIdentity.inode !== String(drop.inode)
        )
          throw new NativeError('STALE');
        return grant;
      } catch (error) {
        this.registry.revoke(grant.grantId);
        throw error;
      }
    }
    if (!this.chooser) throw new NativeError('UNAVAILABLE');
    if (input.kind === 'directory-path')
      return this.registry.createTrustedPath(
        input.path,
        'directory',
        ['read', 'write'],
        undefined,
        signal,
      );
    if (input.kind === 'home-directory' || input.kind === 'downloads-directory') {
      const directory = this.chooser.defaultDirectory(
        input.kind === 'home-directory' ? 'home' : 'downloads',
      );
      if (input.kind === 'downloads-directory') {
        if (
          typeof directory !== 'string' ||
          !isAbsolute(directory) ||
          directory.includes('\0') ||
          Buffer.byteLength(directory) > 4096
        )
          throw new NativeError('INVALID');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        signal.throwIfAborted();
        if (!this.active) throw new NativeError('CLOSED');
      }
      return this.registry.createTrustedPath(
        directory,
        'directory',
        ['read', 'write'],
        undefined,
        signal,
      );
    }
    if (this.selecting) throw new NativeError('LIMIT');
    this.selecting = true;
    try {
      const path = await this.chooser.choose(input.kind, signal);
      signal.throwIfAborted();
      if (!this.active) throw new NativeError('CLOSED');
      if (!path) return null;
      return await this.registry.createTrustedPath(
        path,
        input.kind === 'open-directory'
          ? 'directory'
          : input.kind === 'save-file'
            ? 'save-target'
            : 'file',
        input.kind === 'open-file'
          ? ['read']
          : input.kind === 'save-file'
            ? ['write']
            : ['read', 'write'],
        undefined,
        signal,
      );
    } finally {
      this.selecting = false;
    }
  }
}
