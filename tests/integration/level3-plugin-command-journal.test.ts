import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Sqlite from '@axterm/infra-storage-sqlite';
import * as Domains from '@axterm/infra-storage-domain';
import type { PluginManagerService } from '@axterm/plugin-api/host';
import type { PluginCommandInput, PluginManagementSnapshot } from '@axterm/plugin-api/plugins';
import {
  managementDomain,
  managementDomainForProfile,
  PluginManagement,
} from '../../packages/plugins/plugins/src/application.ts';
import { PluginObservation } from '../../packages/plugins/plugins/src/observation.ts';
import { recordTableName } from '../../packages/infra/storage-sqlite/src/schema.ts';

const contexts: Context[] = [],
  directories: string[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const changed = { changed: true, application: 'applied' as const };
function manager(overrides: Partial<PluginManagerService> = {}): PluginManagerService {
  return {
    inspect: async () => {
      throw new Error('Unused inspection');
    },
    list: () => [],
    entries: () => [],
    install: async () => changed,
    remove: async () => changed,
    setBundleEnabled: async () => changed,
    setPluginEnabled: async () => changed,
    allowVersion: async () => changed,
    pendingBuilds: async () => [],
    approveBuilds: async () => changed,
    transactions: async () => [],
    inspectTasks: () => ({ active: false }),
    repair: async () => changed,
    ...overrides,
  };
}
async function setup(port = manager()) {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-plugin-journal-'));
  directories.push(directory);
  const path = join(directory, 'records.sqlite'),
    ctx = new Context();
  contexts.push(ctx);
  await ctx.plugin(Storage);
  await ctx.plugin(Sqlite, { path, journalMode: 'wal' });
  await ctx.plugin(Domains, { backend: 'sqlite' });
  const domain = await ctx.storage.domain.open(managementDomain);
  const app = new PluginManagement(port, domain, 'current-generation');
  await app.initialize();
  return { ctx, domain, app, path };
}
const install: PluginCommandInput = {
  operation: 'install',
  spec: '@fixture/owned@1.0.0',
  enabled: true,
  replace: false,
};

it('durably reserves before package IO and reconciles duplicate or lost acknowledgements without repeating work', async () => {
  let calls = 0,
    persisted: unknown;
  const finish = Promise.withResolvers<void>();
  const port = manager({
    install: async () => {
      calls++;
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        persisted = JSON.parse(
          (
            db
              .prepare(
                `SELECT value FROM "${recordTableName('plugin_management', 'commands')}" WHERE key=?`,
              )
              .get(id) as { value: string }
          ).value,
        );
      } finally {
        db.close();
      }
      await finish.promise;
      return changed;
    },
  });
  const { app, path } = await setup(port),
    id = randomUUID();
  const request = { ...install },
    admission = app.execute(id, 'current-generation', request);
  request.spec = '@fixture/changed-after-admission@2.0.0';
  expect(await admission).toMatchObject({ id, status: 'running' });
  expect(persisted).toMatchObject({ request: install, receipt: { id, status: 'running' } });
  expect((await app.execute(id, 'current-generation', install)).status).toBe('running');
  await expect(
    app.execute(id, 'current-generation', { ...install, enabled: false }),
  ).rejects.toMatchObject({ reason: 'conflict' });
  expect(calls).toBe(1);
  finish.resolve();
  await expect.poll(() => app.outcome(id).receipt?.status).toBe('completed');
  expect((await app.execute(id, 'current-generation', install)).status).toBe('completed');
  expect(calls).toBe(1);
  await app.close();
});

it('marks persisted unfinished intents interrupted on reopening and refuses stale new commands without replay', async () => {
  const installCall = vi.fn(async () => changed);
  const { ctx, app, domain } = await setup(manager({ install: installCall }));
  const id = randomUUID(),
    now = new Date().toISOString();
  await domain.table('commands').put(id, {
    request: install,
    receipt: {
      id,
      generation: 'old-generation',
      operation: 'install',
      status: 'running',
      createdAt: now,
      updatedAt: now,
    },
  });
  await app.close();
  const reopened = await ctx.storage.domain.open(managementDomain),
    next = new PluginManagement(manager({ install: installCall }), reopened, 'next-generation');
  await next.initialize();
  expect(next.outcome(id).receipt).toMatchObject({
    status: 'interrupted',
    reason: 'interrupted',
    generation: 'old-generation',
  });
  expect((await next.execute(id, 'old-generation', install)).status).toBe('interrupted');
  await expect(next.execute(randomUUID(), 'old-generation', install)).rejects.toMatchObject({
    reason: 'stale-generation',
  });
  expect(installCall).not.toHaveBeenCalled();
  await next.close();
});

it('cancels owned IO on unload and waits for actual package drain before releasing storage', async () => {
  const cancellation = Promise.withResolvers<void>(),
    drained = Promise.withResolvers<void>();
  const { app, domain } = await setup(
    manager({
      install: async (_spec, options) => {
        options!.signal!.addEventListener('abort', () => cancellation.resolve(), { once: true });
        await cancellation.promise;
        await drained.promise;
        throw Object.assign(new Error('Controlled cancellation'), { reason: 'cancelled' });
      },
    }),
  );
  const id = randomUUID();
  await app.execute(id, 'current-generation', install);
  let closed = false;
  const closing = app.close().then(() => {
    closed = true;
  });
  await cancellation.promise;
  expect(closed).toBe(false);
  expect(domain.table('commands').get(id)?.receipt.status).toBe('running');
  drained.resolve();
  await closing;
  expect(closed).toBe(true);
  await expect(app.execute(randomUUID(), 'current-generation', install)).rejects.toMatchObject({
    reason: 'closed',
  });
});

