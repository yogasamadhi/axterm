import { lstat } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { root } from '@openclaw/fs-safe/root';
import type { FileGrantLease, FileGrants } from '@axterm/plugin-api/host';
import { grantedDirectoryPathSchema } from '@axterm/plugin-api/files';
import { RemoteError } from '@axterm/plugin-api';
import type { FileRenamePort, RenameScope, RenameFile } from '../ports/file-renamer.ts';
const fail = () =>
  new RemoteError('automation/failure', 'File rename authority changed', {
    reason: 'precondition-failed',
  });
function fingerprint(stat: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  birthtimeMs?: number;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.birthtimeMs]))
    .digest('hex');
}
export class GrantedFileRenamer implements FileRenamePort {
  constructor(private readonly grants: () => Pick<FileGrants, 'authorize'>) {}
  async open(grantId: string): Promise<RenameScope> {
    const grants = this.grants();
    const read = await grants.authorize(grantId, 'read');
    let write: FileGrantLease | undefined;
    try {
      write = await grants.authorize(grantId, 'write');
      const owned = write;
      if (
        read.authority.grant.kind !== 'directory' ||
        owned.authority.grant.kind !== 'directory' ||
        read.authority.generation !== owned.authority.generation ||
        read.authority.rootPath !== owned.authority.rootPath ||
        JSON.stringify(read.authority.rootIdentity) !== JSON.stringify(owned.authority.rootIdentity)
      )
        throw fail();
      const signal = AbortSignal.any([read.signal, owned.signal]);
      let closed = false;
      const assert = () => {
        if (closed) throw fail();
        read.assert();
        owned.assert();
        signal.throwIfAborted();
      };
      const verify = async () => {
        assert();
        const stat = await lstat(owned.authority.rootPath, { bigint: true });
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          String(stat.dev) !== owned.authority.rootIdentity.device ||
          String(stat.ino) !== owned.authority.rootIdentity.inode
        )
          throw fail();
        assert();
      };
      await verify();
      const fs = await root(owned.authority.rootPath, {
        symlinks: 'reject',
        hardlinks: 'reject',
        assertBeforeMutation: assert,
      });
      await verify();
      const inspect = async (path: string): Promise<RenameFile> => {
        grantedDirectoryPathSchema.parse(path);
        await verify();
        const stat = await fs.stat(path);
        let timestamp = stat.mtimeMs;
        let version = fingerprint(stat);
        if (stat.isFile) {
          const opened = await fs.open(path, { symlinks: 'reject', hardlinks: 'reject' });
          try {
            const pinned = await opened.handle.stat();
            timestamp = pinned.birthtimeMs || pinned.mtimeMs;
            version = fingerprint(pinned);
          } finally {
            await opened[Symbol.asyncDispose]();
          }
        }
        await verify();
        return {
          path,
          type: stat.isFile
            ? 'file'
            : stat.isDirectory
              ? 'directory'
              : stat.isSymbolicLink
                ? 'symlink'
                : 'other',
          version,
          timestamp,
        };
      };
      return {
        rootName: owned.authority.grant.name,
        identity: createHash('sha256')
          .update(JSON.stringify(owned.authority.rootIdentity))
          .digest('hex'),
        signal,
        inspect,
        list: async (path) => {
          grantedDirectoryPathSchema.parse(path);
          await verify();
          const result: RenameFile[] = [];
          for await (const item of fs.entries(path, {
            maxEntries: 10002,
            order: 'filesystem',
            symlinks: 'reject',
            signal,
          })) {
            if (result.length >= 10000)
              throw new RemoteError('automation/failure', 'Directory is too large', {
                reason: 'capacity',
              });
            result.push({
              path: path ? path + '/' + item.name : item.name,
              type: item.isFile
                ? 'file'
                : item.isDirectory
                  ? 'directory'
                  : item.isSymbolicLink
                    ? 'symlink'
                    : 'other',
              version: '',
              timestamp: item.mtimeMs,
            });
          }
          await verify();
          return result;
        },
        move: async (from, to, expectedVersion) => {
          grantedDirectoryPathSchema.parse(from);
          grantedDirectoryPathSchema.parse(to);
          if (!from || !to) throw fail();
          await verify();
          if ((await inspect(from)).version !== expectedVersion) throw fail();
          await fs.move(from, to, {
            overwrite: false,
            assertBeforeMutation: () => {
              assert();
              const stat = lstatSync(join(owned.authority.rootPath, ...from.split('/')));
              if (
                !stat.isFile() ||
                stat.isSymbolicLink() ||
                stat.nlink !== 1 ||
                fingerprint(stat) !== expectedVersion
              )
                throw fail();
            },
          });
          await verify();
        },
        close: async () => {
          closed = true;
          read.dispose();
          owned.dispose();
        },
      };
    } catch (error) {
      read.dispose();
      write?.dispose();
      throw error;
    }
  }
}
