import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Sqlite from '@axterm/infra-storage-sqlite';
import * as Domains from '@axterm/infra-storage-domain';
import {
  MarketApplication,
  marketDomain,
  marketDomainForProfile,
} from '../../packages/plugins/market/src/application.ts';
const owners: Context[] = [],
  directories: string[] = [],
  apps: MarketApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const ctx of owners.splice(0).reverse()) await ctx.fiber.dispose();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(fetcher: typeof fetch = fetch) {
  const dir = await mkdtemp(join(tmpdir(), 'axterm-market-owner-'));
  directories.push(dir);
  const ctx = new Context();
  owners.push(ctx);
  await ctx.plugin(Storage);
  await ctx.plugin(Sqlite, { path: join(dir, 'records.sqlite'), journalMode: 'wal' });
  await ctx.plugin(Domains, { backend: 'sqlite' });
  const domain = await ctx.storage.domain.open(marketDomain);
  const app = new MarketApplication(
    domain,
    'generation',
    '0.10.0',
    () => [
      { name: '@fixture/plugin', version: '1.0.0', installed: true, enabled: true, bundle: true },
    ],
    fetcher,
  );
  apps.push(app);
  return { app, ctx, domain };
}
const url = 'http://127.0.0.1:32101/index.json';
const input = { url, text: '', offset: 0, limit: 25, refresh: false };
const fixture = {
  format: 1,
  title: 'Real index',
  plugins: [
    {
      name: '@fixture/plugin',
      title: { en: 'Fixture', ja: '実例' },
      versions: [
        {
          version: '2.0.0',
          publishTimestamp: 20,
          engines: { axterm: '>=99' },
          source: { type: 'npm', registry: 'http://127.0.0.1:32101/registry/' },
        },
        {
          version: '1.1.0',
          publishTimestamp: 10,
          engines: { axterm: '^0.10.0' },
          source: { type: 'npm', registry: 'http://127.0.0.1:32101/registry/' },
        },
      ],
    },
  ],
};
it('starts empty without network, persists atomic configuration receipts, rejects stale windows and reopens without fetching', async () => {
  const fetching = vi.fn<typeof fetch>();
  const { app, ctx } = await setup(fetching);
  expect(app.snapshot().indexes).toEqual([]);
  expect(fetching).not.toHaveBeenCalled();
  const id = randomUUID();
  const receipt = await app.configure(id, 'generation', 0, [url]);
  expect(await app.configure(id, 'generation', 0, [url])).toEqual(receipt);
  expect(app.outcome(id)).toEqual(receipt);
  await expect(app.configure(id, 'generation', 0, [])).rejects.toMatchObject({
    reason: 'conflict',
  });
  await expect(app.configure(randomUUID(), 'old-generation', 1, [])).rejects.toMatchObject({
    reason: 'stale-generation',
  });
  await expect(app.configure(randomUUID(), 'generation', 0, [])).rejects.toMatchObject({
    reason: 'conflict',
  });
  expect(app.snapshot().revision).toBe(1);
  await app.close();
  const reopened = new MarketApplication(
    await ctx.storage.domain.open(marketDomain),
    'new-generation',
    '0.10.0',
    () => [],
    fetching,
  );
  apps.push(reopened);
  expect(reopened.outcome(id)).toEqual(receipt);
  expect(reopened.snapshot().indexes[0]?.url).toBe(url);
  expect(fetching).not.toHaveBeenCalled();
});
it('queries only configured indexes, reports exact registry/version and actual installed status without package IO', async () => {
  const fetching = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(fixture)));
  const { app } = await setup(fetching);
  await expect(app.search(input, new AbortController().signal)).rejects.toMatchObject({
    reason: 'unknown-index',
  });
  expect(fetching).not.toHaveBeenCalled();
  await app.configure(randomUUID(), 'generation', 0, [url]);
  const page = await app.search(input, new AbortController().signal);
  expect(page.entries[0]).toMatchObject({
    name: '@fixture/plugin',
    installation: 'update-available',
    installedVersion: '1.0.0',
    versions: [
      { version: '2.0.0', compatibility: 'incompatible' },
      {
        version: '1.1.0',
        compatibility: 'compatible',
        install: { spec: '@fixture/plugin@1.1.0', registry: 'http://127.0.0.1:32101/registry/' },
      },
    ],
  });
  expect((await app.search({ ...input, text: '実例' }, new AbortController().signal)).total).toBe(
    1,
  );
  expect(fetching).toHaveBeenCalledTimes(1);
  expect(fetching.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
});
it.each(['duplicates', 'registry', 'utf8', 'large'])(
  'rejects invalid or oversized index %s with bounded redacted failures',
  async (mode) => {
    const invalid = structuredClone(fixture);
    if (mode === 'duplicates') invalid.plugins.push(invalid.plugins[0]!);
    if (mode === 'registry')
      invalid.plugins[0]!.versions[0]!.source.registry = 'https://private:secret@example.test/';
    const fetching = vi.fn<typeof fetch>(
      async () =>
        new Response(
          mode === 'utf8'
            ? new Uint8Array([0xff])
            : mode === 'large'
              ? 'x'.repeat(2 * 1024 * 1024 + 1)
              : JSON.stringify(invalid),
        ),
    );
    const { app } = await setup(fetching);
    await app.configure(randomUUID(), 'generation', 0, [url]);
    await expect(app.search(input, new AbortController().signal)).rejects.toMatchObject({
      reason: mode === 'large' ? 'capacity' : 'invalid-index',
    });
    expect(JSON.stringify(app.snapshot())).not.toContain('secret');
  },
);
it('coalesces reads while cancellation of one waiter leaves another owner active, keeps the shared body until consumption', async () => {
  let body: ReadableStreamDefaultController<Uint8Array> | undefined,
    canceled = 0;
  const fetching = vi.fn<typeof fetch>(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
          },
          async cancel() {
            await new Promise((done) => setTimeout(done, 30));
            canceled++;
          },
        }),
      ),
  );
  const { app } = await setup(fetching);
  await app.configure(randomUUID(), 'generation', 0, [url]);
  const first = new AbortController(),
    second = new AbortController();
  const one = app.search(input, first.signal);
  void one.catch(() => {});
  const two = app.search(input, second.signal);
  void two.catch(() => {});
  await vi.waitFor(() => expect(fetching).toHaveBeenCalledTimes(1));
  first.abort();
  await expect(one).rejects.toMatchObject({ reason: 'network' });
  expect(canceled).toBe(0);
  body!.enqueue(new TextEncoder().encode(JSON.stringify(fixture)));
  body!.close();
  expect((await two).total).toBe(1);
  expect(canceled).toBe(0);
});