it('quarantines a successful side effect whose receipt cannot be persisted and never replays it after recovery', async () => {
  const io = vi.fn(async () => changed),
    { app, ctx, domain } = await setup(manager({ install: io }));
  const table = domain.table('commands'),
    put = table.put.bind(table);
  vi.spyOn(table, 'put').mockImplementation(async (id, row) => {
    if (row.receipt.status === 'completed') throw new Error('Controlled durable-write failure');
    return put(id, row);
  });
  const id = randomUUID();
  await app.execute(id, 'current-generation', install);
  await expect.poll(() => io.mock.calls.length).toBe(1);
  await expect.poll(() => app.active()).toBe(true);
  await expect(app.execute(randomUUID(), 'current-generation', install)).rejects.toMatchObject({
    reason: 'unavailable',
  });
  expect(app.outcome(id).receipt?.status).toBe('running');
  await expect(app.close()).rejects.toMatchObject({ reason: 'unavailable' });
  const recovered = new PluginManagement(
    manager({ install: io }),
    await ctx.storage.domain.open(managementDomain),
    'recovered-generation',
  );
  await recovered.initialize();
  expect(recovered.outcome(id).receipt?.status).toBe('interrupted');
  expect(io).toHaveBeenCalledTimes(1);
  await recovered.close();
});

it('keeps command facts observable without queueing metadata reads behind active package work', async () => {
  const pendingBuilds = vi.fn(async () => []);
  const { app } = await setup(manager({ inspectTasks: () => ({ active: true }), pendingBuilds }));
  expect(await app.snapshot()).toEqual({
    generation: 'current-generation',
    inventory: null,
    commands: [],
  });
  expect(pendingBuilds).not.toHaveBeenCalled();
  await app.close();
});
it('coalesces simultaneous inventory reads and invalidates that shared snapshot during package work', async () => {
  let active = false;
  const builds = Promise.withResolvers<readonly never[]>(),
    pendingBuilds = vi.fn(() => builds.promise);
  const { app } = await setup(manager({ pendingBuilds, inspectTasks: () => ({ active }) }));
  const reads = Array.from({ length: 10 }, () => app.snapshot());
  expect(pendingBuilds).toHaveBeenCalledTimes(1);
  builds.resolve([]);
  await Promise.all(reads);
  await app.snapshot();
  expect(pendingBuilds).toHaveBeenCalledTimes(1);
  active = true;
  expect((await app.snapshot()).inventory).toBe(null);
  active = false;
  await app.snapshot();
  expect(pendingBuilds).toHaveBeenCalledTimes(2);
  await app.close();
});

it('releases unstarted observations and aborts waiting observations deterministically', async () => {
  const snapshot: PluginManagementSnapshot = {
    generation: 'generation',
    inventory: { packages: [], entries: [], builds: [], transactions: [] },
    commands: [],
  };
  const observations = new PluginObservation(async () => snapshot);
  for (let count = 0; count < 32; count++)
    await observations.watch(new AbortController().signal)[Symbol.asyncIterator]().return!();
  const abort = new AbortController(),
    iterator = observations.watch(abort.signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ type: 'baseline', cursor: 0 });
  const waiting = iterator.next();
  await expect(iterator.next()).rejects.toMatchObject({
    code: 'plugins/failure',
    details: { reason: 'conflict' },
  });
  abort.abort();
  expect((await waiting).done).toBe(true);
  await observations.close();
  expect(() => observations.watch(new AbortController().signal)).toThrow();
});

it('keeps simultaneous Profile command journals independent in one shared SQLite provider', async () => {
  const { ctx } = await setup();
  const finish = Promise.withResolvers<void>();
  const desktop = new PluginManagement(
    manager({
      install: async () => {
        await finish.promise;
        return changed;
      },
    }),
    await ctx.storage.domain.open(managementDomainForProfile('desktop')),
    'desktop-generation',
  );
  const web = new PluginManagement(
    manager(),
    await ctx.storage.domain.open(managementDomainForProfile('web')),
    'web-generation',
  );
  const id = randomUUID();
  try {
    await desktop.initialize();
    expect((await desktop.execute(id, 'desktop-generation', install)).status).toBe('running');
    await web.initialize();
    expect(web.outcome(id)).toEqual({ status: 'missing' });
    expect(desktop.outcome(id).receipt?.status).toBe('running');
    finish.resolve();
    await expect.poll(() => desktop.outcome(id).receipt?.status).toBe('completed');
  } finally {
    finish.resolve();
    await desktop.close();
    await web.close();
  }
  expect(managementDomainForProfile('a-b').name).not.toBe(managementDomainForProfile('a_b').name);
  expect(managementDomainForProfile('Web').name).not.toBe(managementDomainForProfile('web').name);
});
