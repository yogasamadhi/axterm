import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { NativeFileGrantRegistry } from '@axterm/infra-desktop-native';
import type { RemoteFilesystem } from '@axterm/plugin-api/host';
import { GrantedStreamingFiles } from '../../packages/plugins/files/src/adapters/streaming-files.ts';
import { NativeArchiveStaging } from '../../packages/plugins/transfers/src/adapters/archive-staging.ts';
import { ArchiveTransferWorkflow } from '../../packages/plugins/transfers/src/application/archive-workflow.ts';

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const execute = promisify(execFile);

it.skipIf(process.platform === 'win32')(
  'round trips compressed directories with actual tar execution and preserves existing targets on command failure',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'axterm-archive-workflow-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const selected = join(home, 'selected');
    const remoteRoot = join(home, 'remote');
    await mkdir(selected);
    await mkdir(remoteRoot);
    const registry = new NativeFileGrantRegistry(randomUUID());
    cleanups.push(() => registry.close());
    const grant = await registry.createTrustedPath(selected, 'directory', ['read', 'write']);
    const files = new GrantedStreamingFiles(() => ({
      authorize: async (id, permission, signal) => ({
        authority: await registry.authorize(id, permission, signal),
        signal: signal ?? new AbortController().signal,
        assert: () => signal?.throwIfAborted(),
        dispose: () => {},
      }),
    }));
    cleanups.push(() => files.close());
    const workflow = new ArchiveTransferWorkflow(new NativeArchiveStaging());
    cleanups.push(() => workflow.close());
    const metadata = async (path: string) => {
      const value = await lstat(path);
      return {
        size: value.size,
        mode: value.mode,
        atime: value.atimeMs / 1000,
        mtime: value.mtimeMs / 1000,
        uid: value.uid,
        gid: value.gid,
        isFile: value.isFile(),
        isDirectory: value.isDirectory(),
        isSymbolicLink: value.isSymbolicLink(),
      };
    };
    const remote: RemoteFilesystem = {
      realpath: async () => remoteRoot,
      stat: metadata,
      lstat: metadata,
      list: async (path) =>
        Promise.all(
          (await readdir(path)).map(async (filename) => ({
            filename,
            attrs: await metadata(join(path, filename)),
          })),
        ),
      mkdir: async (path) => {
        await mkdir(path);
      },
      rename,
      replace: rename,
      unlink,
      rmdir,
      chmod,
      readStream: (path) => createReadStream(path),
      writeStream: (path, options) => createWriteStream(path, options),
      close: async () => {},
    };
    const folder = "quoted ' source";
    await mkdir(join(selected, folder));
    await writeFile(join(selected, folder, 'file.txt'), 'compressed round trip bytes');
    const local = await files.open(grant.grantId, 'read');
    cleanups.push(() => local.close());
    const destination = join(remoteRoot, "remote ' destination");
    const input = {
      direction: 'upload' as const,
      local,
      localPath: folder,
      remote,
      remotePath: destination,
      signal: new AbortController().signal,
      progress: () => new PassThrough(),
      setTotal: () => {},
      conflict: async () => 'overwrite' as const,
      exec: async (command: string) => {
        const result = await execute('/bin/sh', ['-c', command], { maxBuffer: 8192 });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
      },
    };
    await workflow.transfer(input);
    expect(await readFile(join(destination, 'file.txt'), 'utf8')).toBe(
      'compressed round trip bytes',
    );
    const destinationLease = await files.open(grant.grantId, 'write');
    cleanups.push(() => destinationLease.close());
    await workflow.transfer({
      ...input,
      local: destinationLease,
      direction: 'download',
      localPath: 'downloaded',
    });
    expect(await readFile(join(selected, 'downloaded/file.txt'), 'utf8')).toBe(
      'compressed round trip bytes',
    );
    await expect(
      workflow.transfer({
        ...input,
        exec: async () => ({ stdout: '', stderr: '', exitCode: 127 }),
      }),
    ).rejects.toThrow('does not provide tar');
    expect(await readFile(join(destination, 'file.txt'), 'utf8')).toBe(
      'compressed round trip bytes',
    );
    expect(await readdir(remoteRoot)).toEqual(["remote ' destination"]);
    expect(workflow.resourceCount()).toBe(0);
  },
);
