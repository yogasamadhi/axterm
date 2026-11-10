import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import type { RemoteFilesystem } from '@axterm/plugin-api/host';
import type { RemoteDirectoryListing } from '@axterm/plugin-api/files';
import { FileCommandJournal } from '../../packages/plugins/files/src/adapters/command-journal.ts';
import { RemoteFileApplication } from '../../packages/plugins/files/src/application/remote-files.ts';
import { RemoteDirectoryProjection } from '../../packages/plugins/files/src/client/remote-directory-projection.ts';
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
});
it('journals a large text replacement without storing body or path and never replays a completed command', async () => {
  const ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.files);
  const journal = new FileCommandJournal(domain, 'desktop', randomUUID());
  const content = new Map([['/private.txt', Buffer.alloc(0)]]);
  let version = 1;
  const attributes = () => ({
    size: content.get('/private.txt')!.length,
    mode: 0o100640,
    atime: version,
    mtime: version,
    uid: 501,
    gid: 20,
    isFile: true,
    isDirectory: false,
    isSymbolicLink: false,
  });
  const handle: RemoteFilesystem = {
    realpath: async (path) => path,
    list: async () => [],
    stat: async () => attributes(),
    lstat: async () => attributes(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    replace: async (from, to) => {
      content.set(to, content.get(from)!);
      content.delete(from);
      version++;
    },
    unlink: async (path) => {
      content.delete(path);
    },
    rmdir: vi.fn(),
    chmod: vi.fn(),
    readStream: (path) => Readable.from([content.get(path)!]),
    writeStream: (path) => {
      const chunks: Buffer[] = [];
      return new Writable({
        write(bytes, _encoding, done) {
          chunks.push(Buffer.from(bytes));
          done();
        },
        final(done) {
          content.set(path, Buffer.concat(chunks));
          done();
        },
      });
    },
    close: vi.fn(async () => {}),
  };
  const openFiles = vi.fn(async () => ({
    filesystem: handle,
    signal: new AbortController().signal,
    close: () => handle.close(),
  }));
  const app = new RemoteFileApplication(() => ({ openFiles }), journal);
  const target = { protocol: 'sftp' as const, connectionId: randomUUID() };
  const signal = new AbortController().signal;
  try {
    const initial = await app.readText(target, '/private.txt', signal);
    const input = {
      path: '/private.txt',
      content: 'PRIVATE_EDITOR_BODY' + 'x'.repeat(1024 * 1024 + 32),
      overwriteRevision: initial.revision,
      lineEnding: 'crlf' as const,
    };
    const key = randomUUID();
    const receipt = await app.writeText(key, target, input, signal);
    expect(content.get('/private.txt')!.toString()).toBe(input.content);
    const opens = openFiles.mock.calls.length;
    expect(await app.writeText(key, target, input, signal)).toEqual(receipt);
    expect(openFiles).toHaveBeenCalledTimes(opens);
    await expect(
      app.writeText(key, target, { ...input, content: 'changed' }, signal),
    ).rejects.toMatchObject({ details: { reason: 'conflict' } });
    await expect(app.writeText(randomUUID(), target, input, signal)).rejects.toMatchObject({
      details: { reason: 'conflict' },
    });
    const facts = JSON.stringify({
      rows: domain.all('SELECT * FROM axterm_file_operation_receipts'),
      events: domain.events(0),
    });
    expect(facts).not.toContain('PRIVATE_EDITOR_BODY');
    expect(facts).not.toContain('/private.txt');
    expect(facts.length).toBeLessThan(6000);
  } finally {
    await journal.close();
    await domain.close();
  }
});

it('publishes only complete immutable remote directory replacements and rejects malformed sequencing', () => {
  const projection = new RemoteDirectoryProjection();
  const generation = randomUUID();
  const listing: RemoteDirectoryListing = {
    target: { protocol: 'sftp', connectionId: randomUUID() },
    path: '/',
    entries: [{ name: 'file', path: '/file', type: 'file', size: 0, revision: 'v1' }],
  };
  const text = JSON.stringify(listing);
  expect(
    projection.accept({ type: 'begin', mode: 'baseline', generation, cursor: 0 }),
  ).toBeUndefined();
  expect(projection.accept({ type: 'chunk', offset: 0, text, final: true })).toBeUndefined();
  const baseline = projection.accept({ type: 'commit', cursor: 0 })!;
  expect(baseline.entries).toHaveLength(1);
  expect(Object.isFrozen(baseline.entries[0])).toBe(true);
  expect(() =>
    projection.accept({ type: 'begin', mode: 'replace', generation: randomUUID(), cursor: 1 }),
  ).toThrow();
  projection.reset();
  projection.accept({ type: 'begin', mode: 'baseline', generation: randomUUID(), cursor: 0 });
  expect(() => projection.accept({ type: 'chunk', offset: 1, text, final: true })).toThrow();
});
