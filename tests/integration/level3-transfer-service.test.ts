import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { transferFixture as fixture } from '../fixtures/level3-transfers.ts';
it('uploads and downloads through owned grants/channels and returns the same command after failure or completion', async () => {
  const f = await fixture({ '/remote.txt': 'download bytes' });
  await writeFile(join(f.directory, 'source.txt'), 'upload bytes');
  const request = {
    target: f.target,
    direction: 'upload' as const,
    grantId: f.grant.grantId,
    localPath: 'source.txt',
    remotePath: '/uploaded.txt',
  };
  const key = randomUUID();
  const created = f.service.create(request, key);
  expect(f.service.create(request, key).id).toBe(created.id);
  await vi.waitFor(() => expect(f.service.get(created.id).state).toBe('succeeded'));
  expect(f.remote.files.get('/uploaded.txt')?.toString()).toBe('upload bytes');
  expect(f.service.create(request, key).id).toBe(created.id);
  const downloaded = f.service.create(
    { ...request, direction: 'download', localPath: 'downloaded.txt', remotePath: '/remote.txt' },
    randomUUID(),
  );
  await vi.waitFor(() => expect(f.service.get(downloaded.id).state).toBe('succeeded'));
  expect(await readFile(join(f.directory, 'downloaded.txt'), 'utf8')).toBe('download bytes');
  const missing = f.service.create({ ...request, localPath: 'missing' }, randomUUID());
  await vi.waitFor(() => expect(f.service.get(missing.id).state).toBe('failed'));
  expect(f.service.get(missing.id).retryAvailability).toBe('available');
  expect(f.remote.counts().active).toBe(0);
  expect(f.local.resourceCount()).toBe(0);
});
it('retains recursive directory behavior, conflict ask/skip and complete replacement without reopening stale IO nonces', async () => {
  const f = await fixture({ '/target/file.txt': 'original' });
  await mkdir(join(f.directory, 'folder'));
  await writeFile(join(f.directory, 'folder/file.txt'), 'new bytes');
  const created = f.service.create(
    {
      target: f.target,
      direction: 'upload',
      grantId: f.grant.grantId,
      localPath: 'folder',
      remotePath: '/target',
      recursive: true,
      conflict: 'ask',
    },
    randomUUID(),
  );
  await vi.waitFor(() => expect(f.service.get(created.id).state).toBe('awaiting-decision'));
  f.service.decideConflict(created.id, { strategy: 'overwrite', applyToAll: true });
  await vi.waitFor(() => expect(f.service.get(created.id).state).toBe('succeeded'));
  expect(f.remote.files.get('/target/file.txt')?.toString()).toBe('new bytes');
  const skipped = f.service.create(
    {
      target: f.target,
      direction: 'download',
      grantId: f.grant.grantId,
      localPath: 'folder/file.txt',
      remotePath: '/target/file.txt',
      conflict: 'skip',
    },
    randomUUID(),
  );
  await vi.waitFor(() => expect(f.service.get(skipped.id).state).toBe('succeeded'));
  expect(f.service.get(skipped.id).bytesTransferred).toBe(0);
});
it('copies remote bytes over independent source/destination leases and rejects a self-descendant copy', async () => {
  const f = await fixture({ '/source.txt': 'remote copy bytes' });
  const copied = f.service.create(
    {
      direction: 'remote-copy',
      source: f.target,
      target: { protocol: 'ftp', connectionId: randomUUID() },
      sourcePath: '/source.txt',
      targetPath: '/copied.txt',
    },
    randomUUID(),
  );
  await vi.waitFor(() => expect(f.service.get(copied.id).state).toBe('succeeded'));
  expect(f.remote.files.get('/copied.txt')?.toString()).toBe('remote copy bytes');
  expect(f.remote.counts()).toMatchObject({ active: 0, opened: 4, closed: 4 });
  const rejected = f.service.create(
    {
      direction: 'remote-copy',
      source: f.target,
      target: f.target,
      sourcePath: '/folder',
      targetPath: '/folder/inside',
      recursive: true,
    },
    randomUUID(),
  );
  await vi.waitFor(() =>
    expect(f.service.get(rejected.id)).toMatchObject({
      state: 'failed',
      errorCode: 'VALIDATION_ERROR',
    }),
  );
});
it('cancels and drains a paused transfer and all queued IO during unload', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'source'), Buffer.alloc(256 * 1024, 0x6b));
  const writes: ((error?: Error | null) => void)[] = [];
  f.remote.delay((_bytes, done) => writes.push(done));
  const created = f.service.create(
    {
      target: f.target,
      direction: 'upload',
      grantId: f.grant.grantId,
      localPath: 'source',
      remotePath: '/target',
    },
    randomUUID(),
  );
  await vi.waitFor(() => expect(writes.length).toBe(1));
  f.service.pause(created.id);
  expect(f.service.get(created.id).state).toBe('paused');
  const closing = f.service.closeAll();
  for (const done of writes.splice(0)) done();
  await closing;
  expect(f.service.get(created.id).state).toBe('canceled');
  expect(f.remote.counts().active).toBe(0);
  expect(f.local.resourceCount()).toBe(0);
  expect(() =>
    f.service.create(
      {
        target: f.target,
        direction: 'upload',
        grantId: f.grant.grantId,
        localPath: 'source',
        remotePath: '/target',
      },
      randomUUID(),
    ),
  ).toThrow('closing');
});

