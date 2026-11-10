import { ownedStorage } from '../fixtures/level3-owned-storage.ts';
import { StoredTerminalAssets } from '../../packages/plugins/terminals/src/adapters/background-assets.ts';
import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import type { HostFiles, ConfigurationQueries } from '@axterm/plugin-api/host';
import { TerminalBackgroundAssets } from '../../packages/plugins/terminals/src/application/background-assets.ts';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'axterm-background-owner-')),
    ctx = new Context();
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: join(home, 'db.sqlite'), schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.terminalAssets),
    generation = randomUUID();
  let data = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(131072, 7),
    ]),
    size = data.length,
    failClose = false,
    reference: string | null = null,
    gate: Promise<void> | undefined;
  const close = vi.fn(async () => {
    if (failClose) throw Error('LEASE_CLOSE_FAULT');
  });
  const read = vi.fn(async () =>
    Readable.from(
      (async function* () {
        if (gate) await gate;
        yield data.subarray(0, 333);
        yield data.subarray(333);
      })(),
    ),
  );
  const files = {
    open: vi.fn(async (_id: string, _permission: string, signal: AbortSignal) => ({
      path: 'image.png',
      signal,
      stat: async () => ({ type: 'file', size }),
      read,
      close,
    })),
  } as unknown as HostFiles;
  const configuration = {
    getSettings: () => ({ terminal: { visual: { background: { assetId: reference } } } }),
  } as unknown as ConfigurationQueries;
  const storage = new StoredTerminalAssets(domain, (operation) => domain.transaction(operation));
  const owner = new TerminalBackgroundAssets(storage, files, configuration, generation);
  cleanups.push(async () => {
    failClose = false;
    await owner.close();
    await domain.close();
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  });
  return {
    owner,
    domain,
    generation,
    read,
    close,
    files,
    data: () => data,
    setCloseFault: (value: boolean) => {
      failClose = value;
    },
    setReference: (value: string | null) => {
      reference = value;
    },
    setData: (value: Uint8Array) => {
      data = Buffer.from(value);
      size = data.length;
    },
    setSize: (value: number) => {
      size = value;
    },
    setGate: (value: Promise<void>) => {
      gate = value;
    },
  };
}
it('stores bounded BLOB chunks atomically, joins an identical import and reuses its receipt without opening the grant', async () => {
  const f = await fixture(),
    key = randomUUID(),
    signal = new AbortController().signal;
  const first = f.owner.import(key, 'native-grant', f.generation, signal),
    second = f.owner.import(key, 'native-grant', f.generation, signal);
  expect(first).toBe(second);
  const result = await first;
  expect(f.files.open).toHaveBeenCalledOnce();
  expect(await f.owner.import(key, 'native-grant', f.generation, signal)).toEqual(result);
  expect(f.files.open).toHaveBeenCalledOnce();
  expect(
    f.domain
      .all<{ kind: string }>('SELECT typeof(content) AS kind FROM terminal_background_asset_chunks')
      .every((row) => row.kind === 'blob'),
  ).toBe(true);
  expect(
    f.domain.get<{ count: number }>(
      'SELECT count(*) AS count FROM terminal_background_asset_chunks',
    )?.count,
  ).toBe(3);
  expect(() => f.owner.import(key, 'different-grant', f.generation, signal)).toThrow('CONFLICT');
  expect(() => f.owner.import(randomUUID(), 'native-grant', randomUUID(), signal)).toThrow();
  const opened = f.owner.openStream(result.asset.id),
    chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  await opened.close();
  expect(Buffer.concat(chunks)).toEqual(f.data());
});
it('refuses deletion while a reader or Configuration owns the asset and retains exact delete receipts', async () => {
  const f = await fixture(),
    result = await f.owner.import(
      randomUUID(),
      'grant',
      f.generation,
      new AbortController().signal,
    ),
    id = result.asset.id;
  const opened = f.owner.openStream(id);
  expect(() => f.owner.remove(randomUUID(), id, 1, f.generation)).toThrow();
  await opened.close();
  f.setReference(id);
  expect(() => f.owner.remove(randomUUID(), id, 1, f.generation)).toThrow();
  f.setReference(null);
  expect(() => f.owner.remove(randomUUID(), id, 2, f.generation)).toThrow();
  const key = randomUUID(),
    deleted = f.owner.remove(key, id, 1, f.generation);
  expect(f.owner.remove(key, id, 1, f.generation)).toEqual(deleted);
  expect(f.owner.list()).toEqual([]);
  expect(
    f.domain.get<{ count: number }>(
      'SELECT count(*) AS count FROM terminal_background_asset_chunks',
    )?.count,
  ).toBe(0);
});
it('keeps failed grant cleanup for actual close retries without losing the committed receipt', async () => {
  const f = await fixture(),
    key = randomUUID();
  f.setCloseFault(true);
  await expect(
    f.owner.import(key, 'grant', f.generation, new AbortController().signal),
  ).rejects.toThrow('LEASE_CLOSE_FAULT');
  expect(
    (await f.owner.import(key, 'grant', f.generation, new AbortController().signal)).asset.id,
  ).toBe(f.owner.list()[0]?.id);
  expect(f.files.open).toHaveBeenCalledOnce();
  await expect(f.owner.close()).rejects.toThrow('LEASE_DRAIN_FAILED');
  f.setCloseFault(false);
  await f.owner.close();
  expect(f.close.mock.calls.length).toBe(3);
});
it('rejects unsupported/oversize images without fact receipts and detects corrupted binary chunks on read', async () => {
  const f = await fixture();
  f.setSize(16 * 1024 * 1024 + 1);
  await expect(
    f.owner.import(randomUUID(), 'grant', f.generation, new AbortController().signal),
  ).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled();
  f.setData(Buffer.from('<svg>unsupported</svg>'));
  await expect(
    f.owner.import(randomUUID(), 'grant', f.generation, new AbortController().signal),
  ).rejects.toThrow();
  expect(f.owner.list()).toEqual([]);
  expect(
    f.domain.get<{ count: number }>('SELECT count(*) AS count FROM axterm_terminal_asset_receipts')
      ?.count,
  ).toBe(0);
  f.setData(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  const result = await f.owner.import(
    randomUUID(),
    'grant',
    f.generation,
    new AbortController().signal,
  );
  f.domain.transaction(() =>
    f.domain.run(
      'UPDATE terminal_background_asset_chunks SET content=? WHERE asset_id=?',
      Buffer.alloc(9, 1),
      result.asset.id,
    ),
  );
  const opened = f.owner.openStream(result.asset.id);
  await expect(
    (async () => {
      for await (const _chunk of opened.stream) {
        /* Drain the actual stream so its final checksum is verified. */
      }
    })(),
  ).rejects.toThrow();
  await opened.close();
});
it('drains an in-flight source read on withdrawal and never commits bytes after cancellation', async () => {
  const f = await fixture(),
    gate = Promise.withResolvers<void>();
  f.setGate(gate.promise);
  const imported = f.owner.import(
    randomUUID(),
    'grant',
    f.generation,
    new AbortController().signal,
  );
  await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce());
  let closed = false;
  const closing = f.owner.close().then(() => {
    closed = true;
  });
  expect(closed).toBe(false);
  gate.resolve();
  await expect(imported).rejects.toThrow();
  await closing;
  expect(
    f.domain.get<{ count: number }>('SELECT count(*) AS count FROM terminal_background_assets')
      ?.count,
  ).toBe(0);
  expect(f.close).toHaveBeenCalledOnce();
});

