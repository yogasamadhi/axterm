import { z } from 'zod';
import { valid, validRange, rcompare, satisfies, gt, prerelease } from 'semver';
import { defineDomain, domainTable, type Domain } from '@axterm/plugin-api/storage';
import type { ManagedPluginPackage } from '@axterm/plugin-api/plugins';
import {
  marketUrlsSchema,
  marketQuerySchema,
  type MarketBaseline,
  type MarketConfigurationReceipt,
  type MarketFailure,
  type MarketPage,
  type MarketQuery,
} from '@axterm/plugin-api/market';
const configurationSchema = z
  .object({
    id: z.uuid(),
    generation: z.string().min(1).max(256),
    revision: z.number().int().min(1),
    expected: z.number().int().min(0),
    urls: marketUrlsSchema,
  })
  .strict();
export const marketDomain = defineDomain({
  owner: '@axterm/plugin-market',
  name: 'plugin_market',
  version: 1,
  tables: { configurations: domainTable(configurationSchema) },
});
const localized = z.union([
  z.string().max(4096),
  z
    .record(z.string().max(32), z.string().max(4096))
    .refine((value) => Object.keys(value).length <= 32),
]);
const versionSchema = z.object({
  version: z
    .string()
    .max(128)
    .refine((v) => !!valid(v)),
  publishTimestamp: z.number().finite().nonnegative().default(0),
  source: z.discriminatedUnion('type', [
    z.object({ type: z.literal('npm'), registry: z.string().max(2048).optional() }),
    z.object({
      type: z.literal('git'),
      url: z.string().max(2048),
      commit: z.string().regex(/^[a-f0-9]{40}$/),
      path: z.string().max(512).optional(),
    }),
  ]),
  engines: z
    .object({
      axterm: z
        .string()
        .max(256)
        .refine((v) => !!validRange(v))
        .optional(),
    })
    .default({}),
});
const entrySchema = z.object({
  name: z
    .string()
    .max(214)
    .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
  title: localized.optional(),
  description: localized.optional(),
  versions: z.array(versionSchema).min(1).max(32),
});
const indexSchema = z.object({
  format: z.literal(1),
  title: localized,
  plugins: z.array(entrySchema).max(512),
});
type Index = z.infer<typeof indexSchema>;
function display(value: z.infer<typeof localized> | undefined, fallback = ''): string {
  return typeof value === 'string'
    ? value
    : (value?.en ?? Object.values(value ?? {})[0] ?? fallback);
}
function registry(value: string): string {
  const parsed = new URL(value);
  if (
    !['https:', 'http:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error();
  return parsed.href.endsWith('/') ? parsed.href : parsed.href + '/';
}
/** Injective Profile identity; shared homes must never share management command/configuration facts. */
export function marketDomainForProfile(profile: string): typeof marketDomain {
  z.string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/u)
    .parse(profile);
  const suffix = [...new TextEncoder().encode(profile)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return { ...marketDomain, name: marketDomain.name + '_' + suffix };
}
export class MarketError extends Error {
  constructor(readonly reason: MarketFailure) {
    super('MARKET_' + reason.toUpperCase().replaceAll('-', '_'));
  }
}
interface Cached {
  readonly index: Index;
  readonly fetchedAt: string;
}
interface Reading {
  readonly controller: AbortController;
  readonly task: Promise<Cached>;
  users: number;
}
/** Authoritative configuration is append-only, one atomic record includes both receipt and new value. */
export class MarketApplication {
  private queue: Promise<unknown> = Promise.resolve();
  private writes = 0;
  private fetchedClock = 0;
  private readonly cache = new Map<string, Cached>();
  private readonly errors = new Map<string, MarketFailure>();
  private readonly readings = new Map<string, Reading>();
  private closing?: Promise<void>;
  constructor(
    private readonly domain: Domain<typeof marketDomain>,
    readonly generation: string,
    private readonly runtimeVersion: string,
    private readonly inventory: () => readonly ManagedPluginPackage[],
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private configuration() {
    return [...this.domain.table('configurations').entries()]
      .map(([, row]) => row)
      .sort((a, b) => b.revision - a.revision)[0];
  }
  private assertOpen() {
    if (this.closing) throw new MarketError('closed');
  }
  snapshot(): MarketBaseline {
    this.assertOpen();
    const configuration = this.configuration();
    return {
      generation: this.generation,
      revision: configuration?.revision ?? 0,
      indexes: (configuration?.urls ?? []).map((url) => {
        const loaded = this.cache.get(url),
          error = this.errors.get(url);
        return {
          url,
          ...(loaded ? { title: display(loaded.index.title), fetchedAt: loaded.fetchedAt } : {}),
          ...(error ? { error } : {}),
        };
      }),
    };
  }
  configure(
    id: string,
    generation: string,
    expected: number,
    input: readonly string[],
  ): Promise<MarketConfigurationReceipt> {
    this.assertOpen();
    z.uuid().parse(id);
    const urls = marketUrlsSchema.parse(input);
    z.number().int().min(0).parse(expected);
    if (this.writes >= 8) return Promise.reject(new MarketError('capacity'));
    this.writes++;
    const task = this.queue.then(async () => {
      const table = this.domain.table('configurations'),
        previous = table.get(id);
      if (previous) {
        if (
          previous.generation !== generation ||
          previous.expected !== expected ||
          JSON.stringify(previous.urls) !== JSON.stringify(urls)
        )
          throw new MarketError('conflict');
        return { id, generation, revision: previous.revision };
      }
      if (generation !== this.generation) throw new MarketError('stale-generation');
      const current = this.configuration()?.revision ?? 0;
      if (expected !== current) throw new MarketError('conflict');
      if (table.size >= 2048) throw new MarketError('capacity');
      const row = { id, generation, expected, revision: current + 1, urls };
      await table.put(id, row);
      for (const [url, reading] of this.readings)
        if (!urls.includes(url)) reading.controller.abort();
      for (const url of this.cache.keys()) if (!urls.includes(url)) this.cache.delete(url);
      for (const url of this.errors.keys()) if (!urls.includes(url)) this.errors.delete(url);
      return { id, generation, revision: row.revision };
    });
    this.queue = task.catch(() => {});
    void task
      .finally(() => {
        this.writes--;
      })
      .catch(() => {});
    return task;
  }
  outcome(id: string): MarketConfigurationReceipt | undefined {
    this.assertOpen();
    z.uuid().parse(id);
    const row = this.domain.table('configurations').get(id);
    return row ? { id, generation: row.generation, revision: row.revision } : undefined;
  }
  async search(input: MarketQuery, signal: AbortSignal): Promise<MarketPage> {
    this.assertOpen();
    signal.throwIfAborted();
    const query = marketQuerySchema.parse(input);
    if (!this.snapshot().indexes.some((row) => row.url === query.url))
      throw new MarketError('unknown-index');
    const pinned = query.fetchedAt ? this.cache.get(query.url) : undefined;
    if (query.fetchedAt && (!pinned || pinned.fetchedAt !== query.fetchedAt || query.refresh))
      throw new MarketError('conflict');
    const cached = pinned ?? (await this.read(query.url, query.refresh, signal));
    signal.throwIfAborted();
    if (!this.snapshot().indexes.some((row) => row.url === query.url))
      throw new MarketError('unknown-index');
    const text = query.text.normalize('NFKC').toLowerCase().trim(),
      words = text.split(/\s+/u).filter(Boolean);
    const selected = cached.index.plugins.filter((row) => {
      const haystack = JSON.stringify([row.name, row.title, row.description])
        .normalize('NFKC')
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    const packages = this.inventory();
    const entries = selected.slice(query.offset, query.offset + query.limit).map((row) => {
      const installed = packages.find((pkg) => pkg.name === row.name),
        versions = [...row.versions].sort((a, b) => rcompare(a.version, b.version));
      const views = versions.map((value) => ({
        version: value.version,
        publishTimestamp: value.publishTimestamp,
        compatibility: value.engines.axterm
          ? satisfies(this.runtimeVersion, value.engines.axterm, { includePrerelease: true })
            ? ('compatible' as const)
            : ('incompatible' as const)
          : ('check-on-install' as const),
        install:
          value.source.type === 'npm'
            ? {
                spec: row.name + '@' + value.version,
                ...(value.source.registry ? { registry: registry(value.source.registry) } : {}),
              }
            : null,
      }));
      const preferred =
        views.find(
          (value) => value.compatibility !== 'incompatible' && !prerelease(value.version),
        ) ??
        views.find((value) => value.compatibility !== 'incompatible') ??
        views[0]!;
      return {
        name: row.name,
        title: display(row.title, row.name),
        description: display(row.description),
        versions: views,
        installation: !installed
          ? ('not-installed' as const)
          : !installed.installed
            ? ('provided' as const)
            : installed.version === preferred.version
              ? ('installed' as const)
              : valid(installed.version) && gt(preferred.version, installed.version)
                ? ('update-available' as const)
                : ('different-version' as const),
        ...(installed ? { installedVersion: installed.version } : {}),
      };
    });
    const page: MarketPage = {
      url: query.url,
      title: display(cached.index.title),
      fetchedAt: cached.fetchedAt,
      total: selected.length,
      nextOffset:
        query.offset + entries.length < selected.length ? query.offset + entries.length : null,
      entries,
    };
    if (new TextEncoder().encode(JSON.stringify(page)).byteLength > 1024 * 1024)
      throw new MarketError('capacity');
    return page;
  }
  private async read(url: string, refresh: boolean, signal: AbortSignal): Promise<Cached> {
    const cached = this.cache.get(url);
    if (!refresh && cached && Date.now() - Date.parse(cached.fetchedAt) < 600000) return cached;
    let reading = this.readings.get(url);
    if (!reading) {
      if (this.readings.size >= 4) throw new MarketError('capacity');
      const controller = new AbortController();
      const task = this.fetchIndex(url, controller.signal).then(
        (value) => {
          if (
            !controller.signal.aborted &&
            this.snapshot().indexes.some((row) => row.url === url)
          ) {
            this.cache.set(url, value);
            this.errors.delete(url);
          }
          return value;
        },
        (error) => {
          if (!this.closing && this.snapshot().indexes.some((row) => row.url === url)) {
            this.cache.delete(url);
            this.errors.set(url, error instanceof MarketError ? error.reason : 'network');
          }
          throw error;
        },
      );
      reading = { controller, task, users: 0 };
      this.readings.set(url, reading);
      void task
        .finally(() => {
          if (this.readings.get(url)?.task === task) this.readings.delete(url);
        })
        .catch(() => {});
    }
    const owned = reading;
    owned.users++;
    let abort: () => void = () => {};
    try {
      return await Promise.race([
        owned.task,
        new Promise<never>((_, reject) => {
          abort = () => reject(new MarketError('network'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', abort);
      owned.users--;
      if (!owned.users && signal.aborted) {
        owned.controller.abort();
        await owned.task.catch(() => {});
      }
    }
  }
  private async fetchIndex(url: string, signal: AbortSignal): Promise<Cached> {
    const controller = new AbortController(),
      combined = AbortSignal.any([signal, controller.signal]),
      timer = setTimeout(() => controller.abort(), 15000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancel: Promise<unknown> | undefined;
    const abort = () => {
      cancel ??= reader?.cancel().catch(() => {});
    };
    combined.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetcher(url, {
        signal: combined,
        redirect: 'error',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok || !response.body) throw new MarketError('network');
      reader = response.body.getReader();
      if (combined.aborted) abort();
      let bytes = 0;
      const parts: Uint8Array[] = [];
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new MarketError('capacity');
        parts.push(next.value);
      }
      combined.throwIfAborted();
      const buffer = new Uint8Array(bytes);
      let offset = 0;
      for (const part of parts) {
        buffer.set(part, offset);
        offset += part.length;
      }
      let index: Index;
      try {
        index = indexSchema.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)),
        );
        const names = new Set<string>();
        for (const item of index.plugins) {
          if (
            names.has(item.name) ||
            new Set(item.versions.map((v) => v.version)).size !== item.versions.length
          )
            throw new Error();
          names.add(item.name);
          for (const version of item.versions)
            if (version.source.type === 'npm' && version.source.registry)
              registry(version.source.registry);
        }
      } catch {
        throw new MarketError('invalid-index');
      }
      this.fetchedClock = Math.max(Date.now(), this.fetchedClock + 1);
      return { index, fetchedAt: new Date(this.fetchedClock).toISOString() };
    } catch (error) {
      throw error instanceof MarketError ? error : new MarketError('network');
    } finally {
      clearTimeout(timer);
      combined.removeEventListener('abort', abort);
      await cancel;
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      for (const value of this.readings.values()) value.controller.abort();
      await Promise.allSettled([
        this.queue,
        ...[...this.readings.values()].map((value) => value.task),
      ]);
      this.cache.clear();
      this.errors.clear();
      await this.domain.close();
    })());
  }
}