it('cancels and joins a blocked response body before releasing the domain and refuses later reads', async () => {
  let finished = false;
  const fetching = vi.fn<typeof fetch>(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async cancel() {
            await new Promise((done) => setTimeout(done, 30));
            finished = true;
          },
        }),
      ),
  );
  const { app } = await setup(fetching);
  await app.configure(randomUUID(), 'generation', 0, [url]);
  const pending = app.search(input, new AbortController().signal);
  void pending.catch(() => {});
  await vi.waitFor(() => expect(fetching).toHaveBeenCalledTimes(1));
  await app.close();
  expect(finished).toBe(true);
  await expect(pending).rejects.toMatchObject({ reason: 'network' });
  expect(() => app.snapshot()).toThrow('MARKET_CLOSED');
  await expect(app.search(input, new AbortController().signal)).rejects.toMatchObject({
    reason: 'closed',
  });
});

it('prefers a compatible stable version for installed status while still listing prereleases', async () => {
  const index = structuredClone(fixture);
  index.plugins[0]!.versions[0] = {
    version: '1.1.0-beta.1',
    publishTimestamp: 30,
    engines: { axterm: '^0.10.0' },
    source: { type: 'npm', registry: 'http://127.0.0.1:32101/registry/' },
  };
  index.plugins[0]!.versions[1]!.version = '1.0.0';
  const { app } = await setup(async () => new Response(JSON.stringify(index)));
  await app.configure(randomUUID(), 'generation', 0, [url]);
  const page = await app.search(input, new AbortController().signal);
  expect(page.entries[0]?.installation).toBe('installed');
  expect(page.entries[0]?.versions[0]?.version).toBe('1.1.0-beta.1');
});

it('pins later pages to the cached document and rejects a replaced page identity', async () => {
  let version = 0;
  const { app } = await setup(
    async () => new Response(JSON.stringify({ ...fixture, title: 'Snapshot ' + ++version })),
  );
  await app.configure(randomUUID(), 'generation', 0, [url]);
  const first = await app.search(input, new AbortController().signal);
  const pinned = await app.search(
    { ...input, fetchedAt: first.fetchedAt },
    new AbortController().signal,
  );
  expect(pinned.title).toBe(first.title);

  const replacement = await app.search({ ...input, refresh: true }, new AbortController().signal);
  expect(replacement.fetchedAt).not.toBe(first.fetchedAt);
  await expect(
    app.search({ ...input, fetchedAt: first.fetchedAt }, new AbortController().signal),
  ).rejects.toMatchObject({ reason: 'conflict' });
});

it('isolates simultaneous Profile index configuration in shared storage without network requests', async () => {
  const fetching = vi.fn<typeof fetch>();
  const { ctx } = await setup(fetching);
  const desktop = new MarketApplication(
    await ctx.storage.domain.open(marketDomainForProfile('desktop')),
    'desktop',
    '0.10.0',
    () => [],
    fetching,
  );
  const web = new MarketApplication(
    await ctx.storage.domain.open(marketDomainForProfile('web')),
    'web',
    '0.10.0',
    () => [],
    fetching,
  );
  apps.push(desktop, web);
  await Promise.all([
    desktop.configure(randomUUID(), 'desktop', 0, [url]),
    web.configure(randomUUID(), 'web', 0, ['http://127.0.0.1:32102/index.json']),
  ]);
  expect(desktop.snapshot().indexes.map((value) => value.url)).toEqual([url]);
  expect(web.snapshot().indexes.map((value) => value.url)).toEqual([
    'http://127.0.0.1:32102/index.json',
  ]);
  expect(fetching).not.toHaveBeenCalled();
});
