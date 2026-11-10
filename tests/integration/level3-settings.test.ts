import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import * as Configuration from '../../packages/plugins/configuration/src/index.ts';
import * as Catalog from '../../packages/plugins/catalog/src/index.ts';
import { CatalogStorage } from '../../packages/plugins/catalog/src/adapters/catalog-storage.ts';
import { ConnectionHistoryRepository } from '../../packages/plugins/catalog/src/adapters/connection-history-repository.ts';
import { Generation2SettingsWitness as ProductRepository } from '../fixtures/migration/generation2-settings.ts';
import type { SettingsUpdate, SettingsBaseline } from '@axterm/plugin-api/configuration';
import { SettingsProjection } from '../../packages/plugins/configuration/src/client/projection.ts';

const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
});
async function boot() {
  const ctx = new Context();
  contexts.push(ctx);
  ctx.provide('runtimeIdentity', {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: 'headless',
    appVersion: '0.10.0',
  });
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const facility = ctx.storage.domain;
  const open = facility.open.bind(facility);
  const handles = new Map<string, RelationalDomain>();
  vi.spyOn(facility, 'open').mockImplementation(async (spec) => {
    const handle = await open(spec);
    if ('participant' in handle) handles.set(spec.name, handle as unknown as RelationalDomain);
    return handle;
  });
  const owner = ctx.plugin(Configuration);
  await owner;
  return { ctx, owner, handles, controller: ctx.configurationController };
}

it('retains the existing settings defaults and patch behavior through owned relational storage', async () => {
  const { controller } = await boot();
  {
    const repository = new ProductRepository();
    const retained = () => {
      const settings = controller.getSettings();
      const { importRevision, ...workspace } = settings.workspace;
      expect(importRevision).toBe(0);
      return { ...settings, workspace };
    };
    expect(retained()).toEqual(repository.getSettings());
    for (const patch of [
      { appearance: { language: 'en' as const, theme: 'light' as const } },
      { workspace: { showTabNumber: false, switchTabOnHover: true } },
      { terminal: { autoReconnectTerminal: true, dragDropBehavior: 'path-insert' as const } },
      { privacy: { hideAddresses: true } },
    ]) {
      const etag = `"v${repository.getSettings().version}"`;
      const previous = repository.updateSettings(patch, etag);
      const receipt = controller.updateSettings(randomUUID(), patch, etag);
      expect(retained()).toEqual(previous);
      expect(receipt.version).toBe(previous.version);
    }
  }
});

it('rolls back settings, both history owners, receipts and outbox when a later owner fails, then retries atomically', async () => {
  const { ctx, handles, controller } = await boot();
  const catalogOwner = ctx.plugin(Catalog);
  await catalogOwner;
  const catalog = handles.get('catalog')!;
  const configuration = handles.get('configuration')!;
  const terminal = await ctx.storage.domain.open(Schema.productDomains.terminals);
  const hostReceipt = ctx.catalogController.createHost(randomUUID(), {
    name: 'History target',
    hostname: 'fixture.example',
    username: 'operator',
  });
  const host = ctx.catalog.getHost(hostReceipt.ids[0]!);
  const connectionHistory = new ConnectionHistoryRepository(new CatalogStorage(catalog));
  connectionHistory.record({ host, persistedHostId: host.id });
  terminal.run(
    'INSERT INTO command_history(id,command_text,use_count,last_used_at,created_at,updated_at,version) VALUES (?,?,1,?,?,?,1)',
    randomUUID(),
    'fixture command',
    '2026-11-05',
    '2026-11-05',
    '2026-11-05',
  );
  let fail = true;
  const release = ctx.configurationHistory.register('command-history', {
    participant: terminal.participant,
    purge: () => {
      const deletedCount = Number(terminal.run('DELETE FROM command_history').changes);
      terminal.appendEvent('command-history.cleared', { deletedCount });
      if (fail) throw new Error('fixture-private-failure');
      return { deletedCount };
    },
  });
  const changed = vi.fn();
  catalog.subscribe(changed);
  configuration.subscribe(changed);
  terminal.subscribe(changed);
  const cursor = catalog.cursor();
  const key = randomUUID();
  const patch = { privacy: { connectionHistoryEnabled: false, commandHistoryEnabled: false } };
  const previous = controller.getSettings();
  expect(() => controller.updateSettings(key, patch, '"v1"')).toThrowError(
    expect.objectContaining({ details: { reason: 'unavailable' } }),
  );
  expect(controller.getSettings()).toEqual(previous);
  expect(catalog.all('SELECT id FROM recent_connections')).toHaveLength(1);
  expect(terminal.all('SELECT id FROM command_history')).toHaveLength(1);
  expect(catalog.cursor()).toBe(cursor);
  expect(configuration.events(0)).toEqual([]);
  expect(terminal.events(0)).toEqual([]);
  expect(configuration.all('SELECT command_id FROM axterm_configuration_command_receipts')).toEqual(
    [],
  );
  expect(changed).not.toHaveBeenCalled();
  fail = false;
  const receipt = controller.updateSettings(key, patch, '"v1"');
  expect(catalog.all('SELECT id FROM recent_connections')).toEqual([]);
  expect(terminal.all('SELECT id FROM command_history')).toEqual([]);
  expect(controller.getSettings().privacy).toMatchObject(patch.privacy);
  expect(changed).toHaveBeenCalled();
  await release();
  await catalogOwner.dispose();
  // A receipt replay reads its outcome and cannot repeat a purge after owners have gone.
  expect(controller.updateSettings(key, patch, '"v1"')).toEqual(receipt);
});

