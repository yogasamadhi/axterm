import { mkdtemp, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { NativeFileGrantRegistry } from '@axterm/infra-desktop-native';
import { RemoteError } from '@axterm/plugin-api';
import { MAX_FILE_COMPARISON_BYTES } from '@axterm/plugin-api/files';
import type { FileGrants, HostFiles, LocalFileLease } from '@axterm/plugin-api/host';
import { GrantedStreamingFiles } from '../../packages/plugins/files/src/adapters/streaming-files.ts';
import { FileComparisonApplication } from '../../packages/plugins/files/src/application/comparison.ts';
import { RemoteFileService } from '../../packages/plugins/files/src/application/remote-file-service.ts';
import type { RemoteFileApplication } from '../../packages/plugins/files/src/application/remote-files.ts';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-comparison-'));
  const registry = new NativeFileGrantRegistry(crypto.randomUUID());
  const local = new GrantedStreamingFiles(
    () =>
      ({
        authorize: async (id, permission, signal) => {
          const authority = await registry.authorize(id, permission, signal);
          const abort = new AbortController(),
            lifetime = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]);
          return {
            authority,
            signal: lifetime,
            assert: () => {
              if (lifetime.aborted)
                throw new RemoteError('files/failure', 'RETIRED', { reason: 'cancelled' });
            },
            dispose: () => abort.abort(),
          };
        },
      }) satisfies Pick<FileGrants, 'authorize'>,
  );
  const remote = { readForComparison: vi.fn() } as Pick<RemoteFileApplication, 'readForComparison'>;
  const app = new FileComparisonApplication(local, remote);
  const grant = await registry.createTrustedPath(directory, 'directory', ['read']);
  const source = (path: string) => ({ scope: 'local' as const, grantId: grant.grantId, path });
  return {
    directory,
    registry,
    local,
    app,
    remote,
    source,
    close: async () => {
      await app.close();
      await local.close();
      registry.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
it('compares through actual pinned grant leases and returns bounded metadata/text without native paths', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'a.txt'), 'one\r\ntwo');
    await writeFile(join(f.directory, 'b.txt'), 'one\r\ntwo');
    const equal = await f.app.compare(
      { left: f.source('a.txt'), right: f.source('b.txt') },
      new AbortController().signal,
    );
    expect(equal).toMatchObject({
      status: 'equal',
      left: { name: 'a.txt', path: 'a.txt', lineCount: 2 },
    });
    expect(equal.left.content).toBeUndefined();
    await writeFile(join(f.directory, 'b.txt'), 'different');
    const different = await f.app.compare(
      { left: f.source('a.txt'), right: f.source('b.txt') },
      new AbortController().signal,
    );
    expect(different).toMatchObject({
      status: 'different',
      left: { content: 'one\r\ntwo' },
      right: { content: 'different' },
    });
    expect(JSON.stringify(different)).not.toContain(f.directory);
    expect(f.local.resourceCount()).toBe(0);
    const file = await f.registry.createTrustedPath(join(f.directory, 'a.txt'), 'file', ['read']);
    expect(
      await f.app.compare(
        { left: { scope: 'local', grantId: file.grantId, path: '' }, right: f.source('a.txt') },
        new AbortController().signal,
      ),
    ).toMatchObject({ status: 'equal', left: { path: 'a.txt' } });
  } finally {
    await f.close();
  }
});
it('rejects binary/invalid UTF-8, directories, too many lines and too many bytes without publishing bodies', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'a.txt'), 'text');
    for (const [name, bytes, status, reason] of [
      ['image.png', Buffer.from('text'), 'unsupported', 'binary'],
      [
        'zero.txt',
        Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]),
        'unsupported',
        'binary',
      ],
      ['invalid.txt', Buffer.from([0xff]), 'unsupported', 'binary'],
      ['lines.txt', Buffer.from('line\n'.repeat(10001)), 'too-large', 'too-many-lines'],
      [
        'large.txt',
        Buffer.alloc(MAX_FILE_COMPARISON_BYTES + 1, 0x61),
        'too-large',
        'too-many-bytes',
      ],
    ] as const) {
      await writeFile(join(f.directory, name), bytes);
      const result = await f.app.compare(
        { left: f.source('a.txt'), right: f.source(name) },
        new AbortController().signal,
      );
      expect(result).toMatchObject({ status, reason });
      expect(result.left.content).toBeUndefined();
      expect(result.right.content).toBeUndefined();
    }
    expect(
      await f.app.compare(
        { left: f.source('a.txt'), right: f.source('') },
        new AbortController().signal,
      ),
    ).toMatchObject({ status: 'unsupported', reason: 'directory' });
    expect(f.local.resourceCount()).toBe(0);
  } finally {
    await f.close();
  }
});
it('preserves local path isolation and rejects actual symbolic and hard links', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'a.txt'), 'text');
    await symlink(join(f.directory, 'a.txt'), join(f.directory, 'soft.txt'));
    await link(join(f.directory, 'a.txt'), join(f.directory, 'hard.txt'));
    for (const name of ['soft.txt', 'hard.txt'])
      await expect(
        f.app.compare(
          { left: f.source(name), right: f.source('hard.txt') },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: 'files/failure' });
    expect(() =>
      f.app.compare(
        { left: f.source('../outside'), right: f.source('a.txt') },
        new AbortController().signal,
      ),
    ).toThrow();
    expect(f.local.resourceCount()).toBe(0);
  } finally {
    await f.close();
  }
});
it('bounds four concurrent comparisons and joins canceled reads and their late lease cleanup', async () => {
  const streams: PassThrough[] = [],
    releases: (() => void)[] = [];
  const local = {
    open: async (_id: string, _permission: unknown, signal?: AbortSignal) =>
      ({
        path: 'x.txt',
        signal: signal!,
        stat: async () => ({ name: 'x.txt', path: 'x.txt', type: 'file' as const, size: 1 }),
        read: async () => {
          const stream = new PassThrough();
          streams.push(stream);
          signal?.addEventListener('abort', () => stream.destroy(new Error('canceled')), {
            once: true,
          });
          return stream;
        },
        close: () => new Promise<void>((resolve) => releases.push(resolve)),
      }) as unknown as LocalFileLease,
  } satisfies HostFiles;
  const app = new FileComparisonApplication(local, { readForComparison: vi.fn() });
  const source = { scope: 'local' as const, grantId: 'owned', path: 'x.txt' };
  const tasks = Array.from({ length: 4 }, () =>
    app.compare({ left: source, right: source }, new AbortController().signal),
  );
  tasks.forEach((task) => void task.catch(() => {}));
  await vi.waitFor(() => expect(streams).toHaveLength(8));
  await expect(
    app.compare({ left: source, right: source }, new AbortController().signal),
  ).rejects.toMatchObject({ details: { reason: 'capacity' } });
  let closed = false;
  const closing = app.close().then(() => {
    closed = true;
  });
  await vi.waitFor(() => expect(releases).toHaveLength(8));
  expect(closed).toBe(false);
  releases.forEach((release) => release());
  await closing;
  expect((await Promise.allSettled(tasks)).every((value) => value.status === 'rejected')).toBe(
    true,
  );
  await expect(
    app.compare({ left: source, right: source }, new AbortController().signal),
  ).rejects.toMatchObject({ details: { reason: 'closed' } });
});
it('cancels and joins the other candidate after a read fails', async () => {
  let drained = false;
  const local = {
    open: async (id: string, _permission: unknown, signal?: AbortSignal) => {
      if (id === 'missing')
        throw new RemoteError('files/failure', 'MISSING', { reason: 'not-found' });
      return new Promise<LocalFileLease>((_resolve, reject) => {
        const abort = () => {
          drained = true;
          reject(new Error('cancelled'));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    },
  } satisfies HostFiles;
  const app = new FileComparisonApplication(local, { readForComparison: vi.fn() });
  await expect(
    app.compare(
      {
        left: { scope: 'local', grantId: 'missing', path: 'a' },
        right: { scope: 'local', grantId: 'pending', path: 'b' },
      },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ details: { reason: 'not-found' } });
  expect(drained).toBe(true);
  await app.close();
});
it('reads remote zero-stat files, reports bounded growth and closes the protocol lease', async () => {
  let closes = 0;
  let bytes = Buffer.from('late bytes');
  const metadata = {
    size: 0,
    mode: 0o100644,
    mtime: 1,
    atime: 1,
    uid: 0,
    gid: 0,
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
  };
  const service = new RemoteFileService({
    openFiles: async () =>
      ({
        filesystem: { stat: async () => metadata, readStream: () => Readable.from([bytes]) },
        close: async () => {
          closes++;
        },
      }) as never,
  });
  const target = { protocol: 'sftp' as const, connectionId: crypto.randomUUID() };
  expect(await service.readForComparison(target, '/file.txt', 32)).toMatchObject({
    bytes: Buffer.from('late bytes'),
  });
  bytes = Buffer.alloc(64, 0x61);
  expect(await service.readForComparison(target, '/file.txt', 32)).toMatchObject({
    entry: { size: 33 },
  });
  expect(closes).toBe(2);
});

it('retains authorized local versus remote contents and suppresses both bodies when their bytes are equal', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'local.txt'), 'alpha\nlocal\n');
    const target = { protocol: 'sftp' as const, connectionId: crypto.randomUUID() };
    const right = { scope: 'remote' as const, target, path: '/remote.txt' };
    vi.mocked(f.remote.readForComparison).mockResolvedValue({
      entry: {
        name: 'remote.txt',
        path: '/remote.txt',
        type: 'file',
        size: 13,
        mode: 0o100644,
        revision: 'revision',
      },
      bytes: Buffer.from('alpha\nremote\n'),
    });
    const input = { left: f.source('local.txt'), right };
    expect(await f.app.compare(input, new AbortController().signal)).toMatchObject({
      status: 'different',
      left: { scope: 'local', name: 'local.txt', content: 'alpha\nlocal\n' },
      right: { scope: 'remote', name: 'remote.txt', content: 'alpha\nremote\n' },
    });
    expect(f.remote.readForComparison).toHaveBeenCalledWith(
      target,
      '/remote.txt',
      MAX_FILE_COMPARISON_BYTES,
      expect.any(AbortSignal),
    );
    await writeFile(join(f.directory, 'local.txt'), 'same\r\n');
    vi.mocked(f.remote.readForComparison).mockResolvedValue({
      entry: {
        name: 'remote.txt',
        path: '/remote.txt',
        type: 'file',
        size: 6,
        mode: 0o100644,
        revision: 'same',
      },
      bytes: Buffer.from('same\r\n'),
    });
    const equal = await f.app.compare(input, new AbortController().signal);
    expect(equal.status).toBe('equal');
    expect(equal.left.content).toBeUndefined();
    expect(equal.right.content).toBeUndefined();
  } finally {
    await f.close();
  }
});
