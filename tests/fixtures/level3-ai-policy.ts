import { randomUUID } from 'node:crypto';
import { afterEach } from 'vitest';
import { productDomains } from '@axterm/data-schema';
import Engines from '../../packages/infra/engines/src/index.ts';
import { PiEngineProvider, piEngineConfigSchema } from '../../packages/engines/pi/src/index.ts';
import { AiRepository } from '../../packages/plugins/ai/src/adapters/repository.ts';
import { AiStorage } from '../../packages/plugins/ai/src/adapters/storage.ts';
import { AiRunJournal } from '../../packages/plugins/ai/src/adapters/run-journal.ts';
import { AiFacts } from '../../packages/plugins/ai/src/adapters/facts.ts';
import { AiModels } from '../../packages/plugins/ai/src/adapters/models.ts';
import { commandReviewer } from '../../packages/plugins/ai/src/adapters/command-review.ts';
import { AiService, redact } from '../../packages/plugins/ai/src/application/ai-service.ts';
import type { AiHostPort } from '../../packages/plugins/ai/src/ports/host.ts';
import type { AiToolsPort } from '../../packages/plugins/ai/src/ports/tools.ts';
import type { AiWorkspaceService } from '../../packages/plugins/ai/src/application/ai-workspace-service.ts';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';
import { ownedStorage } from './level3-owned-storage.ts';
const live = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const close of [...live].reverse()) await close();
});
/** Composition only: actual AI domain, journal, facts, Engine registry and pinned Pi model adapter. */
export async function ownedAiPolicy() {
  const storage = await ownedStorage();
  const domain = await storage.open(productDomains.ai);
  const repository = new AiRepository(new AiStorage(domain));
  const generation = randomUUID();
  const journal = new AiRunJournal(
    domain,
    repository,
    { profile: 'desktop', generation, pid: process.pid },
    redact,
  );
  const facts = new AiFacts(domain, repository, journal, generation);
  await storage.ctx.plugin(MemoryCredentials);
  await storage.ctx.plugin(Engines);
  storage.ctx.engines.register(
    'pi',
    new PiEngineProvider(storage.ctx, piEngineConfigSchema.parse({ providers: {} })),
  );
  const models = new AiModels(storage.ctx);
  const services = new Set<AiService>();
  const events: { type: string; payload: unknown }[] = [];
  const drain = async () => {
    for (const service of [...services].reverse()) await service.close();
    await models.close();
  };
  storage.ctx.effect(() => drain);
  const close = async () => {
    await drain();
    await storage.close();
    live.delete(close);
  };
  live.add(close);
  return {
    drain,
    ctx: storage.ctx,
    domain,
    repository,
    facts,
    journal,
    generation,
    events,
    close,
    createService(
      host?: AiHostPort,
      tools: AiToolsPort = {
        risk: () => {
          throw Error('No tool selected');
        },
        execute: async () => {
          throw Error('No tool selected');
        },
      },
      workspaces?: AiWorkspaceService,
    ) {
      const service = new AiService(
        repository,
        facts,
        host,
        { publish: (type, payload) => events.push({ type, payload }) },
        tools,
        models,
        commandReviewer,
        workspaces,
        generation,
      );
      services.add(service);
      storage.ctx.effect(() => () => service.close());
      return service;
    },
  };
}
