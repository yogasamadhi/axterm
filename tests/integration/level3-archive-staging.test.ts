import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, utimes, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { Header } from 'tar';
import { afterEach, expect, it } from 'vitest';
import { NativeFileGrantRegistry } from '@axterm/infra-desktop-native';
import { GrantedStreamingFiles } from '../../packages/plugins/files/src/adapters/streaming-files.ts';
import { NativeArchiveStaging } from '../../packages/plugins/transfers/src/adapters/archive-staging.ts';
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-archive-staging-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const registry = new NativeFileGrantRegistry(randomUUID());
  cleanups.push(() => registry.close());
  const grant = await registry.createTrustedPath(directory, 'directory', ['read', 'write']);
  const files = new GrantedStreamingFiles(() => ({
    authorize: async (id, permission, signal) => ({
      authority: await registry.authorize(id, permission, signal),
      signal: signal ?? new AbortController().signal,
      assert: () => signal?.throwIfAborted(),
      dispose: () => {},
    }),
  }));
  cleanups.push(() => files.close());
  const staging = new NativeArchiveStaging();
  cleanups.push(() => staging.close());
  return { directory, grant, files, staging };
}
it('packs only a selected virtual tree and publishes validated tar bytes through the directory owner with modes and times', async () => {
  const f = await fixture();
  await mkdir(join(f.directory, 'folder'));
  await mkdir(join(f.directory, 'folder/nested'));
  await writeFile(join(f.directory, 'folder/nested/file'), 'archive bytes');
  const timestamp = new Date('2020-01-02T03:04:05.000Z');
  await utimes(join(f.directory, 'folder/nested/file'), timestamp, timestamp);
  if (process.platform !== 'win32') await chmod(join(f.directory, 'folder/nested/file'), 0o640);
  const source = await f.files.open(f.grant.grantId, 'read');
  const signal = new AbortController().signal;
  const packed = await f.staging.pack(source, 'folder', signal);
  expect(packed.size).toBeGreaterThan(512);
  const extracted = await f.staging.unpack(packed.read(), 'folder', signal);
  const target = await f.files.open(f.grant.grantId, 'write');
  await target.writeDirectory('restored', (writer) => extracted.publish(writer, signal));
  expect(await readFile(join(f.directory, 'restored/nested/file'), 'utf8')).toBe('archive bytes');
  const metadata = await lstat(join(f.directory, 'restored/nested/file'));
  expect(Math.abs(metadata.mtimeMs - timestamp.getTime())).toBeLessThan(1000);
  if (process.platform !== 'win32') expect(metadata.mode & 0o777).toBe(0o640);
  await extracted.close();
  await packed.close();
  await source.close();
  await target.close();
  expect(f.staging.resourceCount()).toBe(0);
  expect(() => packed.read()).toThrow('closed');
});
function archiveMember(
  path: string,
  type: 'File' | 'Directory' | 'SymbolicLink' = 'File',
  body = 'bad',
): Buffer {
  const bytes = type === 'File' ? Buffer.from(body) : Buffer.alloc(0);
  const header = new Header({
    path,
    type,
    size: bytes.length,
    mode: type === 'Directory' ? 0o700 : 0o600,
    ...(type === 'SymbolicLink' ? { linkpath: '../../outside' } : {}),
  });
  header.encode();
  return Buffer.concat([header.block!, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}
it.each(['../outside', 'folder/../../outside', '/absolute', 'other-root/file', 'folder\\escape'])(
  'rejects archive member %s before extracting or publishing data',
  async (path) => {
    const f = await fixture();
    const body = Buffer.concat([
      archiveMember('folder/', 'Directory'),
      archiveMember(path),
      Buffer.alloc(1024),
    ]);
    await expect(
      f.staging.unpack(Readable.from(body), 'folder', new AbortController().signal),
    ).rejects.toThrow();
    expect(f.staging.resourceCount()).toBe(0);
  },
);
it('skips archive links and refuses malformed input without retaining native staging', async () => {
  const f = await fixture();
  const body = Buffer.concat([
    archiveMember('folder/', 'Directory'),
    archiveMember('folder/link', 'SymbolicLink'),
    archiveMember('folder/file', 'File', 'safe'),
    Buffer.alloc(1024),
  ]);
  const unpacked = await f.staging.unpack(
    Readable.from(body),
    'folder',
    new AbortController().signal,
  );
  const target = await f.files.open(f.grant.grantId, 'write');
  await target.writeDirectory('result', (writer) =>
    unpacked.publish(writer, new AbortController().signal),
  );
  await expect(lstat(join(f.directory, 'result/link'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(f.directory, 'result/file'), 'utf8')).toBe('safe');
  await unpacked.close();
  await target.close();
  await expect(
    f.staging.unpack(Readable.from('not an archive'), 'folder', new AbortController().signal),
  ).rejects.toThrow();
  expect(f.staging.resourceCount()).toBe(0);
});
it('cancels and drains a stalled archive input during owner disposal', async () => {
  const f = await fixture();
  let destroyed = false;
  const source = new Readable({
    read() {},
    destroy(error, done) {
      destroyed = true;
      done(error);
    },
  });
  const pending = f.staging.unpack(source, 'folder', new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow();
  await Promise.resolve();
  await f.staging.close();
  await rejected;
  expect(destroyed).toBe(true);
  expect(f.staging.resourceCount()).toBe(0);
});
