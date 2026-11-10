import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ArchiveTransfers, ArchiveStaging } from '../ports/archive.ts';
import { ApplicationError } from './errors.ts';
import type { RemoteFilesystem } from '@axterm/plugin-api/host';
type Input = Parameters<ArchiveTransfers['transfer']>[0];
/** Compressed transfer intent delegates native archive IO to private staging and selected file owners. */
export class ArchiveTransferWorkflow implements ArchiveTransfers {
  private cleanupFailed = false;
  constructor(private readonly staging: ArchiveStaging) {}
  resourceCount(): number {
    return this.staging.resourceCount() + (this.cleanupFailed ? 1 : 0);
  }
  async close(): Promise<void> {
    await this.staging.close();
    if (this.cleanupFailed)
      throw new ApplicationError('TRANSFER_FAILED', 'Archive cleanup requires recovery');
  }
  transfer(input: Input): Promise<void> {
    return input.direction === 'upload' ? this.upload(input) : this.download(input);
  }
  private async upload(input: Input): Promise<void> {
    const archive = await this.staging.pack(input.local, input.localPath, input.signal);
    let remoteArchive = '';
    let remoteStage = '';
    await finish(
      async () => {
        const root = await input.local.stat(input.localPath);
        const name = root.name;
        const target = await this.target(input, input.remotePath, () =>
          input.remote.lstat(input.remotePath),
        );
        if (!target) return;
        const id = randomUUID();
        remoteArchive = posix.join(posix.dirname(target.path), `.axterm-${id}.tar`);
        remoteStage = posix.join(posix.dirname(target.path), `.axterm-${id}.extract`);
        await input.remote.mkdir(remoteStage);
        input.setTotal(archive.size);
        await pipeline(
          archive.read(),
          input.progress(),
          input.remote.writeStream(remoteArchive, { flags: 'wx', mode: 0o600 }),
          { signal: input.signal },
        );
        await execute(
          input,
          `command -v tar >/dev/null 2>&1 || exit 127; tar -xf ${quote(remoteArchive)} -C ${quote(remoteStage)}`,
        );
        input.signal.throwIfAborted();
        await commitDirectory(
          input.remote,
          posix.join(remoteStage, name),
          target.path,
          target.replace,
          () => {
            this.cleanupFailed = true;
          },
        );
        await input.remote.rmdir(remoteStage);
        remoteStage = '';
      },
      async () => {
        const cleanup = await Promise.allSettled([
          remoteArchive ? maybe(() => input.remote.unlink(remoteArchive)) : Promise.resolve(),
          remoteStage ? removeTree(input.remote, remoteStage) : Promise.resolve(),
          archive.close(),
        ]);
        if (cleanup.some((result) => result.status === 'rejected')) {
          this.cleanupFailed = true;
          throw new ApplicationError('TRANSFER_FAILED', 'Archive staging did not drain');
        }
      },
    );
  }
  private async download(input: Input): Promise<void> {
    const metadata = await input.remote.lstat(input.remotePath);
    const name = posix.basename(input.remotePath);
    if (
      !metadata.isDirectory ||
      metadata.isSymbolicLink ||
      !name ||
      input.remotePath === '/' ||
      !input.localPath
    )
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'Compressed download requires a relative directory destination',
        400,
      );
    const target = await this.target(input, input.localPath, () =>
      input.local.stat(input.localPath),
    );
    if (!target) return;
    const archive = `/tmp/.axterm-${randomUUID()}.tar`;
    await finish(
      async () => {
        await execute(
          input,
          `umask 077; command -v tar >/dev/null 2>&1 || exit 127; COPYFILE_DISABLE=1 tar -C ${quote(posix.dirname(input.remotePath))} -cf ${quote(archive)} ${quote('./' + name)}`,
        );
        input.signal.throwIfAborted();
        input.setTotal((await input.remote.stat(archive)).size);
        const source = input.remote.readStream(archive);
        const progress = input.progress();
        const transfer = pipeline(source, progress, { signal: input.signal });
        void transfer.catch(() => {});
        let extracted: Awaited<ReturnType<ArchiveStaging['unpack']>> | undefined;
        try {
          extracted = await this.staging.unpack(progress, name, input.signal);
          await transfer;
          input.signal.throwIfAborted();
          await input.local.writeDirectory(
            target.path,
            (writer) => extracted!.publish(writer, input.signal),
            { overwrite: target.replace },
          );
        } finally {
          source.destroy();
          progress.destroy();
          await transfer.catch(() => {});
          await extracted?.close();
        }
      },
      async () => {
        try {
          await maybe(() => input.remote.unlink(archive));
        } catch (error) {
          this.cleanupFailed = true;
          throw error;
        }
      },
    );
  }
  private async target(
    input: Input,
    path: string,
    stat: () => Promise<unknown>,
  ): Promise<{ path: string; replace: boolean } | undefined> {
    if (!(await maybe(stat))) return { path, replace: false };
    const strategy = await input.conflict(path, 'directory');
    if (strategy === 'skip') return undefined;
    if (strategy === 'overwrite') return { path, replace: true };
    for (let index = 1; index <= 999; index++) {
      const target = `${path}.copy-${index}`;
      const exists =
        input.direction === 'upload'
          ? () => input.remote.lstat(target)
          : () => input.local.stat(target);
      if (!(await maybe<unknown>(exists))) return { path: target, replace: false };
    }
    throw new ApplicationError('TRANSFER_FAILED', 'No archive destination name is available');
  }
}
function quote(path: string): string {
  return `'${path.replace(/'/g, `'"'"'`)}'`;
}
async function execute(input: Input, command: string): Promise<void> {
  const result = await input.exec(command);
  if (result.exitCode === 0) return;
  if (result.exitCode === 127)
    throw new ApplicationError(
      'CAPABILITY_UNAVAILABLE',
      'The remote host does not provide tar',
      503,
    );
  throw new ApplicationError('TRANSFER_FAILED', 'Remote archive command failed');
}
async function maybe<T>(perform: () => Promise<T>): Promise<T | undefined> {
  try {
    return await perform();
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const details =
      error && typeof error === 'object' && 'details' in error ? error.details : undefined;
    if (
      ['2', 'ENOENT', 'NOT_FOUND'].includes(code) ||
      (details &&
        typeof details === 'object' &&
        'reason' in details &&
        details.reason === 'not-found')
    )
      return undefined;
    throw error;
  }
}
async function commitDirectory(
  files: RemoteFilesystem,
  source: string,
  target: string,
  replace: boolean,
  failed: () => void,
): Promise<void> {
  if (!replace) {
    await files.rename(source, target);
    return;
  }
  const backup = posix.join(posix.dirname(target), `.axterm-${randomUUID()}.backup`);
  await files.rename(target, backup);
  try {
    await files.rename(source, target);
  } catch (error) {
    try {
      await files.rename(backup, target);
    } catch {
      failed();
    }
    throw error;
  }
  try {
    await removeTree(files, backup);
  } catch (error) {
    failed();
    throw error;
  }
}
async function removeTree(
  files: RemoteFilesystem,
  path: string,
  budget = { count: 0 },
  depth = 0,
): Promise<void> {
  if (++budget.count > 20_000 || depth > 64)
    throw new ApplicationError('CAPACITY_EXCEEDED', 'Archive cleanup limit exceeded', 503);
  const metadata = await maybe(() => files.lstat(path));
  if (!metadata) return;
  if (!metadata.isDirectory || metadata.isSymbolicLink) {
    await files.unlink(path);
    return;
  }
  for (const entry of await files.list(path)) {
    if (entry.filename === '.' || entry.filename === '..') continue;
    if (!entry.filename || /[\\/\0]/.test(entry.filename))
      throw new ApplicationError('VALIDATION_ERROR', 'Invalid archive cleanup member', 400);
    await removeTree(files, posix.join(path, entry.filename), budget, depth + 1);
  }
  await files.rmdir(path);
}

async function finish<T>(perform: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let failed = false;
  let failure: unknown;
  let value: T | undefined;
  try {
    value = await perform();
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await cleanup();
  } catch (error) {
    if (failed)
      throw new AggregateError([failure, error], 'Archive operation and cleanup failed', {
        cause: error,
      });
    throw error;
  }
  if (failed) throw failure;
  return value as T;
}