it('reopens the actual persisted PNG chunks and deletes them through their owner after a complete storage restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-retained-png-'));
  const path = join(home, 'product.sqlite');
  const generation = randomUUID();
  const bytes = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from('bounded-image-body'),
  ]);
  const files = {
    open: vi.fn(async (_id: string, _permission: string, signal: AbortSignal) => ({
      path: 'source.png',
      signal,
      stat: async () => ({ type: 'file', size: bytes.length }),
      read: async () => Readable.from([bytes]),
      close: async () => {},
    })),
  } as unknown as HostFiles;
  const configuration = {
    getSettings: () => ({ terminal: { visual: { background: { assetId: null } } } }),
  } as unknown as ConfigurationQueries;
  let storage = await ownedStorage(path);
  let domain = await storage.open(Schema.productDomains.terminalAssets);
  let owner = new TerminalBackgroundAssets(
    new StoredTerminalAssets(domain, (work) => domain.transaction(work)),
    files,
    configuration,
    generation,
  );
  try {
    const result = await owner.import(
      randomUUID(),
      'grant-image',
      generation,
      new AbortController().signal,
    );
    expect(result.asset).toMatchObject({
      id: expect.any(String),
      mimeType: 'image/png',
      bytes: bytes.length,
    });
    expect(files.open).toHaveBeenCalledExactlyOnceWith(
      'grant-image',
      'read',
      expect.any(AbortSignal),
    );
    await owner.close();
    await storage.close();
    storage = await ownedStorage(path);
    domain = await storage.open(Schema.productDomains.terminalAssets);
    owner = new TerminalBackgroundAssets(
      new StoredTerminalAssets(domain, (work) => domain.transaction(work)),
      files,
      configuration,
      generation,
    );
    const opened = owner.openStream(result.asset.id),
      chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    await opened.close();
    expect(Buffer.concat(chunks)).toEqual(bytes);
    owner.remove(randomUUID(), result.asset.id, result.asset.version, generation);
    expect(() => owner.openStream(result.asset.id)).toThrow();
    expect(domain.all('SELECT * FROM terminal_background_asset_chunks')).toEqual([]);
  } finally {
    await owner.close();
    await storage.close();
    await rm(home, { recursive: true, force: true });
  }
});
