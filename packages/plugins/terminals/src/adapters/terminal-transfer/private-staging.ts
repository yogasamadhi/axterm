import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import { root, type Root } from '@openclaw/fs-safe/root';
import type { FileGrants, HostFiles, LocalFileLease } from '@axterm/plugin-api/host';
import type { TerminalTransferProtocol } from '../../ports/terminal-transfer.ts';
import type {
  TerminalTransferStage,
  TerminalTransferStaging,
} from '../../ports/terminal-transfer-staging.ts';
import type { TerminalStageStore, StageRecord } from './stage-store.ts';
import safeName from './safe-transfer-name.ts';
const MAX_BYTES = 4 * 1024 ** 3;
const fail = () => Error('TERMINAL_PRIVATE_STAGE_UNAVAILABLE');
interface Owned {
  id: string;
  directory: string;
  device: string;
  inode: string;
  lease: LocalFileLease;
  signal: AbortSignal;
  download: boolean;
  record?: StageRecord;
  published: boolean;
  named?: boolean;
  close?: Promise<void>;
}
/** Protocol engines see private paths. User-file IO remains exclusively in the Files owner. */
export class PrivateTerminalStaging implements TerminalTransferStaging {
  private readonly lifetime = new AbortController();
  private readonly owned = new Set<Owned>();
  private readonly pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly directory: string,
    private readonly files: HostFiles,
    private readonly grants: FileGrants,
    private readonly store: TerminalStageStore,
  ) {
    if (!isAbsolute(directory)) throw fail();
  }
  prepare(
    grantId: string,
    direction: 'upload' | 'download',
    protocol: TerminalTransferProtocol,
    signal: AbortSignal,
  ): Promise<TerminalTransferStage> {
    if (this.closing || this.lifetime.signal.aborted || this.owned.size + this.pending.size >= 4)
      return Promise.reject(fail());
    const task = this.prepareOwned(
      grantId,
      direction,
      protocol,
      AbortSignal.any([signal, this.lifetime.signal]),
    );
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  resourceCount() {
    return this.owned.size + this.pending.size;
  }
  close() {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
      const results = await Promise.allSettled([...this.owned].map((value) => this.release(value)));
      if (results.some((r) => r.status === 'rejected') || this.owned.size) throw fail();
    })());
  }
  review(grantId: string, signal: AbortSignal) {
    return this.trackRecovery((owned) => this.reviewOwned(grantId, owned), signal);
  }
  private async reviewOwned(grantId: string, signal: AbortSignal) {
    const authority = await this.grants.authorize(grantId, 'write', signal);
    try {
      authority.assert();
      const records = this.store.list(this.store.destination(authority.authority));
      return await Promise.all(
        records.map(async (record) => {
          let state: 'verified' | 'absent' | 'unverified' | 'expired' = 'unverified',
            bytes = 0;
          if (Date.now() - record.created_at > 30 * 24 * 60 * 60 * 1000) state = 'expired';
          else
            try {
              const owned = await this.openRecord(record);
              bytes = await this.inspectContents(owned, signal);
              state = 'verified';
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') state = 'absent';
            }
          authority.assert();
          signal.throwIfAborted();
          return {
            id: record.id,
            protocol: record.protocol,
            name: record.name,
            createdAt: record.created_at,
            bytes,
            state,
          };
        }),
      );
    } finally {
      authority.dispose();
    }
  }
  remove(id: string, grantId: string, signal: AbortSignal, forgetOnly = false) {
    return this.trackRecovery((owned) => this.removeOwned(id, grantId, owned, forgetOnly), signal);
  }
  private async removeOwned(id: string, grantId: string, signal: AbortSignal, forgetOnly: boolean) {
    const authority = await this.grants.authorize(grantId, 'write', signal);
    try {
      const record = this.store.get(id);
      authority.assert();
      if (
        !record ||
        record.destination_hash !== this.store.destination(authority.authority) ||
        [...this.owned].some((value) => value.id === id)
      )
        throw fail();
      if (!forgetOnly) {
        if (Date.now() - record.created_at > 30 * 24 * 60 * 60 * 1000) throw fail();
        await this.inspectContents(await this.openRecord(record), signal);
        signal.throwIfAborted();
        authority.assert();
        const parent = await this.parent();
        await parent.remove(id, {
          recursive: true,
          assertBeforeMutation: () => {
            authority.assert();
            signal.throwIfAborted();
            this.assertRecord(record);
          },
        });
      }
      authority.assert();
      this.store.forget(id);
    } finally {
      authority.dispose();
    }
    return this.reviewOwned(grantId, signal);
  }
  private trackRecovery<T>(
    perform: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (this.closing || this.pending.size >= 32) return Promise.reject(fail());
    const owned = AbortSignal.any([signal, this.lifetime.signal]);
    const task = Promise.resolve().then(() => {
      owned.throwIfAborted();
      return perform(owned);
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  /** A recovery claim must account for every entry; aliases may never disappear from review. */
  private async inspectContents(filesystem: Root, signal: AbortSignal): Promise<number> {
    let count = 0,
      bytes = 0;
    const inspect = async (directory: string, depth: number): Promise<void> => {
      if (depth > 64) throw fail();
      for await (const entry of filesystem.entries(directory, {
        symlinks: 'reject',
        maxEntries: 10000,
        signal,
      })) {
        signal.throwIfAborted();
        if (++count > 10000 || entry.isSymbolicLink) throw fail();
        const relative = posix.join(directory, entry.name);
        if (entry.isDirectory) await inspect(relative, depth + 1);
        else {
          if (!entry.isFile || entry.nlink !== 1) throw fail();
          const opened = await filesystem.open(relative);
          try {
            bytes += (await opened.handle.stat()).size;
            if (bytes > MAX_BYTES) throw fail();
          } finally {
            await opened.handle.close();
          }
        }
      }
    };
    await inspect('', 0);
    return bytes;
  }
  private async parent(): Promise<Root> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0) ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())
    )
      throw fail();
    return root(this.directory, { hardlinks: 'reject', symlinks: 'reject', mode: 0o600 });
  }
  private assertRecord(record: Pick<StageRecord, 'id' | 'device' | 'inode'>): void {
    const info = lstatSync(join(this.directory, record.id), { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      String(info.dev) !== record.device ||
      String(info.ino) !== record.inode
    )
      throw fail();
  }
  private async openRecord(record: Pick<StageRecord, 'id' | 'device' | 'inode'>): Promise<Root> {
    if (!/^[a-f0-9-]{36}$/u.test(record.id)) throw fail();
    const parent = await this.parent(),
      path = await parent.resolve(record.id),
      info = await lstat(path, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      String(info.dev) !== record.device ||
      String(info.ino) !== record.inode
    )
      throw fail();
    return root(path, {
      hardlinks: 'reject',
      symlinks: 'reject',
      mode: 0o600,
    });
  }
  private async prepareOwned(
    grantId: string,
    direction: 'upload' | 'download',
    protocol: TerminalTransferProtocol,
    signal: AbortSignal,
  ): Promise<TerminalTransferStage> {
    const download = direction === 'download',
      permission = download ? 'write' : 'read';
    const authority = await this.grants.authorize(grantId, permission, signal);
    let lease: LocalFileLease | undefined, value: Owned | undefined;
    try {
      authority.assert();
      if (authority.authority.grant.kind !== (download ? 'directory' : 'file')) throw fail();
      const destination = download ? this.store.destination(authority.authority) : undefined;
      lease = await this.files.open(grantId, permission, signal);
      signal.throwIfAborted();
      const parent = await this.parent(),
        id = randomUUID();
      await parent.mkdir(id);
      const directory = await parent.resolve(id),
        info = await lstat(directory, { bigint: true });
      value = {
        id,
        directory,
        device: String(info.dev),
        inode: String(info.ino),
        lease,
        signal: AbortSignal.any([lease.signal, signal]),
        download,
        published: false,
      };
      this.owned.add(value);
      const name = download ? 'Terminal download' : safeName(authority.authority.grant.name);
      let size: number | undefined;
      if (download)
        value.record = this.store.create({
          id,
          destination_hash: destination!,
          protocol,
          name,
          device: value.device,
          inode: value.inode,
        });
      else {
        const metadata = await lease.stat(lease.path);
        if (metadata.type !== 'file' || metadata.size > MAX_BYTES) throw fail();
        size = metadata.size;
        const input = await lease.read(lease.path),
          privateRoot = await this.openRecord(value);
        await privateRoot.create(name, input, {
          maxBytes: MAX_BYTES,
          signal: value.signal,
          mode: 0o600,
        });
      }
      value.signal.throwIfAborted();
      const owned = value;
      return {
        signal: owned.signal,
        path: download ? directory : join(directory, name),
        name,
        kind: download ? 'directory' : 'file',
        ...(size !== undefined ? { size } : {}),
        recordName: (candidate) => {
          owned.signal.throwIfAborted();
          if (!owned.download || owned.named || !owned.record) return;
          const name = safeName(candidate);
          this.store.update(owned.id, owned.record.state, name);
          owned.record = { ...owned.record, name };
          owned.named = true;
        },
        publish: () => this.publish(owned),
        close: () => this.release(owned),
      };
    } catch (error) {
      if (value) await this.release(value);
      else await lease?.close();
      throw error;
    } finally {
      authority.dispose();
    }
  }
  private async publish(value: Owned) {
    if (!value.download || value.published) return;
    value.signal.throwIfAborted();
    const filesystem = await this.openRecord(value);
    this.store.update(value.id, 'ready');
    let bytes = 0,
      files = 0;
    // Validate the entire bounded tree before publishing any destination name.
    const entries = [];
    for await (const entry of filesystem.walk('', {
      maxDepth: 64,
      maxEntries: 10000,
      symlinkPolicy: 'skip',
      limitBehavior: 'throw',
      signal: value.signal,
    })) {
      if (entry.kind !== 'directory' && entry.kind !== 'file') throw fail();
      if (entry.kind === 'file') {
        bytes += entry.size;
        files++;
        if (bytes > MAX_BYTES || files > 100) throw fail();
      }
      entries.push(entry);
    }
    this.store.update(value.id, 'publishing');
    for (const entry of entries) {
      value.signal.throwIfAborted();
      if (!entry.relativePath) continue;
      if (entry.kind === 'directory') {
        try {
          await value.lease.mkdir(entry.relativePath);
        } catch {
          const existing = await value.lease.stat(entry.relativePath);
          if (existing.type !== 'directory') throw fail();
        }
      } else {
        const opened = await filesystem.open(entry.relativePath);
        try {
          await value.lease.write(
            entry.relativePath,
            opened.handle.createReadStream({ autoClose: false }),
            { overwrite: false },
          );
        } finally {
          await opened.handle.close();
        }
      }
    }
    value.signal.throwIfAborted();
    value.published = true;
  }
  private release(value: Owned) {
    return (value.close ??= (async () => {
      // Protocol owner must join its engines before calling close; no engine retains this directory.
      await value.lease.close();
      if (value.download && !value.published && value.record) {
        this.store.update(value.id, 'failed');
        this.owned.delete(value);
        return;
      }
      await this.openRecord(value);
      const parent = await this.parent();
      await parent.remove(value.id, {
        recursive: true,
        assertBeforeMutation: () => this.assertRecord(value),
      });
      if (value.record) this.store.forget(value.id);
      this.owned.delete(value);
    })());
  }
}
