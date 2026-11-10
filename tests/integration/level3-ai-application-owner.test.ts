import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import Engines from '../../packages/infra/engines/src/index.ts';
import LocalSubprocess from '../../packages/infra/subprocess-local/src/index.ts';
import { OwnedAiApplication } from '../../packages/plugins/ai/src/adapters/application-owner.ts';
import { AiOwnerLease } from '../../packages/plugins/ai/src/adapters/owner-coordination.ts';
import {
  aiProviderInputSchema,
  aiModelInputSchema,
  type AiProvider,
  type AiModel,
} from '@axterm/plugin-api/ai';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'axterm-ai-composition-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const ctx = new Context();
  cleanup.push(() => ctx.fiber.dispose().catch(() => {}));
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  await ctx.plugin(Engines);
  await ctx.plugin(LocalSubprocess);
  const ref = 'cred_' + randomUUID();
  await ctx.plugin(MemoryCredentials, { [encodeOpaqueCredentialRef(ref)]: 'OWNER_KEY_CANARY' });
  ctx.provide('runtimeIdentity', {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: 'desktop',
    appVersion: '0.10.0',
  });
  const config = {
    profile: 'desktop',
    coordinationDirectory: join(root, 'coordination'),
    localHome: root,
    remoteWorkspace: join(root, 'workspace'),
  };
  const owner = new OwnedAiApplication(ctx, config, { publish: () => {} });
  cleanup.push(() => owner.close().catch(() => {}));
  return { root, ctx, config, owner, ref };
}
it('closes the actual storage facet only after workers drain and then releases the exclusive owner lease', async () => {
  const f = await fixture();
  const app = await f.owner.ready();
  expect(f.owner.activeTaskCount()).toBe(0);
  expect(app.domain.get<{ count: number }>('SELECT count(*) AS count FROM ai_runs')?.count).toBe(0);
  await expect(AiOwnerLease.open(f.config.coordinationDirectory, 'desktop')).rejects.toThrow(
    'unavailable',
  );
  await f.owner.close();
  expect(f.owner.activeTaskCount()).toBe(0);
  expect(() => app.domain.get('SELECT count(*) FROM ai_runs')).toThrow();
  const replacement = await AiOwnerLease.open(f.config.coordinationDirectory, 'desktop');
  await replacement.close();
  await expect(f.owner.ready()).rejects.toThrow('closed');
});
it('retains both database and Profile lock when a real Engine registry session fails its actual close', async () => {
  const f = await fixture();
  f.ctx.engines.register('fixture', {
    label: 'Controlled close failure',
    capabilities: { cancellation: true, tools: false, resume: false },
    openSession: async () => ({
      run: async (_input, context) => {
        await context.emit({ type: 'delta', text: 'visible' });
      },
      close: async () => {
        throw new Error('controlled drain failure');
      },
    }),
  });
  const app = await f.owner.ready();
  // Existing migrated provider facts are used; this fixture exercises lifecycle, not generic Engine configuration UI.
  const provider = app.repository.createJson(
    'ai_providers',
    aiProviderInputSchema.parse({
      name: 'Controlled fixture',
      engineId: 'fixture',
      baseUrl: 'http://127.0.0.1:1',
      credentialRef: f.ref,
      enabled: true,
    }),
    'ai-provider.created',
  ) as AiProvider;
  const model = app.repository.createJson(
    'ai_models',
    aiModelInputSchema.parse({
      name: 'Controlled',
      providerId: provider.id,
      model: 'fixture',
      capabilities: ['chat'],
    }),
    'ai-model.created',
  ) as AiModel;
  const run = await app.service.start(
    { modelId: model.id, useCase: 'chat', prompt: 'visible request', context: '' },
    randomUUID(),
  );
  await vi.waitFor(() => expect(app.service.get(run.id).state).toBe('failed'));
  await expect(f.owner.close()).rejects.toThrow('could not drain');
  expect(f.owner.activeTaskCount()).toBeGreaterThan(0);
  expect(app.domain.get<{ count: number }>('SELECT count(*) AS count FROM ai_runs')?.count).toBe(1);
  await expect(AiOwnerLease.open(f.config.coordinationDirectory, 'desktop')).rejects.toThrow(
    'unavailable',
  );
  // No native handle exists in the deliberately failing fixture. Test teardown may close its memory DB;
  // the production owner intentionally retains the failed drain and cannot report successful shutdown.
  await app.domain.close();
});

it('joins actual per-Run execution after cancellation facts are already terminal', async () => {
  const f = await fixture(),
    started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let closed = 0;
  f.ctx.engines.register('drainfixture', {
    label: 'Controlled execution drain',
    capabilities: { cancellation: true, tools: false, resume: false },
    openSession: async () => ({
      run: async (_input, context) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await release.promise;
      },
      close: async () => {
        closed++;
      },
    }),
  });
  const app = await f.owner.ready();
  try {
    const provider = app.repository.createJson(
      'ai_providers',
      aiProviderInputSchema.parse({
        name: 'Drain fixture',
        engineId: 'drainfixture',
        enabled: true,
      }),
      'ai-provider.created',
    ) as AiProvider;
    const model = app.repository.createJson(
      'ai_models',
      aiModelInputSchema.parse({
        name: 'Drain model',
        providerId: provider.id,
        model: 'fixture',
        capabilities: ['chat'],
      }),
      'ai-model.created',
    ) as AiModel;
    const run = await app.service.start(
      { modelId: model.id, useCase: 'createTheme', prompt: 'Theme draft', context: '' },
      randomUUID(),
    );
    await started.promise;
    app.service.cancel(run.id);
    expect(app.service.get(run.id).state).toBe('canceled');
    let drained = false;
    const task = app.service.drainRun(run.id).then(() => {
      drained = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    // Engine close requests cancellation eagerly; execution still has not returned.
    expect(closed).toBe(1);
    release.resolve();
    await task;
    expect(drained).toBe(true);
    expect(closed).toBe(1);
    await app.service.drainRun(run.id);
  } finally {
    release.resolve();
    await f.owner.close();
  }
});
