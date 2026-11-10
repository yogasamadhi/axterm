import type {} from '../../packages/infra/remote-access/src/index.ts';
import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';
import DesktopTasks from '../../packages/plugins/desktop/src/tasks.ts';
import * as Catalog from '../../packages/plugins/catalog/src/index.ts';
import * as Configuration from '../../packages/plugins/configuration/src/index.ts';
import { createTerminalAssets } from '../../packages/plugins/terminals/src/assets.ts';
import * as Facts from '../../packages/plugins/terminals/src/facts.ts';
import * as Connections from '../../packages/plugins/connections/src/index.ts';
import * as Automation from '../../packages/plugins/automation/src/index.ts';

import { createManagedImportFixture } from '../support/level3-managed-import-fixture.ts';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
export async function configurationFixture(files = false) {
  const managed = files ? await createManagedImportFixture() : undefined;
  const ctx = managed?.ctx ?? new Context();
  cleanups.push(managed ? managed.close : () => ctx.fiber.dispose());
  if (managed) ctx.provide('files', managed.files);
  else
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
  await ctx.plugin(MemoryCredentials);
  await ctx.plugin(DesktopTasks);
  const handles = new Map<string, RelationalDomain>();
  const open = ctx.storage.domain.open.bind(ctx.storage.domain);
  vi.spyOn(ctx.storage.domain, 'open').mockImplementation(async (spec) => {
    const value = await open(spec);
    if ('participant' in value) handles.set(spec.name, value as unknown as RelationalDomain);
    return value;
  });
  await ctx.plugin(Catalog);
  const owner = ctx.plugin(Configuration, { profile: 'portable-fixture' });
  await owner;
  const execute = vi.fn();
  ctx.provide('terminals', {
    executeCommand: async () => {},
    addOutputObserver: () => () => {},
    insertText: execute,
    registerExternal() {
      throw new Error('No terminal should open');
    },
    enqueueStartupSequence: execute,
    list: () => [],
    workingDirectory: () => {
      throw new Error('No terminal is active');
    },
    recentOutput: () => {
      throw new Error('No terminal is active');
    },
    get() {
      throw new Error('No terminal is active');
    },
    close: async () => {},
    resourceCount: () => 0,
  });
  await ctx.plugin(Facts);
  await ctx.plugin(Connections);
  const assets = managed ? await createTerminalAssets(ctx) : undefined;
  await ctx.plugin(Automation, { profile: 'portable-fixture' });
  await vi.waitFor(() => expect(ctx.get('configurationPortable')).toBeDefined());
  return {
    onClose: (close: () => Promise<unknown>) => {
      cleanups.push(close);
    },
    ctx,
    managed,
    assets,
    handles,
    execute,
    owner,
    app: ctx.configurationPortable.application,
    runtime: ctx.configurationPortable,
  };
}
