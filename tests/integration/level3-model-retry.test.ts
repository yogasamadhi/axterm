import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import type { CatalogUpdate } from '@axterm/plugin-api/catalog';
import type { SettingsUpdate } from '@axterm/plugin-api/configuration';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import * as Configuration from '../../packages/plugins/configuration/src/index.ts';
import * as Catalog from '../../packages/plugins/catalog/src/index.ts';
import { SettingsModel } from '../../packages/plugins/configuration/src/client/index.ts';
import { CatalogModel } from '../../packages/plugins/catalog/src/client/index.ts';
import {
  RemoteStream,
  type RemoteStreamOptions,
} from '../../packages/infra/gateway/src/client/remote-stream.ts';
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
});
async function host() {
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
  await ctx.plugin(Configuration);
  await ctx.plugin(Catalog);
  return ctx;
}
function client<Update>(
  kind: 'catalog' | 'configuration',
  watch: string,
  open: (signal: AbortSignal) => AsyncIterable<Update>,
) {
  let failed = false;
  const create = vi.fn(
    (options: RemoteStreamOptions<Update>) =>
      new RemoteStream(
        { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } },
        options,
      ),
  );
  const context = {
    remote: {
      $stream: create,
      [kind]: {
        [watch]: (signal: AbortSignal) => {
          if (!failed) {
            failed = true;
            throw new RemoteError(`${kind}/failure`, 'Fixture-private diagnostic', {
              reason: 'unavailable',
            });
          }
          return open(signal);
        },
      },
    },
  } as unknown as Context;
  return { context, create };
}
it('reopens the Settings model after a terminal Remote failure, coalesces retries and drains its replacement', async () => {
  const owner = await host();
  const { context, create } = client<SettingsUpdate>('configuration', 'watchSettings', (signal) =>
    owner.configurationController.watchSettings(signal),
  );
  const model = new SettingsModel(context);
  try {
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('error'));
    expect(JSON.stringify(model.getSnapshot())).not.toContain('Fixture-private');
    const first = model.retry();
    expect(model.retry()).toBe(first);
    await first;
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
    expect(create).toHaveBeenCalledTimes(2);
  } finally {
    await model.dispose();
  }
  expect(() => model.retry()).toThrow('SETTINGS_MODEL_CLOSED');
});
it('reopens the Catalog model after a terminal Remote failure rather than restarting an ended stream', async () => {
  const owner = await host();
  const { context, create } = client<CatalogUpdate>('catalog', 'watchCatalog', (signal) =>
    owner.catalogController.watchCatalog(signal),
  );
  const model = new CatalogModel(context);
  try {
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('error'));
    const first = model.retry();
    expect(model.retry()).toBe(first);
    await first;
    await vi.waitFor(() => expect(model.getSnapshot().status).toBe('ready'));
    expect(create).toHaveBeenCalledTimes(2);
  } finally {
    await model.dispose();
  }
  expect(() => model.retry()).toThrow('CATALOG_MODEL_CLOSED');
});
