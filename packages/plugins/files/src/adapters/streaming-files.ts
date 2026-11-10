import { randomUUID } from 'node:crypto';
import { lstat, type FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { applyPinnedMode, applyPinnedTimes } from './local-mode.ts';
import { root, type Root } from '@openclaw/fs-safe/root';
import { RemoteError, remoteErrorOf } from '@axterm/plugin-api';
import {
  grantedDirectoryPathSchema,
  type GrantedDirectoryEntry,
  type FilePermission,
  type FilesFailureReason,
} from '@axterm/plugin-api/files';
import type {
  FileGrantLease,
  FileGrants,
  HostFiles,
  LocalFileLease,
  LocalDirectoryWriter,
} from '@axterm/plugin-api/host';

const MAX_BYTES = 16 * 1024 ** 4;
const fail = (reason: FilesFailureReason) =>
  new RemoteError('files/failure', 'The authorized file stream could not complete', { reason });
function mapped(error: unknown): Error {
  if (remoteErrorOf(error)?.code === 'files/failure') return error as Error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const reasons: Record<string, FilesFailureReason> = {
    ENOENT: 'not-found',
    EEXIST: 'conflict',
    EACCES: 'forbidden',
    EPERM: 'forbidden',
    ELOOP: 'forbidden',
    ENOSPC: 'capacity',
    EDQUOT: 'capacity',
    'outside-workspace': 'forbidden',
    symlink: 'forbidden',
    hardlink: 'forbidden',
    'symlink-disallowed': 'forbidden',
    'hardlink-disallowed': 'forbidden',
    'path-mismatch': 'stale',
    'path-changed': 'stale',
    'too-large': 'capacity',
    'already-exists': 'conflict',
    'not-found': 'not-found',
    'not-file': 'invalid-input',
    'invalid-path': 'invalid-input',
    'not-empty': 'conflict',
    'denied-path': 'forbidden',
    'device-path': 'forbidden',
    'path-alias': 'forbidden',
    'not-owned': 'forbidden',
    'insecure-permissions': 'forbidden',
    'permission-unverified': 'forbidden',
  };
  return fail(reasons[code] ?? 'unavailable');
}
/** Only the final atomic publication boundary interprets no-replace capability failures. */
async function publishStage(
  filesystem: Root,
  source: string,
  target: string,
  overwrite: boolean,
): Promise<void> {
  try {
    await filesystem.move(source, target, { overwrite });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (['helper-unavailable', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(code))
      throw fail('unsupported-destination');
    throw error;
  }
}
const same = (
  metadata: { dev: bigint; ino: bigint },
  identity: { device: string; inode: string },
) => String(metadata.dev) === identity.device && String(metadata.ino) === identity.inode;

/** Files retains native paths, handles and private stages; consumers get bounded virtual IO. */
export class GrantedStreamingFiles implements HostFiles {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly leases = new Set<StreamingLease>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly grants: () => Pick<FileGrants, 'authorize'>,
    private readonly openRoot: typeof root = root,
  ) {}
  open(grantId: string, permission: FilePermission, signal?: AbortSignal): Promise<LocalFileLease> {
    if (this.lifetime.signal.aborted) return Promise.reject(fail('closed'));
    if (this.pending.size >= 64 || this.pending.size + this.leases.size >= 256)
      return Promise.reject(fail('capacity'));
    const lifetime = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const opening = (async () => {
      let grant: FileGrantLease | undefined;
      try {
        lifetime.throwIfAborted();
        grant = await this.grants().authorize(grantId, permission, lifetime);
        grant.assert();
        const owned = grant;
        const verify = async () => {
          owned.assert();
          lifetime.throwIfAborted();
          const metadata = await lstat(owned.authority.rootPath, { bigint: true });
          if (
            !metadata.isDirectory() ||
            metadata.isSymbolicLink() ||
            !same(metadata, owned.authority.rootIdentity)
          )
            throw fail('stale');
          owned.assert();
          lifetime.throwIfAborted();
        };
        await verify();
        const filesystem = await this.openRoot(grant.authority.rootPath, {
          hardlinks: 'reject',
          symlinks: 'reject',
          assertBeforeMutation: grant.assert,
          mode: 0o700,
        });
        await verify();
        const cleanup = await this.openRoot(grant.authority.rootPath, {
          hardlinks: 'reject',
          symlinks: 'reject',
        });
        await verify();
        const lease = new StreamingLease(grant, filesystem, cleanup, permission, verify, () =>
          this.leases.delete(lease),
        );
        this.leases.add(lease);
        return lease;
      } catch (error) {
        grant?.dispose();
        throw lifetime.aborted ? fail('cancelled') : mapped(error);
      }
    })();
    this.pending.add(opening);
    void opening.then(
      () => this.pending.delete(opening),
      () => this.pending.delete(opening),
    );
    return opening;
  }
  resourceCount(): number {
    return this.pending.size + this.leases.size;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    return (this.closing = (async () => {
      const closed = await Promise.allSettled([...this.leases].map((lease) => lease.close()));
      await Promise.allSettled([...this.pending]);
      if (closed.some((item) => item.status === 'rejected') || this.leases.size)
        throw fail('unavailable');
    })());
  }
}

class StreamingLease implements LocalFileLease {
  readonly path: string;
  readonly signal: AbortSignal;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly streams = new Map<Readable, Promise<void>>();
  private closing: Promise<void> | undefined;
  private readsOpening = 0;
  private readonly stages = new Set<string>();
  private readonly directoryStages = new Set<string>();
  private readonly preservedBackups = new Set<string>();
  private readonly expiry: NodeJS.Timeout | undefined;
  constructor(
    private readonly grant: FileGrantLease,
    private readonly filesystem: Root,
    private readonly cleanup: Root,
    private readonly permission: FilePermission,
    private readonly verifyRoot: () => Promise<void>,
    private readonly released: () => void,
  ) {
    this.path = grant.authority.fileName ?? '';
    this.signal = AbortSignal.any([grant.signal, this.lifetime.signal]);
    this.signal.addEventListener('abort', this.aborted, { once: true });
    const expires = grant.authority.grant.expiresAt;
    this.expiry = expires
      ? setTimeout(() => this.lifetime.abort(), Math.max(0, Date.parse(expires) - Date.now()))
      : undefined;
  }
  private readonly aborted = () => {
    void this.close().catch(() => {});
  };
  private assert(): void {
    this.grant.assert();
    if (this.signal.aborted || this.closing) throw fail('cancelled');
  }
  private validate(path: string): string {
    this.assert();
    try {
      grantedDirectoryPathSchema.parse(path);
    } catch {
      throw fail('invalid-input');
    }
    if (this.grant.authority.grant.kind !== 'directory' && path !== this.path)
      throw fail('forbidden');
    return path;
  }
  private writePermission(): void {
    if (this.permission !== 'write') throw fail('forbidden');
  }
  private async verifyFile(path: string): Promise<void> {
    const authority = this.grant.authority;
    if (authority.grant.kind === 'directory') return;
    const metadata = await lstat(await this.filesystem.resolve(path), { bigint: true }).catch(
      (error: unknown) => {
        if (
          authority.grant.kind === 'save-target' &&
          !authority.fileIdentity &&
          (error as NodeJS.ErrnoException).code === 'ENOENT'
        )
          return undefined;
        throw error;
      },
    );
    if (!metadata) return;
    if (
      !authority.fileIdentity ||
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      !same(metadata, authority.fileIdentity)
    )
      throw fail('stale');
  }
  private run<T>(operation: () => Promise<T>, cleanup?: () => Promise<void>): Promise<T> {
    try {
      this.assert();
      if (this.pending.size >= 64) throw fail('capacity');
    } catch (error) {
      return Promise.reject(error).finally(cleanup);
    }
    const task = (async () => {
      try {
        this.assert();
        await this.verifyRoot();
        this.assert();
        const result = await operation();
        await this.verifyRoot();
        this.assert();
        return result;
      } catch (error) {
        throw this.signal.aborted ? fail('cancelled') : mapped(error);
      } finally {
        await cleanup?.();
      }
    })();
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  stat(path: string): Promise<GrantedDirectoryEntry> {
    return this.run(async () => {
      this.validate(path);
      await this.verifyFile(path);
      const metadata = await this.metadata(path);
      return entry(path, metadata, this.grant.authority.grant.name);
    });
  }
  list(path: string): Promise<readonly GrantedDirectoryEntry[]> {
    return this.run(async () => {
      this.validate(path);
      if (this.grant.authority.grant.kind !== 'directory') throw fail('forbidden');
      const result: GrantedDirectoryEntry[] = [];
      for await (const item of this.filesystem.entries(path, {
        maxEntries: 20_001,
        order: 'filesystem',
        symlinks: 'reject',
        signal: this.signal,
      })) {
        this.assert();
        if (result.length >= 20_000) throw fail('capacity');
        const child = path ? `${path}/${item.name}` : item.name;
        this.validate(child);
        result.push(entry(child, item));
      }
      return result;
    });
  }
  read(path: string, options?: { start?: number; end?: number }): Promise<Readable> {
    return this.run(async () => {
      this.validate(path);
      if (this.permission !== 'read') throw fail('forbidden');
      if (this.streams.size + this.readsOpening >= 32) throw fail('capacity');
      this.readsOpening++;
      try {
        for (const value of [options?.start, options?.end])
          if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
            throw fail('invalid-input');
        if (options?.end !== undefined && options.end < (options.start ?? 0))
          throw fail('invalid-input');
        await this.verifyFile(path);
        const opened = await this.filesystem.open(path, {
          symlinks: 'reject',
          hardlinks: 'reject',
        });
        try {
          this.assert();
          await this.verifyFile(path);
          await this.verifyRoot();
          this.assert();
        } catch (error) {
          await opened[Symbol.asyncDispose]();
          throw error;
        }
        if (!opened.stat.isFile() || opened.stat.size > MAX_BYTES) {
          await opened[Symbol.asyncDispose]();
          throw fail('capacity');
        }
        const handle: FileHandle = opened.handle;
        if (
          this.grant.authority.fileIdentity &&
          !same(await handle.stat({ bigint: true }), this.grant.authority.fileIdentity)
        ) {
          await opened[Symbol.asyncDispose]();
          throw fail('stale');
        }
        const native = handle.createReadStream({
          highWaterMark: 64 * 1024,
          autoClose: true,
          start: options?.start ?? 0,
          ...(options?.end === undefined ? {} : { end: options.end }),
          signal: this.signal,
        });
        native.pause();
        const nativeClosed = native.closed
          ? Promise.resolve()
          : new Promise<void>((resolve) => native.once('close', resolve));
        const done = Promise.withResolvers<void>();
        const stream = new Readable({
          highWaterMark: 64 * 1024,
          read: () => native.resume(),
          destroy: (error, callback) => {
            native.destroy();
            void (async () => {
              await nativeClosed;
              await opened[Symbol.asyncDispose]();
            })().then(
              () => {
                done.resolve();
                callback(error);
              },
              (failure) => {
                done.reject(failure);
                callback(error ?? mapped(failure));
              },
            );
          },
        });
        const data = (chunk: Buffer | string) => {
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          try {
            this.assert();
            if (!stream.push(bytes)) native.pause();
          } catch (error) {
            stream.destroy(mapped(error));
          }
        };
        const ended = () => {
          stream.push(null);
        };
        const failed = (error: Error) => {
          stream.destroy(this.signal.aborted ? fail('cancelled') : mapped(error));
        };
        const closed = () => {
          if (!native.readableEnded && !stream.destroyed) stream.destroy(fail('cancelled'));
        };
        native.on('data', data);
        native.once('end', ended);
        native.once('error', failed);
        native.once('close', closed);
        stream.once('close', () => {
          native.off('data', data);
          native.off('end', ended);
          native.off('error', failed);
          native.off('close', closed);
        });
        stream.on('error', () => {});
        this.streams.set(stream, done.promise);
        void done.promise.then(
          () => this.streams.delete(stream),
          () => {},
        );
        return stream;
      } finally {
        this.readsOpening--;
      }
    });
  }
  write(
    path: string,
    input: Readable,
    options?: { overwrite?: boolean; mode?: number },
  ): Promise<void> {
    const aborted = () => {
      input.destroy(fail('cancelled'));
    };
    input.on('error', observed);
    this.signal.addEventListener('abort', aborted, { once: true });
    return this.run(
      async () => {
        this.validate(path);
        this.writePermission();
        if (!path) throw fail('invalid-input');
        const mode = options?.mode ?? 0o600;
        if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw fail('invalid-input');
        await this.verifyFile(path);
        const temporary = posix.join(posix.dirname(path), `.axterm-${randomUUID()}.part`);
        this.stages.add(temporary);
        let count = 0;
        const assert = () => this.assert();
        const chunks = (async function* () {
          for await (const chunk of input) {
            assert();
            const bytes = Buffer.from(chunk);
            count += bytes.length;
            if (count > MAX_BYTES) throw fail('capacity');
            yield bytes;
          }
        })();
        try {
          this.assert();
          await this.filesystem.create(temporary, chunks, {
            mode,
            maxBytes: MAX_BYTES,
            signal: this.signal,
          });
          await this.verifyRoot();
          await this.verifyFile(path);
          this.assert();
          const previous = await this.filesystem.stat(path).catch((error: unknown) => {
            const code =
              error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
            if (['ENOENT', 'not-found'].includes(code)) return undefined;
            throw error;
          });
          if (previous?.isDirectory && options?.overwrite) {
            if (this.grant.authority.grant.kind !== 'directory') throw fail('forbidden');
            const backup = posix.join(posix.dirname(path), `.axterm-${randomUUID()}.backup`);
            await moveDirectory(this.filesystem, path, backup);
            this.preservedBackups.add(backup);
            try {
              await publishStage(this.filesystem, temporary, path, false);
            } catch (error) {
              try {
                await moveDirectory(this.cleanup, backup, path);
                this.preservedBackups.delete(backup);
              } catch {
                /* Keep the original backup and conservative ownership. */
              }
              throw error;
            }
            this.preservedBackups.delete(backup);
            this.stages.add(backup);
            this.directoryStages.add(backup);
            await this.cleanupStage(backup);
          } else await publishStage(this.filesystem, temporary, path, options?.overwrite ?? false);
        } finally {
          // Only this invocation's private stage is removed; nothing is replayed at startup.
          await this.cleanupStage(temporary);
        }
      },
      async () => {
        this.signal.removeEventListener('abort', aborted);
        const closed = input.closed
          ? Promise.resolve()
          : new Promise<void>((resolve) => input.once('close', resolve));
        input.destroy();
        await closed;
        input.off('error', observed);
      },
    );
  }
  append(path: string, input: Readable): Promise<void> {
    const aborted = () => input.destroy(fail('cancelled'));
    input.on('error', observed);
    this.signal.addEventListener('abort', aborted, { once: true });
    return this.run(
      async () => {
        this.validate(path);
        this.writePermission();
        if (!path) throw fail('invalid-input');
        await this.verifyFile(path);
        const opened = await this.filesystem.openWritable(path, {
          writeMode: 'append',
          mutationSymlinks: 'reject',
          mode: 0o600,
        });
        try {
          await this.verifyRoot();
          this.assert();
          const authority = this.grant.authority,
            stat = await opened.handle.stat({ bigint: true });
          if (
            authority.grant.kind !== 'directory' &&
            (authority.fileIdentity ? !same(stat, authority.fileIdentity) : !opened.createdForWrite)
          )
            throw fail('stale');
          if (!stat.isFile() || stat.nlink > 1n) throw fail('forbidden');
          let count = Number(stat.size);
          for await (const chunk of input) {
            this.assert();
            const bytes = Buffer.from(chunk);
            if (bytes.length > 1024 * 1024 || (count += bytes.length) > MAX_BYTES)
              throw fail('capacity');
            let offset = 0;
            while (offset < bytes.length) {
              this.assert();
              const result = await opened.handle.write(bytes, offset, bytes.length - offset);
              if (!result.bytesWritten) throw fail('unavailable');
              offset += result.bytesWritten;
            }
          }
          this.assert();
          await opened.handle.sync();
        } finally {
          await opened[Symbol.asyncDispose]();
        }
      },
      async () => {
        this.signal.removeEventListener('abort', aborted);
        const closed = input.closed
          ? Promise.resolve()
          : new Promise<void>((resolve) => input.once('close', resolve));
        input.destroy();
        await closed;
        input.off('error', observed);
      },
    );
  }
  mkdir(path: string): Promise<void> {
    return this.run(async () => {
      this.validate(path);
      this.writePermission();
      if (!path) throw fail('invalid-input');
      await this.filesystem.mkdir(path, {});
      await applyPinnedMode(
        this.filesystem,
        path,
        0o700,
        await this.filesystem.stat(path),
        () => this.assert(),
        this.verifyRoot,
      );
    });
  }
  chmod(path: string, mode: number): Promise<void> {
    return this.run(async () => {
      this.validate(path);
      this.writePermission();
      if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw fail('invalid-input');
      await this.verifyFile(path);
      await applyPinnedMode(
        this.filesystem,
        path,
        mode,
        await this.filesystem.stat(path),
        () => this.assert(),
        this.verifyRoot,
      );
    });
  }
  setTimes(path: string, times: { modifiedAt: number; accessedAt?: number }): Promise<void> {
    return this.run(async () => {
      this.validate(path);
      this.writePermission();
      const modified = times.modifiedAt;
      const accessed = times.accessedAt ?? modified;
      if (
        ![modified, accessed].every(
          (value) => Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15,
        )
      )
        throw fail('invalid-input');
      await this.verifyFile(path);
      await applyPinnedTimes(
        this.filesystem,
        path,
        modified,
        accessed,
        await this.filesystem.stat(path),
        () => this.assert(),
        this.verifyRoot,
      );
    });
  }
  writeDirectory(
    path: string,
    populate: (files: LocalDirectoryWriter) => Promise<void>,
    options?: { overwrite?: boolean },
  ): Promise<void> {
    return this.run(async () => {
      this.validate(path);
      this.writePermission();
      if (!path || this.grant.authority.grant.kind !== 'directory') throw fail('forbidden');
      const existing = await this.filesystem.stat(path).catch((error: unknown) => {
        const code =
          error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (['ENOENT', 'not-found'].includes(code)) return undefined;
        throw error;
      });
      if (existing && !options?.overwrite) throw fail('conflict');
      const stage = posix.join(posix.dirname(path), `.axterm-${randomUUID()}.extract`);
      const backup = posix.join(posix.dirname(path), `.axterm-${randomUUID()}.backup`);
      this.stages.add(stage);
      this.directoryStages.add(stage);
      const pending = new Set<Promise<unknown>>();
      const inputs = new Set<Readable>();
      const members = new Set<string>();
      let accepting = true;
      let failed = false;
      const scope = new AbortController();
      const signal = AbortSignal.any([this.signal, scope.signal]);
      const stopped = () => {
        for (const input of inputs) input.destroy();
      };
      signal.addEventListener('abort', stopped, { once: true });
      const inside = (relative: string, count = false) => {
        if (!accepting) throw fail('closed');
        try {
          grantedDirectoryPathSchema.parse(relative);
        } catch {
          throw fail('invalid-input');
        }
        if (count && !members.has(relative)) {
          if (members.size >= 19_999) throw fail('capacity');
          members.add(relative);
        }
        return relative ? `${stage}/${relative}` : stage;
      };
      const run = <T>(operation: () => Promise<T>): Promise<T> => {
        if (!accepting) return Promise.reject(fail('closed'));
        if (pending.size >= 32) return Promise.reject(fail('capacity'));
        const task = Promise.resolve().then(() => {
          signal.throwIfAborted();
          return operation();
        });
        pending.add(task);
        void task.then(
          () => pending.delete(task),
          () => {
            failed = true;
            pending.delete(task);
          },
        );
        return task;
      };
      const writer: LocalDirectoryWriter = {
        signal,
        setTimes: (relative, times) => {
          const target = inside(relative);
          return run(() => this.setTimes(target, times));
        },
        mkdir: (relative) => {
          const target = inside(relative, true);
          return run(() => (relative ? this.mkdir(target) : Promise.resolve()));
        },
        chmod: (relative, mode) => {
          const target = inside(relative);
          return run(() => this.chmod(target, mode));
        },
        write: (relative, input, options) => {
          if (!relative) return Promise.reject(fail('invalid-input'));
          const target = inside(relative, true);
          inputs.add(input);
          const task = run(() => this.write(target, input, options));
          return task.finally(() => {
            inputs.delete(input);
            input.destroy();
          });
        },
      };

      try {
        await this.filesystem.mkdir(stage);
        await applyPinnedMode(
          this.filesystem,
          stage,
          0o700,
          await this.filesystem.stat(stage),
          () => this.assert(),
          this.verifyRoot,
        );
        let populationFailed = false;
        let populationError: unknown;
        try {
          await populate(writer);
        } catch (error) {
          populationFailed = true;
          populationError = error;
          scope.abort();
          stopped();
        }
        accepting = false;
        const results = await Promise.allSettled([...pending]);
        if (populationFailed) throw populationError;
        if (failed || results.some((result) => result.status === 'rejected'))
          throw fail(this.signal.aborted ? 'cancelled' : 'unavailable');
        await this.verifyRoot();
        this.assert();
        if (existing) {
          await moveDirectory(this.filesystem, path, backup);
          this.preservedBackups.add(backup);
        }
        try {
          await moveDirectory(this.filesystem, stage, path);
        } catch (error) {
          if (existing) {
            try {
              await moveDirectory(this.cleanup, backup, path);
              this.preservedBackups.delete(backup);
            } catch {
              /* Preserve the original backup and conservative ownership. */
            }
          }
          throw error;
        }
        if (existing) {
          this.stages.add(backup);
          this.directoryStages.add(backup);
          this.preservedBackups.delete(backup);
          await this.cleanupStage(backup);
        }
      } finally {
        accepting = false;
        scope.abort();
        stopped();
        await Promise.allSettled([...pending]);
        signal.removeEventListener('abort', stopped);
        await this.cleanupStage(stage);
      }
    });
  }
  move(from: string, to: string, options?: { overwrite?: boolean }): Promise<void> {
    return this.run(async () => {
      this.validate(from);
      this.validate(to);
      this.writePermission();
      if (!from || !to) throw fail('invalid-input');
      await this.verifyFile(from);
      await this.verifyFile(to);
      await this.filesystem.move(from, to, { overwrite: options?.overwrite ?? false });
    });
  }
  remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.run(async () => {
      this.validate(path);
      this.writePermission();
      if (!path) throw fail('forbidden');
      await this.verifyFile(path);
      await this.filesystem.remove(path, {
        recursive: options?.recursive ?? false,
        ...(options?.recursive ? { maxDepth: 64, maxEntries: 20_000 } : {}),
        signal: this.signal,
      });
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const done = Promise.withResolvers<void>();
    this.closing = done.promise;
    this.signal.removeEventListener('abort', this.aborted);
    clearTimeout(this.expiry);
    this.lifetime.abort();
    const streams = [...this.streams];
    for (const [stream] of streams) stream.destroy();
    void (async () => {
      await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled(streams.map(([, ended]) => ended));
      if (results.some((item) => item.status === 'rejected')) throw fail('unavailable');
      const stages = await Promise.allSettled(
        [...this.stages].map((path) => this.cleanupStage(path)),
      );
      if (stages.some((item) => item.status === 'rejected') || this.preservedBackups.size)
        throw fail('unavailable');
      this.grant.dispose();
      this.released();
    })().then(
      () => done.resolve(),
      (error) => done.reject(error),
    );
    return done.promise;
  }
  private async cleanupStage(path: string): Promise<void> {
    const directory = this.directoryStages.has(path);
    await this.cleanup.remove(path, {
      force: true,
      ...(directory ? { recursive: true, maxDepth: 66, maxEntries: 20_256 } : {}),
    });
    this.stages.delete(path);
    this.directoryStages.delete(path);
  }
  private async metadata(path: string): Promise<Awaited<ReturnType<Root['stat']>>> {
    this.assert();
    return this.filesystem.stat(path);
  }
}
function observed(): void {}
function entry(
  path: string,
  metadata: Awaited<ReturnType<Root['stat']>>,
  rootName = '/',
): GrantedDirectoryEntry {
  return {
    path,
    name: posix.basename(path) || rootName,
    type: metadata.isDirectory
      ? 'directory'
      : metadata.isFile
        ? 'file'
        : metadata.isSymbolicLink
          ? 'symlink'
          : 'other',
    size: metadata.size,
    mode: metadata.mode,
    modifiedAt: new Date(metadata.mtimeMs).toISOString(),
    owner: String(metadata.uid),
    group: String(metadata.gid),
  };
}

async function moveDirectory(filesystem: Root, from: string, to: string): Promise<void> {
  const target = await filesystem.stat(to).catch((error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (['ENOENT', 'not-found'].includes(code)) return undefined;
    throw error;
  });
  if (target) throw fail('conflict');
  // fs-safe's no-replace path supports regular files. Directory moves retain
  // its pinned boundaries and require a name preflight plus native rename.
  await filesystem.move(from, to, { overwrite: true });
}
