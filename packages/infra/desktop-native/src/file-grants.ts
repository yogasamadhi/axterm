import { Service, type Context } from '@deepseek-ai/cordis';
import { lstat } from 'node:fs/promises';
import { root } from '@openclaw/fs-safe/root';
import { RemoteError } from '@axterm/plugin-api';
import {
  fileGrantRequestSchema,
  managedFileImportSchema,
  grantedDirectoryPathSchema,
  type FileGrant,
  type FileGrantRequest,
  type FilePermission,
  type FilesFailureReason,
} from '@axterm/plugin-api/files';
import type { FileAuthority, FileGrantLease, FileGrants } from '@axterm/plugin-api/host';
import type {} from './credentials.ts';
import { NativeError, type NativeInput, type NativeMethod, type NativeOutput } from './protocol.ts';
import type { NativeClient } from './bridge.ts';
import { ZodError } from 'zod';
const MAX_LEASES = 256;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const failure = (reason: FilesFailureReason) =>
  new RemoteError('files/failure', 'The authorized file operation failed', { reason });
function mapped(error: unknown): RemoteError<'files/failure'> {
  if (error instanceof RemoteError && error.code === 'files/failure')
    return error as RemoteError<'files/failure'>;
  if (error instanceof ZodError) return failure('invalid-input');
  const reasons: Record<string, FilesFailureReason> = {
    CLOSED: 'closed',
    CANCELLED: 'cancelled',
    TIMEOUT: 'cancelled',
    NOT_FOUND: 'not-found',
    FORBIDDEN: 'forbidden',
    STALE: 'stale',
    LIMIT: 'capacity',
    INVALID: 'invalid-input',
    UNAVAILABLE: 'unavailable',
    'outside-workspace': 'forbidden',
    'path-changed': 'stale',
  };
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return failure(reasons[code] ?? 'unavailable');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
interface LeaseRecord {
  readonly id: string;
  readonly abort: AbortController;
  dispose(): void;
}
/** Host-only grant/lease facade; native authority stays in the shell. */
export default class DesktopFileGrants extends Service implements FileGrants {
  static readonly inject = ['desktopNative', 'runtimeIdentity'];
  private readonly lifetime = new AbortController();
  private readonly leases = new Set<LeaseRecord>();
  private readonly pending = new Set<Promise<unknown>>();
  private open = true;
  private closing: Promise<void> | undefined;
  private readonly native: Pick<NativeClient, 'generation' | 'signal' | 'call'>;
  constructor(
    ctx: Context,
    native: Pick<NativeClient, 'generation' | 'signal' | 'call'> = ctx.desktopNative,
  ) {
    super(ctx, 'fileGrants');
    this.native = native;
    if (native.generation !== ctx.runtimeIdentity.generation) throw new NativeError('INVALID');
    ctx.provide('fileImports', {
      prepare: (input, signal) =>
        this.run(() =>
          this.call('fileGrant.import.prepare', managedFileImportSchema.parse(input), signal),
        ),
      commit: (id, signal) =>
        this.run(async () => {
          this.retire(id);
          return this.call('fileGrant.import.commit', { id }, signal);
        }),
      discard: (id) =>
        this.run(async () => {
          this.retire(id);
          await this.call('fileGrant.import.discard', { id });
        }),
    });
    ctx.effect(() => () => this.close());
  }
  create(input: FileGrantRequest, signal?: AbortSignal): Promise<FileGrant | undefined> {
    return this.run(async () => {
      const grant = await this.call(
        'fileGrant.create',
        fileGrantRequestSchema.parse(input),
        signal,
        300_000,
      );
      return grant ?? undefined;
    });
  }
  list(signal?: AbortSignal): Promise<readonly FileGrant[]> {
    return this.run(async () => {
      const items: FileGrant[] = [];
      let offset = 0;
      let revision: number | undefined;
      let bytes = 0;
      for (let pageCount = 0; pageCount < 64; pageCount++) {
        const page = await this.call(
          'fileGrant.list',
          { offset, limit: 256, ...(revision === undefined ? {} : { revision }) },
          signal,
        );
        revision ??= page.revision;
        bytes += Buffer.byteLength(JSON.stringify(page.items));
        if (bytes > 64 * 1024 * 1024) throw failure('capacity');
        items.push(...page.items);
        if (page.nextOffset === null) return freeze(items);
        if (page.nextOffset <= offset) throw failure('unavailable');
        offset = page.nextOffset;
      }
      throw failure('capacity');
    });
  }
  revoke(grantId: string, signal?: AbortSignal): Promise<void> {
    return this.run(async () => {
      this.retire(grantId);
      await this.call('fileGrant.revoke', { grantId }, signal);
    });
  }
  authorize(
    grantId: string,
    permission: FilePermission,
    signal?: AbortSignal,
  ): Promise<FileGrantLease> {
    return this.run(async () => {
      if (this.leases.size >= MAX_LEASES) throw failure('capacity');
      const abort = new AbortController();
      const lifetime = AbortSignal.any([
        this.lifetime.signal,
        this.native.signal,
        abort.signal,
        ...(signal ? [signal] : []),
      ]);
      let active = true;
      const lease: LeaseRecord = {
        id: grantId,
        abort,
        dispose: () => {
          if (!active) return;
          active = false;
          this.leases.delete(lease);
          lifetime.removeEventListener('abort', lease.dispose);
          abort.abort();
        },
      };
      this.leases.add(lease);
      lifetime.addEventListener('abort', lease.dispose, { once: true });
      try {
        const authority = freeze(
          await this.call('fileGrant.authorize', { grantId, permission }, lifetime),
        );
        const assert = () => {
          this.assert();
          if (!active || lifetime.aborted) throw failure('cancelled');
          if (authority.generation !== this.native.generation) throw failure('stale');
          if (authority.grant.expiresAt && Date.parse(authority.grant.expiresAt) <= Date.now()) {
            lease.dispose();
            throw failure('stale');
          }
        };
        assert();
        return { authority, signal: lifetime, assert, dispose: lease.dispose };
      } catch (error) {
        lease.dispose();
        throw error;
      }
    });
  }
  resolveDirectory(grantId: string, path: string, signal?: AbortSignal): Promise<string> {
    return this.run(async () => {
      const relative = grantedDirectoryPathSchema.parse(path);
      const lease = await this.authorize(grantId, 'read', signal);
      try {
        if (lease.authority.grant.kind !== 'directory') throw failure('invalid-input');
        await this.verifyRoot(lease.authority);
        lease.assert();
        const filesystem = await root(lease.authority.rootPath);
        const resolved = relative ? await filesystem.resolve(relative) : filesystem.rootReal;
        if (!(await lstat(resolved)).isDirectory()) throw failure('invalid-input');
        await this.verifyRoot(lease.authority);
        lease.assert();
        return resolved;
      } finally {
        lease.dispose();
      }
    });
  }
  readText(
    grantId: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ name: string; content: string }> {
    return this.run(async () => {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_TEXT_BYTES)
        throw failure('invalid-input');
      const lease = await this.authorize(grantId, 'read', signal);
      try {
        const authority = lease.authority;
        if (authority.grant.kind !== 'file' || !authority.fileName || !authority.fileIdentity)
          throw failure('invalid-input');
        await this.verifyRoot(authority);
        lease.assert();
        const filesystem = await root(authority.rootPath, {
          symlinks: 'reject',
          hardlinks: 'reject',
        });
        const opened = await filesystem.open(authority.fileName);
        try {
          const metadata = await opened.handle.stat({ bigint: true });
          if (
            String(metadata.dev) !== authority.fileIdentity.device ||
            String(metadata.ino) !== authority.fileIdentity.inode
          )
            throw failure('stale');
          if (metadata.size > BigInt(maxBytes)) throw failure('capacity');
          const chunks: Buffer[] = [];
          let total = 0;
          while (total <= maxBytes) {
            lease.assert();
            const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
            const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, total);
            if (!bytesRead) break;
            total += bytesRead;
            if (total > maxBytes) throw failure('capacity');
            chunks.push(buffer.subarray(0, bytesRead));
          }
          await this.verifyRoot(authority);
          lease.assert();
          let content: string;
          try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(
              Buffer.concat(chunks, total),
            );
          } catch {
            throw failure('invalid-input');
          }
          return { name: authority.grant.name, content };
        } finally {
          await opened[Symbol.asyncDispose]();
        }
      } finally {
        lease.dispose();
      }
    });
  }
  resourceCount(): number {
    return this.pending.size + this.leases.size;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.open = false;
    this.lifetime.abort();
    for (const lease of [...this.leases]) lease.dispose();
    return (this.closing = Promise.allSettled([...this.pending]).then(() => {}));
  }
  private async verifyRoot(authority: FileAuthority): Promise<void> {
    const metadata = await lstat(authority.rootPath, { bigint: true });
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      String(metadata.dev) !== authority.rootIdentity.device ||
      String(metadata.ino) !== authority.rootIdentity.inode
    )
      throw failure('stale');
  }
  private retire(id: string): void {
    for (const lease of [...this.leases]) if (lease.id === id) lease.dispose();
  }
  private assert(): void {
    if (!this.open || this.native.signal.aborted) throw failure('closed');
  }
  private call<K extends NativeMethod>(
    method: K,
    input: NativeInput<K>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<NativeOutput<K>> {
    this.assert();
    return this.native
      .call(
        method,
        input,
        AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
        timeoutMs,
      )
      .catch((error) => {
        throw mapped(error);
      });
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.assert();
      if (this.pending.size >= 256) throw failure('capacity');
    } catch (error) {
      return Promise.reject(error);
    }
    const task = Promise.resolve()
      .then(() => {
        this.assert();
        return operation();
      })
      .catch((error) => {
        throw mapped(error);
      });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
}