it('refuses a history purge while its owner is still draining and preserves settings and receipts', async () => {
  const { ctx, controller, handles } = await boot();
  const terminal = await ctx.storage.domain.open(Schema.productDomains.terminals);
  const caller = ctx.plugin({ inject: ['configurationHistory'], apply() {} });
  await caller;
  const purge = vi.fn(() => ({ deletedCount: 0 }));
  caller.ctx.configurationHistory.register('command-history', {
    participant: terminal.participant,
    purge,
  });
  const draining = Promise.withResolvers<void>();
  caller.ctx.effect(() => () => draining.promise);
  const before = controller.getSettings();
  const unloading = caller.dispose();
  try {
    expect(() =>
      controller.updateSettings(
        randomUUID(),
        { privacy: { commandHistoryEnabled: false } },
        '"v1"',
      ),
    ).toThrowError(expect.objectContaining({ details: { reason: 'unavailable' } }));
    expect(purge).not.toHaveBeenCalled();
    expect(controller.getSettings()).toEqual(before);
    expect(handles.get('configuration')!.events(0)).toEqual([]);
  } finally {
    draining.resolve();
    await unloading;
  }
});

it('rejects missing history participants, stale versions, conflicting command keys and unloaded service handles', async () => {
  const { owner, controller, handles } = await boot();
  expect(() =>
    controller.updateSettings(
      randomUUID(),
      { privacy: { connectionHistoryEnabled: false } },
      '"v1"',
    ),
  ).toThrowError(expect.objectContaining({ details: { reason: 'unavailable' } }));
  expect(controller.getSettings().version).toBe(1);
  expect(handles.get('configuration')!.events(0)).toEqual([]);
  expect(() =>
    controller.updateSettings(randomUUID(), { appearance: { theme: 'light' } }, undefined),
  ).toThrowError(expect.objectContaining({ details: { reason: 'precondition-required' } }));
  const key = randomUUID();
  const patch = { appearance: { theme: 'light' as const } };
  const receipt = controller.updateSettings(key, patch, '"v1"');
  expect(controller.updateSettings(key, patch, '"v1"')).toEqual(receipt);
  expect(() =>
    controller.updateSettings(key, { appearance: { theme: 'dark' } }, '"v1"'),
  ).toThrowError(expect.objectContaining({ details: { reason: 'conflict' } }));
  expect(() => controller.updateSettings(randomUUID(), patch, '"v1"')).toThrowError(
    expect.objectContaining({ details: { reason: 'precondition-failed' } }),
  );
  await owner.dispose();
  expect(() => controller.getSettings()).toThrowError(
    expect.objectContaining({ details: { reason: 'closed' } }),
  );
});

