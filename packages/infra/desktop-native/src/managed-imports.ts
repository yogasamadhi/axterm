import { lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { join, isAbsolute, dirname, basename } from 'node:path';
import { root, type Root } from '@openclaw/fs-safe/root';
import {
  managedFileImportSchema,
  type FileGrant,
  type ManagedFileImportInput,
} from '@axterm/plugin-api/files';
import type { FileIdentity } from '@axterm/plugin-api/host';
import { NativeError } from './protocol.ts';
import type { NativeFileGrantRegistry } from './grants.ts';
export type ManagedImportInput = ManagedFileImportInput;
interface ImportRecord {
  readonly directory: string;
  readonly path: string;
  readonly rootIdentity: FileIdentity;
  readonly input: ManagedImportInput;
  readonly writeGrant: string;
  readonly expiresAt: number;
  grant: string;
  phase: 'writing' | 'committing' | 'ready' | 'failed';
  cleanup?: Promise<void> | undefined;
}
const same = (left: FileIdentity, right: FileIdentity) =>
  left.device === right.device && left.inode === right.inode;
const identity = (value: { dev: bigint; ino: bigint }): FileIdentity => ({
  device: String(value.dev),
  inode: String(value.ino),
});
const duration = (input: ManagedImportInput) => (input.editableDirectory ? 60 : 30) * 60 * 1000;
/** Shell authority and managed disk only. HTTP bodies remain in the Files owner. */
export class NativeManagedImports {
  private readonly records = new Map<string, ImportRecord>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly orphans = new Map<
    string,
    { size: number; identity: FileIdentity | undefined }
  >();
  private readonly lifetime = new AbortController();
  private readonly opening: Promise<Root>;
  private readonly sweep: ReturnType<typeof setInterval>;
  private reserved = 0;
  private admissions = 0;
  private closing: Promise<void> | undefined;
  private parent: Root | undefined;
  private baseCreated = false;
  private baseIdentity: FileIdentity | undefined;
  private cleanupFailed = false;
  constructor(
    private readonly registry: NativeFileGrantRegistry,
    private readonly directory: string,
  ) {
    if (!isAbsolute(directory)) throw new NativeError('INVALID');
    this.opening = (async () => {
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
      this.parent = await root(dirname(directory), { symlinks: 'reject', hardlinks: 'reject' });
      await mkdir(directory, { mode: 0o700 });
      this.baseCreated = true;
      const metadata = await lstat(directory, { bigint: true });
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new NativeError('STALE');
      this.baseIdentity = identity(metadata);
      const canonical = await realpath(directory);
      return root(canonical, {
        symlinks: 'reject',
        hardlinks: 'reject',
        mode: 0o700,
        durable: true,
      });
    })();
    void this.opening.catch(() => {});
    this.sweep = setInterval(() => {
      for (const record of this.records.values())
        if (record.expiresAt <= Date.now() && !record.cleanup)
          void this.discard(record.grant).catch(() => {});
    }, 60000);
    this.sweep.unref();
  }
  resourceCount(): number {
    return (
      this.pending.size +
      this.records.size +
      this.orphans.size +
      this.admissions +
      (this.cleanupFailed ? 1 : 0)
    );
  }
  prepare(raw: ManagedImportInput, signal: AbortSignal): Promise<FileGrant> {
    this.assertOpen();
    const parsed = managedFileImportSchema.safeParse(raw);
    if (!parsed.success) throw new NativeError('INVALID');
    const input = parsed.data;
    if (
      this.records.size + this.orphans.size + this.admissions >= 32 ||
      this.reserved + input.size > 8 * 1024 * 1024 * 1024
    )
      throw new NativeError('LIMIT');
    this.admissions++;
    this.reserved += input.size;
    return this.track(async () => {
      const owned = AbortSignal.any([signal, this.lifetime.signal]);
      let directory: string | undefined;
      let grant: FileGrant | undefined;
      let admitted = false;
      let filesystem: Root | undefined;
      let directoryIdentity: FileIdentity | undefined;
      try {
        filesystem = await this.opening;
        owned.throwIfAborted();
        directory = 'import-' + randomUUID();
        await filesystem.mkdir(directory);
        const managed = await filesystem.resolve(directory);
        const stat = await lstat(managed, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NativeError('STALE');
        directoryIdentity = identity(stat);
        const path = join(managed, input.name);
        grant = await this.registry.createTrustedPath(
          path,
          'save-target',
          ['write'],
          duration(input),
          owned,
          false,
        );
        const record: ImportRecord = {
          directory,
          path,
          rootIdentity: identity(stat),
          input,
          writeGrant: grant.grantId,
          grant: grant.grantId,
          phase: 'writing',
          expiresAt: Date.now() + duration(input),
        };
        this.records.set(record.grant, record);
        admitted = true;
        owned.throwIfAborted();
        return grant;
      } catch (error) {
        if (grant && admitted) await this.discardOwned(grant.grantId);
        else if (directory && filesystem) {
          try {
            await this.removeOwnedDirectory(filesystem, directory, directoryIdentity);
          } catch {
            this.orphans.set(directory, { size: input.size, identity: directoryIdentity });
            admitted = true;
            throw new NativeError('IO');
          }
        }
        throw error instanceof NativeError
          ? error
          : new NativeError(owned.aborted ? 'CANCELLED' : 'IO');
      } finally {
        this.admissions--;
        if (!admitted) this.reserved -= input.size;
      }
    });
  }
  commit(id: string, signal: AbortSignal): Promise<FileGrant> {
    this.assertOpen();
    const record = this.records.get(id);
    if (!record || record.phase !== 'writing') throw new NativeError('NOT_FOUND');
    record.phase = 'committing';
    return this.track(async () => {
      const owned = AbortSignal.any([signal, this.lifetime.signal]);
      let published: FileGrant | undefined;
      try {
        owned.throwIfAborted();
        if (record.expiresAt <= Date.now()) throw new NativeError('LEASE_EXPIRED');
        const filesystem = await this.opening;
        const directory = await filesystem.resolve(record.directory);
        const parent = await lstat(directory, { bigint: true });
        if (
          !parent.isDirectory() ||
          parent.isSymbolicLink() ||
          !same(identity(parent), record.rootIdentity)
        )
          throw new NativeError('STALE');
        const file = await lstat(record.path, { bigint: true });
        if (
          !file.isFile() ||
          file.isSymbolicLink() ||
          file.nlink !== 1n ||
          file.size !== BigInt(record.input.size)
        )
          throw new NativeError('INVALID');
        published = await this.registry.createTrustedPath(
          record.input.editableDirectory ? directory : record.path,
          record.input.editableDirectory ? 'directory' : 'file',
          record.input.editable ? ['read', 'write'] : ['read'],
          Math.max(1, record.expiresAt - Date.now()),
          owned,
        );
        const authority = await this.registry.authorize(published.grantId, 'read', owned);
        if (
          authority.rootPath !== directory ||
          !same(authority.rootIdentity, record.rootIdentity) ||
          (!record.input.editableDirectory &&
            (!authority.fileIdentity || !same(authority.fileIdentity, identity(file))))
        )
          throw new NativeError('STALE');
        owned.throwIfAborted();
        if (this.records.get(id) !== record || record.phase !== 'committing')
          throw new NativeError('CANCELLED');
        this.revoke(record.writeGrant);
        this.records.delete(id);
        record.grant = published.grantId;
        record.phase = 'ready';
        this.records.set(record.grant, record);
        return published;
      } catch (error) {
        if (published) this.revoke(published.grantId);
        record.phase = 'failed';
        await this.discardOwned(id);
        throw error instanceof NativeError
          ? error
          : new NativeError(owned.aborted ? 'CANCELLED' : 'IO');
      }
    });
  }
  discard(id: string): Promise<void> {
    this.assertOpen();
    return this.track(() => this.discardOwned(id));
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const completion = Promise.withResolvers<void>();
    this.closing = completion.promise;
    this.lifetime.abort();
    clearInterval(this.sweep);
    void (async () => {
      await Promise.allSettled([...this.pending]);
      await this.opening.catch(() => {});
      const results = await Promise.allSettled(
        [...this.records.keys()].map((id) => this.discardOwned(id)),
      );
      const orphanResults = await Promise.allSettled(
        [...this.orphans].map(async ([directory, record]) => {
          const filesystem = await this.opening;
          await this.removeOwnedDirectory(filesystem, directory, record.identity);
          this.orphans.delete(directory);
          this.reserved -= record.size;
        }),
      );
      if (
        [...results, ...orphanResults].some((result) => result.status === 'rejected') ||
        this.records.size ||
        this.orphans.size ||
        this.admissions
      )
        throw new NativeError('IO');
      if (this.baseCreated && this.parent) {
        try {
          const metadata = await lstat(this.directory, { bigint: true }).catch((error) => {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
              return undefined;
            throw error;
          });
          if (metadata && (!this.baseIdentity || !same(identity(metadata), this.baseIdentity)))
            throw new NativeError('STALE');
          await this.parent.remove(basename(this.directory), {
            force: true,
            assertBeforeMutation: () => {
              const current = lstatSync(this.directory, { bigint: true });
              if (
                !this.baseIdentity ||
                !current.isDirectory() ||
                current.isSymbolicLink() ||
                !same(identity(current), this.baseIdentity)
              )
                throw new NativeError('STALE');
            },
          });
          this.baseCreated = false;
        } catch {
          this.cleanupFailed = true;
          throw new NativeError('IO');
        }
      }
    })().then(completion.resolve, completion.reject);
    return this.closing;
  }
  private discardOwned(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) return Promise.resolve();
    return (record.cleanup ??= (async () => {
      this.revoke(record.writeGrant);
      this.revoke(record.grant);
      record.phase = 'failed';
      const filesystem = await this.opening;
      await this.removeOwnedDirectory(filesystem, record.directory, record.rootIdentity);
      if (this.records.get(id) === record) {
        this.records.delete(id);
        this.reserved -= record.input.size;
      }
    })().finally(() => {
      record.cleanup = undefined;
    }));
  }
  private async removeOwnedDirectory(
    filesystem: Root,
    directory: string,
    expected: FileIdentity | undefined,
  ): Promise<void> {
    const assertOwned = () => {
      const metadata = lstatSync(join(this.directory, directory), { bigint: true });
      if (
        !expected ||
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        !same(identity(metadata), expected)
      )
        throw new NativeError('STALE');
    };
    try {
      assertOwned();
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    await filesystem.remove(directory, {
      recursive: true,
      force: true,
      maxEntries: 8,
      maxDepth: 2,
      // fs-safe invokes this synchronous check immediately before each mutation.
      assertBeforeMutation: assertOwned,
    });
  }
  private revoke(id: string): void {
    try {
      this.registry.revoke(id);
    } catch (error) {
      if (!(error instanceof NativeError) || error.code !== 'CLOSED') throw error;
    }
  }
  private assertOpen(): void {
    if (this.lifetime.signal.aborted) throw new NativeError('CLOSED');
  }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(operation);
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
}
