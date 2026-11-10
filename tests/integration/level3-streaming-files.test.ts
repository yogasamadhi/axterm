import { ConfigurationPortableFiles } from '../../packages/plugins/configuration/src/adapters/portable-files.ts';
import { randomUUID, createHash } from 'node:crypto';
import {
  type FileHandle,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
  mkdir,
  lstat,
  link,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { root } from '@openclaw/fs-safe/root';
import { NativeFileGrantRegistry } from '@axterm/infra-desktop-native';
import { RemoteError } from '@axterm/plugin-api';
import type { FileGrants } from '@axterm/plugin-api/host';
import { GrantedStreamingFiles } from '../../packages/plugins/files/src/adapters/streaming-files.ts';
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(openRoot?: typeof root) {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-streaming-file-authority-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const registry = new NativeFileGrantRegistry(randomUUID());
  cleanups.push(() => registry.close());
  const grants = new Set<AbortController>();
  let released = 0;
  const service = new GrantedStreamingFiles(
    () =>
      ({
        authorize: async (id, permission, signal) => {
          const abort = new AbortController();
          grants.add(abort);
          const lifetime = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]);
          const authority = await registry.authorize(id, permission, lifetime);
          let active = true;
          return {
            authority,
            signal: lifetime,
            assert: () => {
              if (!active || lifetime.aborted)
                throw new RemoteError('files/failure', 'Fixture authority retired', {
                  reason: 'cancelled',
                });
            },
            dispose: () => {
              if (active) {
                active = false;
                released++;
                grants.delete(abort);
                abort.abort();
              }
            },
          };
        },
      }) satisfies Pick<FileGrants, 'authorize'>,
    openRoot,
  );
  cleanups.push(() => service.close());
  return {
    directory,
    registry,
    service,
    revoke: () => {
      for (const abort of grants) abort.abort();
    },
    released: () => released,
  };
}
async function bytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
it('streams a large file through private staging, inclusive ranges and owned metadata without exposing physical paths', async () => {
  const { directory, registry, service, released } = await fixture();
  const grant = await registry.createTrustedPath(directory, 'directory', ['read', 'write']);
  const write = await service.open(grant.grantId, 'write');
  const payload = Buffer.alloc(6 * 1024 * 1024, 0x6b);
  await write.write(
    'large.bin',
    Readable.from(
      (function* () {
        for (let offset = 0; offset < payload.length; offset += 64 * 1024)
          yield payload.subarray(offset, offset + 64 * 1024);
      })(),
    ),
  );
  expect(
    createHash('sha256')
      .update(await readFile(join(directory, 'large.bin')))
      .digest('hex'),
  ).toBe(createHash('sha256').update(payload).digest('hex'));
  expect(await write.stat('')).toMatchObject({ path: '', type: 'directory', name: grant.name });
  expect(await write.list('')).toMatchObject([{ name: 'large.bin', size: payload.length }]);
  await write.close();
  const read = await service.open(grant.grantId, 'read');
  expect(
    createHash('sha256')
      .update(await bytes(await read.read('large.bin')))
      .digest('hex'),
  ).toBe(createHash('sha256').update(payload).digest('hex'));
  expect(await bytes(await read.read('large.bin', { start: 17, end: 31 }))).toEqual(
    payload.subarray(17, 32),
  );
  await expect(read.write('forbidden', Readable.from('x'))).rejects.toMatchObject({
    details: { reason: 'forbidden' },
  });
  await expect(read.read('../escape')).rejects.toMatchObject({
    details: { reason: 'invalid-input' },
  });
  await read.close();
  expect(released()).toBe(2);
  expect(service.resourceCount()).toBe(0);
  expect(await readdir(directory)).toEqual(['large.bin']);
});
it('preserves original bytes after exclusive-create conflict or canceled staged writes and removes only its own stage', async () => {
  const { directory, registry, service } = await fixture();
  await writeFile(join(directory, 'existing.txt'), 'original');
  const grant = await registry.createTrustedPath(directory, 'directory', ['write']);
  const lease = await service.open(grant.grantId, 'write');
  await expect(lease.write('existing.txt', Readable.from('replacement'))).rejects.toMatchObject({
    details: { reason: 'conflict' },
  });
  expect(await readFile(join(directory, 'existing.txt'), 'utf8')).toBe('original');
  const input = new PassThrough({ highWaterMark: 64 * 1024 });
  const writing = lease.write('existing.txt', input, { overwrite: true });
  const rejected = expect(writing).rejects.toMatchObject({ details: { reason: 'cancelled' } });
  input.write(Buffer.alloc(64 * 1024));
  await vi.waitFor(async () =>
    expect((await readdir(directory)).some((name) => name !== 'existing.txt')).toBe(true),
  );
  await lease.close();
  await rejected;
  expect(await readdir(directory)).toEqual(['existing.txt']);
  expect(await readFile(join(directory, 'existing.txt'), 'utf8')).toBe('original');
  expect(input.closed).toBe(true);
  expect(service.resourceCount()).toBe(0);
});
it('binds a file/save-target authority to its selected name and rejects a replaced selected inode', async () => {
  const { directory, registry, service } = await fixture();
  const selected = join(directory, 'selected.txt');
  await writeFile(selected, 'selected');
  await writeFile(join(directory, 'sibling.txt'), 'private sibling');
  const grant = await registry.createTrustedPath(selected, 'file', ['read']);
  const lease = await service.open(grant.grantId, 'read');
  expect(lease.path).toBe('selected.txt');
  expect((await bytes(await lease.read(lease.path))).toString()).toBe('selected');
  await expect(lease.read('sibling.txt')).rejects.toMatchObject({
    details: { reason: 'forbidden' },
  });
  await rename(selected, join(directory, 'old.txt'));
  await writeFile(selected, 'replacement');
  await expect(lease.read(lease.path)).rejects.toMatchObject({ details: { reason: 'stale' } });
  await lease.close();
  const save = await registry.createTrustedPath(join(directory, 'saved.txt'), 'save-target', [
    'write',
  ]);
  const output = await service.open(save.grantId, 'write');
  await expect(
    output.write('sibling.txt', Readable.from('oops'), { overwrite: true }),
  ).rejects.toMatchObject({ details: { reason: 'forbidden' } });
  await output.write(output.path, Readable.from('saved'));
  await output.close();
  expect(await readFile(join(directory, 'saved.txt'), 'utf8')).toBe('saved');
});
it('rejects a replaced root and symlink/hardlink descendants without reading or modifying outside data', async () => {
  const { directory, registry, service } = await fixture();
  const inside = join(directory, 'inside');
  const outside = join(directory, 'outside');
  await mkdir(inside);
  await mkdir(outside);
  await writeFile(join(outside, 'private'), 'outside');
  const grant = await registry.createTrustedPath(inside, 'directory', ['read', 'write']);
  const read = await service.open(grant.grantId, 'read');
  await symlink(join(outside, 'private'), join(inside, 'link'));
  await expect(read.read('link')).rejects.toMatchObject({ details: { reason: 'forbidden' } });
  await read.close();
  const output = await service.open(grant.grantId, 'write');
  await rename(inside, inside + '.old');
  await symlink(outside, inside, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(
    output.write('private', Readable.from('replacement'), { overwrite: true }),
  ).rejects.toMatchObject({ details: { reason: 'stale' } });
  await output.close();
  expect(await readFile(join(outside, 'private'), 'utf8')).toBe('outside');
});
it('waits for a canceled late file open and closes its descriptor before releasing the lease', async () => {
  const opened = Promise.withResolvers<void>();
  let lateHandle: FileHandle | undefined;
  const proceed = Promise.withResolvers<void>();
  const controlled: typeof root = async (path, options) => {
    const filesystem = await root(path, options);
    return new Proxy(filesystem, {
      get(target, key) {
        if (key === 'open')
          return async (...args: Parameters<typeof filesystem.open>) => {
            const result = await target.open(...args);
            lateHandle = result.handle;
            opened.resolve();
            await proceed.promise;
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const { directory, registry, service, released } = await fixture(controlled);
  await writeFile(join(directory, 'read.txt'), 'late');
  const grant = await registry.createTrustedPath(directory, 'directory', ['read']);
  const lease = await service.open(grant.grantId, 'read');
  const reading = lease.read('read.txt');
  const rejected = expect(reading).rejects.toMatchObject({ details: { reason: 'cancelled' } });
  await opened.promise;
  const ended = vi.fn();
  const closing = lease.close().then(ended);
  await Promise.resolve();
  expect(ended).not.toHaveBeenCalled();
  expect(released()).toBe(0);
  proceed.resolve();
  await rejected;
  await closing;
  expect(released()).toBe(1);
  await expect(lateHandle!.stat()).rejects.toMatchObject({ code: 'EBADF' });
  expect(service.resourceCount()).toBe(0);
});
it('reaps paused read streams and stalled input on authority revocation and provider unload', async () => {
  const { directory, registry, service, revoke } = await fixture();
  await writeFile(join(directory, 'read.bin'), Buffer.alloc(256 * 1024));
  const grant = await registry.createTrustedPath(directory, 'directory', ['read', 'write']);
  const reading = await service.open(grant.grantId, 'read');
  const stream = await reading.read('read.bin');
  stream.read(1);
  const writing = await service.open(grant.grantId, 'write');
  const input = new PassThrough();
  const task = writing.write('write.bin', input);
  const rejected = expect(task).rejects.toMatchObject({ details: { reason: 'cancelled' } });
  input.write('partial');
  revoke();
  await rejected;
  await service.close();
  expect(stream.closed).toBe(true);
  expect(input.closed).toBe(true);
  expect(service.resourceCount()).toBe(0);
  await expect(service.open(grant.grantId, 'read')).rejects.toMatchObject({
    details: { reason: 'closed' },
  });
});

it('publishes complete replacements with the requested mode and bounded tree mutations', async () => {
  const { directory, registry, service } = await fixture();
  await writeFile(join(directory, 'existing'), 'original');
  const grant = await registry.createTrustedPath(directory, 'directory', ['write', 'read']);
  const lease = await service.open(grant.grantId, 'write');
  await lease.mkdir('folder');
  if (process.platform !== 'win32')
    expect((await lstat(join(directory, 'folder'))).mode & 0o777).toBe(0o700);
  await lease.write('existing', Readable.from('complete replacement'), {
    overwrite: true,
    mode: 0o640,
  });
  expect(await readFile(join(directory, 'existing'), 'utf8')).toBe('complete replacement');
  if (process.platform !== 'win32')
    expect((await lstat(join(directory, 'existing'))).mode & 0o777).toBe(0o640);
  await lease.move('existing', 'folder/moved');
  expect((await lease.list('folder'))[0]).toMatchObject({
    path: 'folder/moved',
    name: 'moved',
    type: 'file',
  });
  await lease.remove('folder/moved');
  expect(await lease.list('folder')).toEqual([]);
  await lease.write('folder/another', Readable.from('recursive child'));
  await lease.remove('folder', { recursive: true });
  await expect(lease.remove('')).rejects.toMatchObject({ details: { reason: 'forbidden' } });
  await lease.close();
  expect(await readdir(directory)).toEqual([]);
});
it('closes idle authorities on expiry and refuses excess read admissions or hardlinked content', async () => {
  const { directory, registry, service } = await fixture();
  await writeFile(join(directory, 'source'), 'source');
  await link(join(directory, 'source'), join(directory, 'linked'));
  const grant = await registry.createTrustedPath(directory, 'directory', ['read']);
  const lease = await service.open(grant.grantId, 'read');
  await expect(lease.read('linked')).rejects.toMatchObject({ details: { reason: 'forbidden' } });
  await lease.close();
  const expiring = await registry.createTrustedPath(directory, 'directory', ['read'], 150);
  const expired = await service.open(expiring.grantId, 'read');
  await vi.waitFor(() => expect(expired.signal.aborted).toBe(true));
  await expired.close();
  expect(service.resourceCount()).toBe(0);
  await writeFile(join(directory, 'other'), 'other');
  const fresh = await service.open(grant.grantId, 'read');
  const streams = await Promise.all(Array.from({ length: 32 }, () => fresh.read('other')));
  await expect(fresh.read('other')).rejects.toMatchObject({ details: { reason: 'capacity' } });
  await fresh.close();
  expect(streams.every((stream) => stream.closed)).toBe(true);
});
it('retains failed private-stage cleanup as active ownership instead of claiming a drained authority', async () => {
  let failCleanup = true;
  const controlled: typeof root = async (path, options) => {
    const fs = await root(path, options);
    if (options?.assertBeforeMutation) return fs;
    return new Proxy(fs, {
      get(target, key) {
        if (key === 'remove')
          return async (...args: Parameters<typeof target.remove>) => {
            if (failCleanup) throw new Error('controlled cleanup failure');
            return target.remove(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  const { directory, registry, service } = await fixture(controlled);
  const grant = await registry.createTrustedPath(directory, 'directory', ['write']);
  const lease = await service.open(grant.grantId, 'write');
  await expect(lease.write('target', Readable.from('complete'))).rejects.toMatchObject({
    details: { reason: 'unavailable' },
  });
  expect(service.resourceCount()).toBe(1);
  failCleanup = false;
  await lease.close();
  expect(service.resourceCount()).toBe(0);
  expect(await readFile(join(directory, 'target'), 'utf8')).toBe('complete');
});

it('publishes a complete owned directory or rolls its private stage back without modifying the original', async () => {
  const { directory, registry, service } = await fixture();
  await mkdir(join(directory, 'target'));
  await writeFile(join(directory, 'target/original'), 'original');
  const grant = await registry.createTrustedPath(directory, 'directory', ['write']);
  const lease = await service.open(grant.grantId, 'write');
  await expect(
    lease.writeDirectory(
      'target',
      async (writer) => {
        await writer.write('partial', Readable.from('partial'));
        throw new Error('controlled population failure');
      },
      { overwrite: true },
    ),
  ).rejects.toThrow();
  expect(await readdir(join(directory, 'target'))).toEqual(['original']);
  expect(await readdir(directory)).toEqual(['target']);
  await lease.writeDirectory(
    'target',
    async (writer) => {
      await writer.mkdir('nested');
      await writer.write('nested/new', Readable.from('complete'));
    },
    { overwrite: true },
  );
  expect(await readdir(join(directory, 'target'))).toEqual(['nested']);
  expect(await readFile(join(directory, 'target/nested/new'), 'utf8')).toBe('complete');
  expect(await readdir(directory)).toEqual(['target']);
  await lease.close();
});
it('cleans only the current directory stage after authorization is revoked during population', async () => {
  const { directory, registry, service, revoke } = await fixture();
  await mkdir(join(directory, 'target'));
  await writeFile(join(directory, 'target/original'), 'original');
  const grant = await registry.createTrustedPath(directory, 'directory', ['write']);
  const lease = await service.open(grant.grantId, 'write');
  const input = new PassThrough();
  const writing = lease.writeDirectory(
    'target',
    async (writer) => {
      await writer.write('partial', input);
    },
    { overwrite: true },
  );
  const rejected = expect(writing).rejects.toMatchObject({ details: { reason: 'cancelled' } });
  input.write('partial');
  await vi.waitFor(async () => expect((await readdir(directory)).length).toBeGreaterThan(1));
  revoke();
  await rejected;
  await service.close();
  expect(await readdir(directory)).toEqual(['target']);
  expect(await readFile(join(directory, 'target/original'), 'utf8')).toBe('original');
});

it('uses actual pinned streaming leases for configuration read and atomic export, rejects stale authority and leaves no stages', async () => {
  const f = await fixture();
  const target = join(f.directory, 'configuration.json');
  await writeFile(target, '{"old":true}');
  const file = new ConfigurationPortableFiles(() => f.service);
  const save = await f.registry.createTrustedPath(target, 'save-target', ['write']);
  const contents = Buffer.from(
    JSON.stringify({ format: 'owned-test', data: 'x'.repeat(3 * 1024 * 1024) }),
  );
  await file.write(save.grantId, contents);
  expect((await readFile(target)).equals(contents)).toBe(true);
  const read = await f.registry.createTrustedPath(target, 'file', ['read']);
  expect(Buffer.from(await file.read(read.grantId)).equals(contents)).toBe(true);
  expect(f.service.resourceCount()).toBe(0);
  const outside = join(f.directory, 'outside.json');
  await writeFile(outside, 'MUST_NOT_READ');
  await rename(target, target + '.old');
  await symlink(outside, target);
  await expect(file.read(read.grantId)).rejects.toThrow();
  expect(f.service.resourceCount()).toBe(0);
  expect((await readdir(f.directory)).some((name) => name.includes('.axterm-'))).toBe(false);
});
it('bounds configuration file bodies before reading or publishing and releases actual authority on refusal', async () => {
  const f = await fixture();
  const target = join(f.directory, 'oversized.json');
  await writeFile(target, Buffer.alloc(16 * 1024 * 1024 + 1, 0x78));
  const file = new ConfigurationPortableFiles(() => f.service);
  const read = await f.registry.createTrustedPath(target, 'file', ['read']);
  await expect(file.read(read.grantId)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  expect(f.service.resourceCount()).toBe(0);
  const save = await f.registry.createTrustedPath(join(f.directory, 'absent.json'), 'save-target', [
    'write',
  ]);
  await expect(file.write(save.grantId, Buffer.alloc(16 * 1024 * 1024 + 1))).rejects.toMatchObject({
    code: 'PAYLOAD_TOO_LARGE',
  });
  await expect(lstat(join(f.directory, 'absent.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.service.resourceCount()).toBe(0);
});

it('writes sync backups through pinned atomic Files leases, preserving empty and binary payloads within 24 MiB', async () => {
  const { SyncBackupFiles } =
    await import('../../packages/plugins/configuration/src/adapters/sync-backup.ts');
  const f = await fixture();
  const destination = join(f.directory, 'sync-backup.bin');
  let grant = await f.registry.createTrustedPath(destination, 'save-target', ['write']);
  const files = new SyncBackupFiles(() => f.service);
  for (const payload of [
    Buffer.alloc(0),
    Buffer.from([0xff, 0x00, 0x0a]),
    Buffer.alloc(24 * 1024 * 1024, 0x61),
  ]) {
    grant = await f.registry.createTrustedPath(destination, 'save-target', ['write']);
    await files.write(grant.grantId, payload, new AbortController().signal);
    const saved = await readFile(destination);
    expect(saved.length).toBe(payload.length);
    expect(createHash('sha256').update(saved).digest('hex')).toBe(
      createHash('sha256').update(payload).digest('hex'),
    );
    if (process.platform !== 'win32') expect((await lstat(destination)).mode & 0o777).toBe(0o600);
    expect(await readdir(f.directory)).toEqual(['sync-backup.bin']);
  }
  const released = f.released();
  await expect(
    files.write(grant.grantId, Buffer.alloc(24 * 1024 * 1024 + 1), new AbortController().signal),
  ).rejects.toThrow('CAPACITY');
  expect(f.released()).toBe(released);
});

it('recording append preserves existing bytes and joins real stream completion without a private replacement stage', async () => {
  const { directory, registry, service, released } = await fixture();
  const path = join(directory, 'session.log');
  await writeFile(path, 'existing\n');
  const grant = await registry.createTrustedPath(path, 'save-target', ['write']);
  const lease = await service.open(grant.grantId, 'write');
  await lease.append(lease.path, Readable.from(['first\n', 'second\n']));
  expect(await readFile(path, 'utf8')).toBe('existing\nfirst\nsecond\n');
  await lease.close();
  expect(released()).toBe(1);
  expect(await readdir(directory)).toEqual(['session.log']);
});
it('recording append refuses a target created after the save authority was granted', async () => {
  const { directory, registry, service } = await fixture();
  const path = join(directory, 'raced.log');
  const grant = await registry.createTrustedPath(path, 'save-target', ['write']);
  const lease = await service.open(grant.grantId, 'write');
  await writeFile(path, 'unrelated');
  await expect(lease.append(lease.path, Readable.from(['must not append']))).rejects.toMatchObject({
    details: { reason: 'stale' },
  });
  expect(await readFile(path, 'utf8')).toBe('unrelated');
  await lease.close();
});
it('recording append drains an unfinished input on grant revocation and retains already-written log bytes', async () => {
  const { directory, registry, service, revoke, released } = await fixture();
  const path = join(directory, 'partial.log');
  const grant = await registry.createTrustedPath(path, 'save-target', ['write']);
  const lease = await service.open(grant.grantId, 'write'),
    input = new PassThrough();
  const writing = lease.append(lease.path, input);
  const rejected = expect(writing).rejects.toMatchObject({ details: { reason: 'cancelled' } });
  input.write('already written\n');
  await vi.waitFor(async () => expect(await readFile(path, 'utf8')).toBe('already written\n'));
  revoke();
  await rejected;
  await lease.close();
  expect(input.destroyed).toBe(true);
  expect(released()).toBe(1);
  expect(await readFile(path, 'utf8')).toBe('already written\n');
});

it.each(['ENOTSUP', 'helper-unavailable'])(
  'retains unsupported destination publication diagnosis for %s without exposing bytes or private errors',
  async (code) => {
    const f = await fixture(async (path, options) => {
      const filesystem = await root(path, options);
      return new Proxy(filesystem, {
        get(target, key) {
          if (key === 'move')
            return async () => {
              throw Object.assign(new Error('PRIVATE_PUBLICATION_PATH_CANARY'), { code });
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    await writeFile(join(f.directory, 'original.txt'), 'ORIGINAL_BYTES');
    const grant = await f.registry.createTrustedPath(f.directory, 'directory', ['read', 'write']);
    const lease = await f.service.open(grant.grantId, 'write');
    let failure: unknown;
    try {
      await lease.write('received.bin', Readable.from([Buffer.from('NEW_BYTES')]));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'files/failure',
      details: { reason: 'unsupported-destination' },
    });
    expect(String(failure)).not.toContain('PRIVATE_PUBLICATION_PATH_CANARY');
    expect(await readdir(f.directory)).toEqual(['original.txt']);
    expect(await readFile(join(f.directory, 'original.txt'), 'utf8')).toBe('ORIGINAL_BYTES');
    await lease.close();
    expect(f.service.resourceCount()).toBe(0);
  },
);