it('preserves directory destinations until replacement bytes have drained, including failed upload/download', async () => {
  const f = await fixture({
    '/target/original': 'remote original',
    '/source': 'downloaded replacement',
  });
  await writeFile(join(f.directory, 'source'), 'uploaded replacement');
  await mkdir(join(f.directory, 'target'));
  await writeFile(join(f.directory, 'target/original'), 'local original');
  f.remote.delay((_bytes, done) => done(new Error('controlled upload failure')));
  const request = {
    target: f.target,
    direction: 'upload' as const,
    grantId: f.grant.grantId,
    localPath: 'source',
    remotePath: '/target',
    conflict: 'overwrite' as const,
  };
  const failedUpload = f.service.create(request, randomUUID());
  await vi.waitFor(() => expect(f.service.get(failedUpload.id).state).toBe('failed'));
  expect(f.remote.files.get('/target/original')?.toString()).toBe('remote original');
  f.remote.delay(undefined);
  const successfulUpload = f.service.create(request, randomUUID());
  await vi.waitFor(() => expect(f.service.get(successfulUpload.id).state).toBe('succeeded'));
  expect(f.remote.files.get('/target')?.toString()).toBe('uploaded replacement');
  const read = f.remote.native.readStream;
  f.remote.native.readStream = () =>
    new Readable({
      read() {
        this.destroy(new Error('controlled download failure'));
      },
    });
  const download = {
    ...request,
    direction: 'download' as const,
    localPath: 'target',
    remotePath: '/source',
  };
  const failedDownload = f.service.create(download, randomUUID());
  await vi.waitFor(() => expect(f.service.get(failedDownload.id).state).toBe('failed'));
  expect(await readFile(join(f.directory, 'target/original'), 'utf8')).toBe('local original');
  f.remote.native.readStream = read;
  const successfulDownload = f.service.create(download, randomUUID());
  await vi.waitFor(() => expect(f.service.get(successfulDownload.id).state).toBe('succeeded'));
  expect(await readFile(join(f.directory, 'target'), 'utf8')).toBe('downloaded replacement');
});

it('restores a replaced file when a recursive directory transfer fails and publishes it only after successful streaming', async () => {
  const f = await fixture({ '/target': 'remote original', '/source/file': 'remote tree' });
  await mkdir(join(f.directory, 'source'));
  await writeFile(join(f.directory, 'source/file'), 'local tree');
  await writeFile(join(f.directory, 'target'), 'local original');
  const input = {
    target: f.target,
    direction: 'upload' as const,
    grantId: f.grant.grantId,
    localPath: 'source',
    remotePath: '/target',
    recursive: true,
    conflict: 'overwrite' as const,
  };
  f.remote.delay((_bytes, done) => done(new Error('controlled recursive upload failure')));
  const failedUpload = f.service.create(input, randomUUID());
  await vi.waitFor(() => expect(f.service.get(failedUpload.id).state).toBe('failed'));
  expect(f.remote.files.get('/target')?.toString()).toBe('remote original');
  expect(f.remote.directories.has('/target')).toBe(false);
  f.remote.delay(undefined);
  const successfulUpload = f.service.create(input, randomUUID());
  await vi.waitFor(() => expect(f.service.get(successfulUpload.id).state).toBe('succeeded'));
  expect(f.remote.files.get('/target/file')?.toString()).toBe('local tree');
  const read = f.remote.native.readStream;
  f.remote.native.readStream = () =>
    new Readable({
      read() {
        this.destroy(new Error('controlled recursive download failure'));
      },
    });
  const download = {
    ...input,
    direction: 'download' as const,
    localPath: 'target',
    remotePath: '/source',
  };
  const failedDownload = f.service.create(download, randomUUID());
  await vi.waitFor(() => expect(f.service.get(failedDownload.id).state).toBe('failed'));
  expect(await readFile(join(f.directory, 'target'), 'utf8')).toBe('local original');
  f.remote.native.readStream = read;
  const successfulDownload = f.service.create(download, randomUUID());
  await vi.waitFor(() => expect(f.service.get(successfulDownload.id).state).toBe('succeeded'));
  expect(await readFile(join(f.directory, 'target/file'), 'utf8')).toBe('remote tree');
  expect([...f.remote.files.keys()].some((path) => path.includes('.axterm-'))).toBe(false);
});
