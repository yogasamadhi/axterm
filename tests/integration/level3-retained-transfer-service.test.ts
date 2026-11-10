import { ArchiveTransferWorkflow } from '../../packages/plugins/transfers/src/application/archive-workflow.ts';
import { NativeArchiveStaging } from '../../packages/plugins/transfers/src/adapters/archive-staging.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { RemoteFileCapabilityUnavailableError } from '@axterm/plugin-api/host';
import type { RemoteFileTarget } from '@axterm/plugin-api/files';
import {
  TransferService,
  MAX_ACTIVE_TRANSFERS,
  MAX_RETRY_TRANSFERS,
} from '../../packages/plugins/transfers/src/application/transfer-service.ts';
import { OwnedTransferRepository } from '../../packages/plugins/transfers/src/adapters/transfer-repository.ts';
import { transferFixture } from '../fixtures/level3-transfers.ts';
import { memoryTransferFiles } from '../support/level3-transfer-memory-files.ts';
const complete = (f: Awaited<ReturnType<typeof transferFixture>>, id: string, state: string) =>
  vi.waitFor(() => expect(f.service.get(id).state).toBe(state), { interval: 1 });
it('revalidates actual granted leases on one-shot retry and expires retained requests on close', async () => {
  const f = await transferFixture();
  await writeFile(join(f.directory, 'payload.txt'), 'retry byte evidence');
  const open = f.local.open.bind(f.local);
  const resolve = vi.spyOn(f.local, 'open');
  resolve.mockImplementationOnce(async (...args) => {
    const lease = await open(...args);
    await lease.close();
    throw Error('CONTROLLED_OPEN_FAILURE');
  });
  const request = {
    target: f.target,
    direction: 'upload' as const,
    grantId: f.grant.grantId,
    localPath: 'payload.txt',
    remotePath: '/payload.txt',
  };
  const first = f.service.create(request, randomUUID());
  await complete(f, first.id, 'failed');
  expect(f.service.get(first.id).retryAvailability).toBe('available');
  expect(f.repository.getTransfer(first.id)).not.toHaveProperty('retryAvailability');
  f.remote.disconnect();
  expect(f.service.get(first.id).retryAvailability).toBe('connection-unavailable');
  expect(() => f.service.retry(first.id)).toThrow(
    expect.objectContaining({ code: 'INVALID_STATE' }),
  );
  expect(resolve).toHaveBeenCalledOnce();
  f.remote.reconnect();
  const retry = f.service.retry(first.id);
  expect(retry.id).not.toBe(first.id);
  expect(f.service.get(first.id).retryAvailability).toBe('request-expired');
  expect(() => f.service.retry(first.id)).toThrow(
    expect.objectContaining({ code: 'INVALID_STATE' }),
  );
  expect(() => f.service.retry(retry.id)).toThrow(
    expect.objectContaining({ code: 'INVALID_STATE' }),
  );
  await complete(f, retry.id, 'succeeded');
  expect(f.remote.files.get('/payload.txt')?.toString()).toBe('retry byte evidence');
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(f.service.get(retry.id).retryAvailability).toBe('not-terminal');
  await f.service.closeAll();
  expect(f.service.get(first.id).retryAvailability).toBe('request-expired');
  expect(f.local.resourceCount()).toBe(0);
});
it('bounds retained failed retry requests to the original200 and drops them on shutdown', async () => {
  const f = await transferFixture(),
    ids: string[] = [];
  for (let i = 0; i <= MAX_RETRY_TRANSFERS; i++) {
    const t = f.service.create(
      {
        direction: 'upload',
        target: f.target,
        grantId: f.grant.grantId,
        localPath: 'missing',
        remotePath: '/payload.txt',
      },
      randomUUID(),
    );
    ids.push(t.id);
    await complete(f, t.id, 'failed');
  }
  expect(f.service.get(ids[0]!).retryAvailability).toBe('request-expired');
  expect(f.service.list().filter((t) => t.retryAvailability === 'available')).toHaveLength(
    MAX_RETRY_TRANSFERS,
  );
  expect(f.service.get(ids.at(-1)!).retryAvailability).toBe('available');
  await f.service.closeAll();
  expect(f.service.list().every((t) => t.retryAvailability === 'request-expired')).toBe(true);
  expect(f.service.resourceCount()).toBe(0);
});
it('checks both remote-copy targets and FTP readiness before advertising retry', async () => {
  const f = await transferFixture(),
    source = f.target,
    target = { protocol: 'sftp' as const, connectionId: randomUUID() };
  let ready = false;
  vi.spyOn(f.connections, 'get').mockImplementation(
    (id) => ({ state: id === source.connectionId || ready ? 'ready' : 'closed' }) as never,
  );
  vi.spyOn(f.connections, 'getFtp').mockImplementation(
    () => ({ state: ready ? 'ready' : 'closed' }) as never,
  );
  vi.spyOn(f.connections, 'openFiles').mockRejectedValue(Error('CONTROLLED_IO_FAILURE'));
  const copy = f.service.create(
    { direction: 'remote-copy', source, target, sourcePath: '/a', targetPath: '/b' },
    randomUUID(),
  );
  const ftp = f.service.create(
    {
      direction: 'download',
      target: { protocol: 'ftp', connectionId: randomUUID() },
      grantId: f.grant.grantId,
      remotePath: '/a',
      localPath: 'a',
    },
    randomUUID(),
  );
  await complete(f, copy.id, 'failed');
  await complete(f, ftp.id, 'failed');
  expect(f.service.get(copy.id).retryAvailability).toBe('connection-unavailable');
  expect(f.service.get(ftp.id).retryAvailability).toBe('connection-unavailable');
  ready = true;
  expect(f.service.get(copy.id).retryAvailability).toBe('available');
  expect(f.service.get(ftp.id).retryAvailability).toBe('available');
  expect(f.service.clearCompleted()).toBe(2);
  expect(f.service.list()).toEqual([]);
});
it('preserves original bytes and removes staging when atomic remote overwrite is unavailable', async () => {
  const f = await transferFixture({ '/target.txt': 'original' });
  await writeFile(join(f.directory, 'source.txt'), 'replacement');
  f.remote.native.replace = async () => {
    throw new RemoteFileCapabilityUnavailableError('atomic-replace');
  };
  const t = f.service.create(
    {
      direction: 'upload',
      target: f.target,
      grantId: f.grant.grantId,
      localPath: 'source.txt',
      remotePath: '/target.txt',
      conflict: 'ask',
    },
    randomUUID(),
  );
  await complete(f, t.id, 'awaiting-decision');
  expect(f.remote.files.get('/target.txt')?.toString()).toBe('original');
  f.service.decideConflict(t.id, { strategy: 'overwrite', applyToAll: false });
  await complete(f, t.id, 'failed');
  expect(f.service.get(t.id)).toMatchObject({
    errorCode: 'TRANSFER_ATOMIC_REPLACE_UNAVAILABLE',
    retryAvailability: 'available',
  });
  expect(f.remote.files.get('/target.txt')?.toString()).toBe('original');
  expect([...f.remote.files.keys()]).toEqual(['/target.txt']);
  expect(f.remote.counts().active).toBe(0);
  expect(f.remote.counts().opened).toBe(f.remote.counts().closed);
});
it('classifies atomic remote-copy refusal without removing the original or retaining stages', async () => {
  const f = await transferFixture({ '/source.txt': 'replacement', '/target.txt': 'original' });
  f.remote.native.replace = async () => {
    throw new RemoteFileCapabilityUnavailableError('atomic-replace');
  };
  const t = f.service.create(
    {
      direction: 'remote-copy',
      source: f.target,
      target: f.target,
      sourcePath: '/source.txt',
      targetPath: '/target.txt',
      conflict: 'overwrite',
    },
    randomUUID(),
  );
  await complete(f, t.id, 'failed');
  expect(f.service.get(t.id)).toMatchObject({
    errorCode: 'TRANSFER_ATOMIC_REPLACE_UNAVAILABLE',
    retryAvailability: 'available',
  });
  expect(f.remote.files.get('/target.txt')?.toString()).toBe('original');
  expect([...f.remote.files.keys()].sort()).toEqual(['/source.txt', '/target.txt']);
  expect(f.remote.counts().active).toBe(0);
});
it('joins each pooled stream before closing its own channel and drains all channels on failure', async () => {
  const f = await transferFixture();
  await mkdir(join(f.directory, 'folder'));
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'])
    await writeFile(join(f.directory, 'folder', name), name);
  const held = Promise.withResolvers<void>(),
    events: string[] = [],
    writes: string[] = [];
  let writing = 0;
  const open = f.connections.openFiles.bind(f.connections);
  vi.spyOn(f.connections, 'openFiles').mockImplementation(async (...args) => {
    const lease = await open(...args);
    let owned = 0;
    return {
      ...lease,
      filesystem: {
        ...lease.filesystem,
        writeStream(path) {
          writes.push(path);
          const fail = writes.length === 1;
          owned++;
          writing++;
          let retained = true;
          return new Writable({
            write(_chunk, _encoding, done) {
              if (fail) done(Error('INJECTED_STREAM_FAILURE'));
              else void held.promise.then(() => done());
            },
            destroy(error, done) {
              if (retained) {
                retained = false;
                owned--;
                writing--;
                events.push('stream closed');
              }
              done(error);
            },
          });
        },
      },
      close: async () => {
        expect(owned).toBe(0);
        events.push('channel closed');
        await lease.close();
      },
    };
  });
  const t = f.service.create(
    {
      direction: 'upload',
      target: f.target,
      grantId: f.grant.grantId,
      localPath: 'folder',
      remotePath: '/folder',
      recursive: true,
    },
    randomUUID(),
  );
  try {
    await vi.waitFor(() => expect(writes.length).toBe(4));
    expect(f.service.resourceCount()).toBeGreaterThan(0);
    held.resolve();
    await complete(f, t.id, 'failed');
    expect(writes).toHaveLength(4);
    expect(writing).toBe(0);
    expect(events.at(-1)).toBe('channel closed');
    expect(f.remote.counts().active).toBe(0);
    expect(f.service.resourceCount()).toBe(0);
  } finally {
    held.resolve();
  }
});
it('recovers all five interrupted states without reviving requests or grants and preserves terminal outcomes', async () => {
  const f = await transferFixture();
  const states = [
    'queued',
    'preparing',
    'running',
    'paused',
    'awaiting-decision',
    'succeeded',
    'failed',
    'canceled',
  ] as const;
  const rows = states.map((state) => ({
    id: randomUUID(),
    connectionId: randomUUID(),
    direction: 'download' as const,
    state,
    source: '/remote.txt',
    destination: 'authorized/remote.txt',
    bytesTransferred: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  for (const row of rows) f.repository.reserve(randomUUID(), { state: row.state }, () => row);
  const next = new OwnedTransferRepository(f.domain, 'desktop', randomUUID()),
    service = new TransferService(f.connections, f.local, next, { publish() {} }, f.archive);
  try {
    for (const row of rows.slice(0, 5)) {
      expect(service.get(row.id)).toMatchObject({
        state: 'failed',
        errorCode: 'RUNTIME_INTERRUPTED',
        retryAvailability: 'request-expired',
      });
      expect(() => service.retry(row.id)).toThrow(
        expect.objectContaining({ code: 'INVALID_STATE' }),
      );
    }
    for (const row of rows.slice(5)) expect(service.get(row.id).state).toBe(row.state);
    expect(service.resourceCount()).toBe(0);
  } finally {
    await service.closeAll();
  }
});
it('fails waiting conflict on disconnect, drains the selected leases and leaves destination bytes intact', async () => {
  const f = await transferFixture({ '/target.txt': 'original' });
  await writeFile(join(f.directory, 'payload.txt'), 'replacement');
  const t = f.service.create(
    {
      direction: 'upload',
      target: f.target,
      grantId: f.grant.grantId,
      localPath: 'payload.txt',
      remotePath: '/target.txt',
      conflict: 'ask',
    },
    randomUUID(),
  );
  await complete(f, t.id, 'awaiting-decision');
  expect(f.remote.counts().active).toBe(2);
  f.remote.disconnect();
  await complete(f, t.id, 'failed');
  expect(f.service.get(t.id)).toMatchObject({
    errorCode: 'TRANSFER_FAILED',
    retryAvailability: 'connection-unavailable',
  });
  expect(f.remote.counts().active).toBe(0);
  expect(f.remote.counts().closed).toBe(2);
  expect(f.remote.files.get('/target.txt')?.toString()).toBe('original');
  expect(f.local.resourceCount()).toBe(0);
});
it('uses isolated FTP file leases and writes only the explicit relative download destination', async () => {
  const f = await transferFixture({ '/remote.txt': 'download payload' });
  await writeFile(join(f.directory, 'payload.txt'), 'ftp payload');
  const open = vi.spyOn(f.connections, 'openFiles');
  const target = { protocol: 'ftp' as const, connectionId: randomUUID() };
  const upload = f.service.create(
    {
      direction: 'upload',
      target,
      grantId: f.grant.grantId,
      localPath: 'payload.txt',
      remotePath: '/payload.txt',
    },
    randomUUID(),
  );
  await complete(f, upload.id, 'succeeded');
  expect(f.remote.files.get('/payload.txt')?.toString()).toBe('ftp payload');
  expect(open.mock.calls.every(([selected]) => selected.protocol === 'ftp')).toBe(true);
  expect(open).toHaveBeenCalledTimes(2);
  const download = f.service.create(
    {
      direction: 'download',
      target: f.target,
      grantId: f.grant.grantId,
      localPath: 'left-pane/active-directory/remote.txt',
      remotePath: '/remote.txt',
    },
    randomUUID(),
  );
  await complete(f, download.id, 'succeeded');
  expect(await readFile(join(f.directory, 'left-pane/active-directory/remote.txt'), 'utf8')).toBe(
    'download payload',
  );
  expect(f.service.get(download.id).destination).toBe('left-pane/active-directory/remote.txt');
  expect(JSON.stringify(f.service.get(download.id))).not.toContain(f.grant.grantId);
  expect(f.remote.counts().active).toBe(0);
});
it('requires a command UUID, preserves4MiB pause/resume and drains cancellation before terminal shutdown', async () => {
  const f = await transferFixture();
  await writeFile(join(f.directory, 'large.bin'), Buffer.alloc(4 * 1024 * 1024, 7));
  const callbacks: ((error?: Error | null) => void)[] = [];
  f.remote.delay((_bytes, done) => callbacks.push(done));
  const request = {
    direction: 'upload' as const,
    target: f.target,
    grantId: f.grant.grantId,
    localPath: 'large.bin',
    remotePath: '/large.bin',
  };
  expect(() => f.service.create(request, undefined as never)).toThrow(
    expect.objectContaining({ code: 'transfers/failure', details: { reason: 'invalid-input' } }),
  );
  expect(f.service.list()).toEqual([]);
  const t = f.service.create(request, randomUUID());
  await vi.waitFor(() => expect(callbacks).toHaveLength(1));
  f.service.pause(t.id);
  expect(f.service.get(t.id).state).toBe('paused');
  f.service.resume(t.id);
  expect(f.service.get(t.id).state).toBe('running');
  f.service.cancel(t.id);
  const close = f.service.closeAll();
  for (const done of callbacks.splice(0)) done();
  await close;
  expect(f.service.get(t.id)).toMatchObject({
    state: 'canceled',
    retryAvailability: 'request-expired',
  });
  expect(f.service.resourceCount()).toBe(0);
  expect(f.remote.counts().active).toBe(0);
  expect([...f.remote.files.keys()]).toEqual([]);
  expect(await readdir(f.directory)).toEqual(['large.bin']);
  expect(() => f.service.create(request, randomUUID())).toThrow('closing');
});
it('bounds simultaneously admitted transfer tasks to the original32 without admitting another IO', async () => {
  const f = await transferFixture();
  await writeFile(join(f.directory, 'source.bin'), Buffer.alloc(1));
  const gate = Promise.withResolvers<void>(),
    open = f.local.open.bind(f.local);
  const held = vi.spyOn(f.local, 'open').mockImplementation(async (...args) => {
    await gate.promise;
    return open(...args);
  });
  const request = {
    direction: 'upload' as const,
    target: f.target,
    grantId: f.grant.grantId,
    localPath: 'source.bin',
    remotePath: '/bounded.bin',
  };
  try {
    for (let i = 0; i < MAX_ACTIVE_TRANSFERS; i++) f.service.create(request, randomUUID());
    expect(f.service.progressSnapshot()).toHaveLength(MAX_ACTIVE_TRANSFERS);
    expect(() => f.service.create(request, randomUUID())).toThrow(
      expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }),
    );
    gate.resolve();
    await f.service.closeAll();
    expect(f.service.resourceCount()).toBe(0);
    expect(held).toHaveBeenCalledTimes(MAX_ACTIVE_TRANSFERS);
  } finally {
    gate.resolve();
  }
});
it('streams the original same-server cross-server recursive and interactive remote copies with independent leases', async () => {
  const f = await transferFixture(),
    a = memoryTransferFiles({
      '/source.txt': 'remote-source',
      '/tree/a.txt': 'alpha',
      '/tree/nested/b.txt': 'beta',
    }),
    b = memoryTransferFiles(),
    source = f.target,
    target = { protocol: 'sftp' as const, connectionId: randomUUID() };
  b.directories.add('/dest');
  vi.spyOn(f.connections, 'openFiles').mockImplementation((selected: RemoteFileTarget, signal) =>
    (selected.connectionId === source.connectionId ? a : b).connection.openFiles(selected, signal),
  );
  for (const request of [
    { source, target, sourcePath: '/source.txt', targetPath: '/dest/source.txt' },
    { source: target, target, sourcePath: '/dest/source.txt', targetPath: '/dest/source-copy.txt' },
    { source, target, sourcePath: '/tree', targetPath: '/copied', recursive: true },
  ]) {
    const t = f.service.create({ direction: 'remote-copy', ...request }, randomUUID());
    await complete(f, t.id, 'succeeded');
    expect(f.service.get(t.id).bytesPerSecond).toBeGreaterThan(0);
  }
  expect(b.files.get('/dest/source.txt')?.toString()).toBe('remote-source');
  expect(b.files.get('/dest/source-copy.txt')?.toString()).toBe('remote-source');
  expect(b.files.get('/copied/a.txt')?.toString()).toBe('alpha');
  expect(b.files.get('/copied/nested/b.txt')?.toString()).toBe('beta');
  const interactive = f.service.create(
    {
      direction: 'remote-copy',
      source,
      target,
      sourcePath: '/tree',
      targetPath: '/copied',
      recursive: true,
      conflict: 'ask',
    },
    randomUUID(),
  );
  await complete(f, interactive.id, 'awaiting-decision');
  expect(f.service.get(interactive.id).conflict).toMatchObject({
    path: '/copied',
    type: 'directory',
  });
  f.service.decideConflict(interactive.id, { strategy: 'overwrite', applyToAll: true });
  await complete(f, interactive.id, 'succeeded');
  expect(b.files.get('/copied/a.txt')?.toString()).toBe('alpha');
  expect(a.counts()).toEqual({ active: 0, opened: 8, closed: 8 });
  expect(b.counts()).toEqual({ active: 0, opened: 12, closed: 12 });
  expect(f.service.clearCompleted()).toBe(4);
  expect(f.service.list()).toEqual([]);
});

it.skipIf(process.platform === 'win32')(
  'reports a real missing remote archive tool and removes tar and extraction staging',
  async () => {
    const f = await transferFixture(),
      workflow = new ArchiveTransferWorkflow(new NativeArchiveStaging());
    f.archive.transfer = workflow.transfer.bind(workflow);
    f.archive.close = () => workflow.close();
    f.archive.resourceCount = () => workflow.resourceCount();
    f.connections.exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 127 }));
    await mkdir(join(f.directory, 'folder'));
    await writeFile(join(f.directory, 'folder/notes.txt'), 'archive payload');
    const removed: string[] = [],
      directories: string[] = [];
    const unlink = f.remote.native.unlink.bind(f.remote.native),
      rmdir = f.remote.native.rmdir.bind(f.remote.native);
    f.remote.native.unlink = async (path) => {
      removed.push(path);
      await unlink(path);
    };
    f.remote.native.rmdir = async (path) => {
      directories.push(path);
      await rmdir(path);
    };
    const t = f.service.create(
      {
        direction: 'upload',
        target: f.target,
        grantId: f.grant.grantId,
        localPath: 'folder',
        remotePath: '/folder',
        recursive: true,
        archive: true,
      },
      randomUUID(),
    );
    await complete(f, t.id, 'failed');
    expect(f.service.get(t.id).errorCode).toBe('CAPABILITY_UNAVAILABLE');
    expect(removed.some((path) => path.endsWith('.tar'))).toBe(true);
    expect(directories.some((path) => path.endsWith('.extract'))).toBe(true);
    expect(f.remote.files.size).toBe(0);
    expect(f.remote.counts().active).toBe(0);
    expect(workflow.resourceCount()).toBe(0);
  },
);
