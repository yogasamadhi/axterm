import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { root, type Root } from '@openclaw/fs-safe/root';
import { RemoteError, remoteErrorOf } from '@axterm/plugin-api';
import {
  grantedDirectoryListingSchema,
  type GrantedDirectoryListing,
  type GrantedEntryCreate,
  type GrantedEntryRename,
  type GrantedEntryChmod,
  type GrantedEntriesOperation,
  type FilesFailureReason,
} from '@axterm/plugin-api/files';
import type { FileGrantLease, FileGrants } from '@axterm/plugin-api/host';
import type { LocalFiles } from '../ports/local-files.ts';
import { applyPinnedMode } from './local-mode.ts';

const MAX_ENTRIES = 10_000;
const MAX_TREE_ENTRIES = 20_000;
const MAX_DEPTH = 64;
const MAX_COPY_BYTES = 16 * 1024 ** 4;
const failure = (reason: FilesFailureReason) =>
  new RemoteError('files/failure', 'The authorized filesystem operation failed', { reason });
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
};
function mapped(error: unknown): RemoteError<'files/failure'> {
  const marked = remoteErrorOf(error);
  if (marked?.code === 'files/failure') return marked as RemoteError<'files/failure'>;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const reasons: Record<string, FilesFailureReason> = {
    ENOENT: 'not-found',
    'not-found': 'not-found',
    EEXIST: 'conflict',
    'already-exists': 'conflict',
    ENOTEMPTY: 'conflict',
    EACCES: 'forbidden',
    EPERM: 'forbidden',
    ELOOP: 'forbidden',
    'outside-workspace': 'forbidden',
    symlink: 'forbidden',
    hardlink: 'forbidden',
    'symlink-disallowed': 'forbidden',
    'hardlink-disallowed': 'forbidden',
    'path-mismatch': 'stale',
    'path-changed': 'stale',
    'too-large': 'capacity',
    ENOSPC: 'capacity',
    EDQUOT: 'capacity',
    EINVAL: 'invalid-input',
    ENOTDIR: 'invalid-input',
    'invalid-path': 'invalid-input',
    'not-file': 'invalid-input',
    'not-empty': 'conflict',
    'not-removable': 'forbidden',
    'denied-path': 'forbidden',
    'device-path': 'forbidden',
    'path-alias': 'forbidden',
    'not-owned': 'forbidden',
    'insecure-permissions': 'forbidden',
    'permission-unverified': 'forbidden',
    timeout: 'cancelled',
  };
  return failure(reasons[code] ?? 'unavailable');
}
interface OpenRoot {
  readonly filesystem: Root;
  readonly lease: FileGrantLease;
  verify(): Promise<void>;
}
/** IO only: no native selection, transport vendor object or business persistence. */
export class GrantedLocalFiles implements LocalFiles {
  constructor(private readonly grants: () => Pick<FileGrants, 'authorize'>) {}
  list(grantId: string, path: string, signal: AbortSignal): Promise<GrantedDirectoryListing> {
    return this.use(grantId, 'read', signal, async (scope) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.listSnapshot(scope, grantId, path);
        } catch (error) {
          // entries() can lose a child between directory enumeration and its own
          // metadata read. Discard that entire snapshot and retry within the same
          // pinned authority; persistent absence and all other failures escape.
          if (attempt >= 2 || mapped(error).details.reason !== 'not-found') throw error;
          await scope.verify();
        }
      }
    });
  }
  private async listSnapshot(
    scope: OpenRoot,
    grantId: string,
    path: string,
  ): Promise<GrantedDirectoryListing> {
    const entries: GrantedDirectoryListing['entries'] = [];
    let truncated = false;
    for await (const entry of scope.filesystem.entries(path, {
      maxEntries: MAX_ENTRIES + 1,
      order: 'filesystem',
      signal: scope.lease.signal,
      symlinks: 'follow-within-root',
    })) {
      scope.lease.assert();
      if (entries.length === MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const entryPath = path ? `${path}/${entry.name}` : entry.name;
      let metadata: Stats;
      try {
        metadata = await this.metadata(scope, entryPath);
      } catch (error) {
        // A directory iterator and lstat cannot form one filesystem snapshot.
        // Ignore only an entry removed between them; keep authority/IO failures.
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          ['ENOENT', 'not-found'].includes(String(error.code))
        )
          continue;
        throw error;
      }
      entries.push({
        name: entry.name,
        path: entryPath,
        type: metadata.isDirectory()
          ? 'directory'
          : metadata.isFile()
            ? 'file'
            : metadata.isSymbolicLink()
              ? 'symlink'
              : 'other',
        size: metadata.size,
        mode: metadata.mode,
        modifiedAt: metadata.mtime.toISOString(),
        accessedAt: metadata.atime.toISOString(),
        owner: String(metadata.uid),
        group: String(metadata.gid),
      });
    }
    entries.sort((left, right) =>
      left.type === 'directory' && right.type !== 'directory'
        ? -1
        : left.type !== 'directory' && right.type === 'directory'
          ? 1
          : left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }),
    );
    return grantedDirectoryListingSchema.parse({
      grantId,
      rootName: scope.lease.authority.grant.name,
      path,
      entries,
      truncated,
    });
  }

  create(grantId: string, input: GrantedEntryCreate, signal: AbortSignal): Promise<number> {
    return this.use(grantId, 'write', signal, async (scope) => {
      const { filesystem } = scope;
      const target = input.path ? `${input.path}/${input.name}` : input.name;
      if (input.type === 'directory') {
        await filesystem.mkdir(target);
        await this.applyMode(scope, target, 0o700);
      } else await filesystem.create(target, '', { mode: 0o600 });
      return 1;
    });
  }
  rename(grantId: string, input: GrantedEntryRename, signal: AbortSignal): Promise<number> {
    return this.use(grantId, 'write', signal, async ({ filesystem }) => {
      const target = posix.join(posix.dirname(input.path), input.name);
      if (target === input.path) throw failure('conflict');
      await filesystem.move(input.path, target, { overwrite: false });
      return 1;
    });
  }
  remove(grantId: string, path: string, signal: AbortSignal): Promise<number> {
    return this.use(grantId, 'write', signal, async (scope) => {
      const metadata = await this.metadata(scope, path);
      await scope.filesystem.remove(path, {
        force: false,
        ...(metadata.isDirectory()
          ? { recursive: true, maxEntries: MAX_TREE_ENTRIES, maxDepth: MAX_DEPTH }
          : {}),
        signal: scope.lease.signal,
      });
      return 1;
    });
  }
  chmod(grantId: string, input: GrantedEntryChmod, signal: AbortSignal): Promise<number> {
    return this.use(grantId, 'write', signal, async (scope) => {
      await this.applyMode(scope, input.path, input.mode);
      return 1;
    });
  }
  operate(grantId: string, input: GrantedEntriesOperation, signal: AbortSignal): Promise<number> {
    return this.use(grantId, 'write', signal, async (scope) => {
      if (input.operation === 'copy' && !scope.lease.authority.grant.permissions.includes('read'))
        throw failure('forbidden');
      const destination = input.destination
        ? await scope.filesystem.resolve(input.destination)
        : scope.filesystem.rootReal;
      if (!(await lstat(destination)).isDirectory()) throw failure('invalid-input');
      const seen = new Set<string>();
      const budget = { remaining: MAX_TREE_ENTRIES, bytes: MAX_COPY_BYTES };
      let changed = 0;
      for (const path of input.paths) {
        scope.lease.assert();
        const canonical = await this.candidate(scope, path);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        const metadata = await this.metadata(scope, path);
        if (metadata.isSymbolicLink()) continue;
        if (metadata.isDirectory() && inside(canonical, destination))
          throw failure('invalid-input');
        let target = posix.join(input.destination, posix.basename(path));
        if (target === path && input.operation === 'move') continue;
        if (await scope.filesystem.exists(target)) {
          if (input.conflict === 'skip') continue;
          if (input.conflict === 'overwrite') {
            if (target === path) throw failure('invalid-input');
            const removed = await this.count(scope, target, budget, 0);
            await scope.filesystem.remove(target, {
              recursive: true,
              force: false,
              maxEntries: removed,
              maxDepth: MAX_DEPTH,
              signal: scope.lease.signal,
            });
          } else {
            const extension = metadata.isDirectory() ? '' : posix.extname(target);
            const stem = extension ? target.slice(0, -extension.length) : target;
            let available = false;
            for (let index = 1; index <= 999; index++) {
              const next = `${stem}(copy-${index})${extension}`;
              if (!(await scope.filesystem.exists(next))) {
                target = next;
                available = true;
                break;
              }
            }
            if (!available) throw failure('conflict');
          }
        }
        if (input.operation === 'move') {
          if (--budget.remaining < 0) throw failure('capacity');
          await scope.filesystem.move(path, target, { overwrite: false });
          changed++;
        } else changed += await this.copy(scope, path, target, budget, 0);
      }
      return changed;
    });
  }
  private async copy(
    scope: OpenRoot,
    source: string,
    target: string,
    budget: { remaining: number; bytes: number },
    depth: number,
  ): Promise<number> {
    scope.lease.assert();
    if (depth > MAX_DEPTH || --budget.remaining < 0) throw failure('capacity');
    const metadata = await this.metadata(scope, source);
    if (metadata.isSymbolicLink()) return 0;
    if (metadata.isFile()) {
      budget.bytes -= metadata.size;
      if (budget.bytes < 0) throw failure('capacity');
      await scope.filesystem.copyIn(
        target,
        { root: scope.filesystem, relativePath: source },
        {
          overwrite: false,
          mode: metadata.mode & 0o7777,
          preserveSourceMode: true,
          maxBytes: Math.max(1, metadata.size),
          signal: scope.lease.signal,
          sourceHardlinks: 'reject',
        },
      );
      return 1;
    }
    if (!metadata.isDirectory()) return 0;
    await scope.filesystem.mkdir(target);
    await this.applyMode(scope, target, metadata.mode & 0o7777);
    let changed = 1;
    for await (const entry of scope.filesystem.entries(source, {
      maxEntries: Math.max(1, budget.remaining + 1),
      order: 'filesystem',
      signal: scope.lease.signal,
      symlinks: 'follow-parents-within-root',
    })) {
      if (entry.isSymbolicLink) continue;
      changed += await this.copy(
        scope,
        `${source}/${entry.name}`,
        `${target}/${entry.name}`,
        budget,
        depth + 1,
      );
    }
    return changed;
  }
  private async candidate(scope: OpenRoot, path: string): Promise<string> {
    const parent = posix.dirname(path);
    const directory =
      parent === '.' ? scope.filesystem.rootReal : await scope.filesystem.resolve(parent);
    return join(directory, posix.basename(path));
  }
  private async applyMode(scope: OpenRoot, path: string, mode: number): Promise<void> {
    const metadata = await this.metadata(scope, path);
    if (metadata.isSymbolicLink() || (metadata.isFile() && metadata.nlink > 1))
      throw failure('forbidden');
    await applyPinnedMode(
      scope.filesystem,
      path,
      mode,
      {
        dev: metadata.dev,
        ino: metadata.ino,
        isFile: metadata.isFile(),
        isSymbolicLink: metadata.isSymbolicLink(),
        nlink: metadata.nlink,
      },
      scope.lease.assert,
      scope.verify,
    );
  }
  private async count(
    scope: OpenRoot,
    path: string,
    budget: { remaining: number },
    depth: number,
  ): Promise<number> {
    scope.lease.assert();
    if (depth > MAX_DEPTH || --budget.remaining < 0) throw failure('capacity');
    const metadata = await this.metadata(scope, path);
    let count = 1;
    if (metadata.isDirectory())
      for await (const entry of scope.filesystem.entries(path, {
        maxEntries: Math.max(1, budget.remaining + 1),
        order: 'filesystem',
        signal: scope.lease.signal,
        symlinks: 'follow-parents-within-root',
      }))
        count += await this.count(scope, `${path}/${entry.name}`, budget, depth + 1);
    return count;
  }
  private async metadata(scope: OpenRoot, path: string): Promise<Stats> {
    scope.lease.assert();
    const candidate = await this.candidate(scope, path);
    const metadata = await lstat(candidate);
    await scope.verify();
    const parent = posix.dirname(path);
    const current =
      parent === '.' ? scope.filesystem.rootReal : await scope.filesystem.resolve(parent);
    if (dirname(candidate) !== current) throw failure('stale');
    scope.lease.assert();
    return metadata;
  }
  private async use<T>(
    grantId: string,
    permission: 'read' | 'write',
    signal: AbortSignal,
    perform: (scope: OpenRoot) => Promise<T>,
  ): Promise<T> {
    let lease: FileGrantLease | undefined;
    try {
      lease = await this.grants().authorize(grantId, permission, signal);
      const owned = lease;
      if (lease.authority.grant.kind !== 'directory') throw failure('invalid-input');
      const verify = async () => {
        owned.assert();
        const metadata = await lstat(owned.authority.rootPath, { bigint: true });
        if (
          !metadata.isDirectory() ||
          metadata.isSymbolicLink() ||
          String(metadata.dev) !== owned.authority.rootIdentity.device ||
          String(metadata.ino) !== owned.authority.rootIdentity.inode
        )
          throw failure('stale');
        owned.assert();
      };
      await verify();
      const filesystem = await root(lease.authority.rootPath, {
        assertBeforeMutation: lease.assert,
        mode: 0o700,
        hardlinks: 'reject',
      });
      const result = await perform({ filesystem, lease, verify });
      await verify();
      return result;
    } catch (error) {
      throw signal.aborted ? failure('cancelled') : mapped(error);
    } finally {
      lease?.dispose();
    }
  }
}