async function readSettings(
  iterator: AsyncIterator<SettingsUpdate>,
  projection: SettingsProjection,
): Promise<{ baseline: SettingsBaseline; chunks: number }> {
  let chunks = 0;
  for (let count = 0; count < 10_000; count++) {
    const frame = await iterator.next();
    expect(frame.done).toBe(false);
    if (frame.value!.type === 'chunk') chunks++;
    const baseline = projection.accept(frame.value!);
    if (baseline) return { baseline, chunks };
  }
  throw new Error('No settings commit');
}
it('streams complete settings and bounded Unicode replacement fragments, then drains a pending watch on unload', async () => {
  const { controller, owner } = await boot();
  const iterator = controller.watchSettings(new AbortController().signal)[Symbol.asyncIterator]();
  const projection = new SettingsProjection();
  const initial = await readSettings(iterator, projection);
  const bookmarks = Array.from({ length: 8 }, () => ({
    id: randomUUID(),
    hostId: null,
    path: '/' + '界😀'.repeat(1_000),
  }));
  const receipt = controller.updateSettings(
    randomUUID(),
    { fileManager: { remoteAddressBookmarks: bookmarks } },
    '"v1"',
  );
  const replacement = await readSettings(iterator, projection);
  expect(replacement.chunks).toBeGreaterThan(1);
  expect(replacement.baseline.cursor).toBe(receipt.cursor);
  expect(replacement.baseline.generation).toBe(initial.baseline.generation);
  expect(replacement.baseline.settings.fileManager.remoteAddressBookmarks).toEqual(bookmarks);
  expect(Object.isFrozen(replacement.baseline.settings.fileManager.remoteAddressBookmarks)).toBe(
    true,
  );
  const pending = iterator.next();
  await owner.dispose();
  expect((await pending).done).toBe(true);
});
it('rejects malformed settings fragments and releases never-read watches when their signal ends', async () => {
  const { controller } = await boot();
  const abort = new AbortController();
  const watches = Array.from({ length: 64 }, () =>
    controller.watchSettings(abort.signal)[Symbol.asyncIterator](),
  );
  expect(() => controller.watchSettings(new AbortController().signal)).toThrowError(
    expect.objectContaining({ details: { reason: 'capacity' } }),
  );
  abort.abort();
  for (const watch of watches) expect((await watch.next()).done).toBe(true);
  const begin: SettingsUpdate = {
    type: 'begin',
    mode: 'baseline',
    generation: 'fixture',
    cursor: 0,
  };
  for (const invalid of [
    { type: 'commit', cursor: 0 },
    { type: 'chunk', offset: 1, text: '{}', final: true },
    { type: 'chunk', offset: 0, text: 'x'.repeat(16_385), final: true },
    begin,
  ] as SettingsUpdate[]) {
    const projection = new SettingsProjection();
    projection.accept(begin);
    expect(() => projection.accept(invalid)).toThrow('SETTINGS_PROJECTION_INVALID');
  }
});

it('commits per-window presentation versions and idempotent receipts in the owned settings transaction', async () => {
  const { controller, ctx } = await boot(),
    generation = ctx.runtimeIdentity.generation;
  const first = controller.bindWorkspacePresentation('desktop_0'),
    second = controller.bindWorkspacePresentation('desktop_1');
  const id = randomUUID(),
    input = {
      section: 'sessions',
      sidebarOpen: false,
      activeTabId: id,
      tabs: [{ id, kind: 'terminal', caption: 'CLI title', title: 'CLI title' }],
    },
    key = randomUUID();
  const receipt = await controller.saveWorkspacePresentation(
    key,
    'desktop_0',
    input,
    0,
    generation,
    first.importRevision,
  );
  expect(
    await controller.saveWorkspacePresentation(
      key,
      'desktop_0',
      input,
      0,
      generation,
      first.importRevision,
    ),
  ).toEqual(receipt);
  await controller.saveWorkspacePresentation(
    randomUUID(),
    'desktop_1',
    { ...input, sidebarOpen: true },
    0,
    generation,
    first.importRevision,
  );
  const records = controller.getSettings().workspace.presentations!;
  expect(records[first.key]?.presentation.sidebarOpen).toBe(false);
  expect(records[second.key]?.presentation.sidebarOpen).toBe(true);
  await expect(
    controller.saveWorkspacePresentation(
      randomUUID(),
      'desktop_0',
      input,
      0,
      generation,
      first.importRevision,
    ),
  ).rejects.toMatchObject({
    code: 'configuration/failure',
    details: { reason: 'precondition-failed' },
  });
  await expect(
    controller.saveWorkspacePresentation(
      randomUUID(),
      'desktop_0',
      input,
      1,
      randomUUID(),
      first.importRevision,
    ),
  ).rejects.toMatchObject({ code: 'configuration/failure', details: { reason: 'conflict' } });
  expect(controller.getSettings().workspace.presentations?.[first.key]?.version).toBe(1);
});

it('resets physical and legacy wheel overrides in one owned receipt without rebasing a retry', async () => {
  const { ctx, controller } = await boot(),
    generation = ctx.runtimeIdentity.generation;
  controller.updateSettings(
    randomUUID(),
    {
      shortcuts: { bindings: { app_newTab: ['alt+z'], terminal_zoominTerminal: ['meta+wheelup'] } },
    },
    '"v1"',
  );
  const document = { schemaVersion: 2 as const, profiles: { 'desktop:macos': {} } },
    key = randomUUID(),
    receipt = controller.setShortcutDocument(key, document, '"v2"', generation, true);
  const accepted = controller.getSettings();
  expect(accepted.version).toBe(3);
  expect(accepted.shortcuts.bindings).toEqual({ app_newTab: ['alt+z'] });
  expect(accepted.shortcuts.document).toEqual(document);
  expect(accepted).not.toHaveProperty('resetTerminalGestures');
  controller.updateSettings(randomUUID(), { appearance: { theme: 'light' } }, '"v3"');
  expect(controller.setShortcutDocument(key, document, '"v2"', generation, true)).toEqual(receipt);
  expect(controller.getSettings().version).toBe(4);
  expect(() => controller.setShortcutDocument(key, document, '"v2"', randomUUID(), true)).toThrow();
  expect(controller.getSettings().version).toBe(4);
});
