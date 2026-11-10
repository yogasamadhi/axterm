import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import {
  aiProviderInputSchema,
  aiModelInputSchema,
  type AiProvider,
  type AiModel,
} from '@axterm/plugin-api/ai';
import { AiRepository } from '../../packages/plugins/ai/src/adapters/repository.ts';
import { AiStorage } from '../../packages/plugins/ai/src/adapters/storage.ts';
import { AiRunJournal } from '../../packages/plugins/ai/src/adapters/run-journal.ts';
import { AiQueries } from '../../packages/plugins/ai/src/adapters/queries.ts';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const ctx = new Context();
  cleanup.push(() => ctx.fiber.dispose());
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: ':memory:', schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  const domain = await ctx.storage.domain.open(Schema.productDomains.ai);
  cleanup.push(() => domain.close());
  const repository = new AiRepository(new AiStorage(domain));
  const generation = randomUUID();
  const journal = new AiRunJournal(
    domain,
    repository,
    { profile: 'desktop', generation, pid: process.pid },
    (text) => text,
  );
  const queries = new AiQueries(domain, repository, journal);
  return { domain, repository, generation, journal, queries };
}
it('builds complete metadata indices beyond recent-run limits without exposing provider detail or Run output', async () => {
  const f = await fixture();
  const provider = f.repository.createJson(
    'ai_providers',
    aiProviderInputSchema.parse({
      name: 'Saved',
      baseUrl: 'http://127.0.0.1:1',
      credentialRef: 'CONTROLLED_REFERENCE',
      role: 'DETAIL_CANARY',
      enabled: true,
    }),
    'ai-provider',
  ) as AiProvider;
  const model = f.repository.createJson(
    'ai_models',
    aiModelInputSchema.parse({
      name: 'Selected',
      providerId: provider.id,
      model: 'actual',
      capabilities: ['chat'],
    }),
    'ai-model',
  ) as AiModel;
  const conversation = f.repository.createAiConversation({
    name: 'Conversation',
    modelId: model.id,
  });
  let latestId = '';
  for (let index = 0; index < 205; index++) {
    latestId = f.repository.createAiRun({
      engineId: 'pi',
      useCase: 'chat',
      request: {},
      ...(index === 0 ? { conversation: { id: conversation.id, prompt: 'user' } } : {}),
    }).id;
  }
  const run = f.repository.getAiRun(latestId);
  f.repository.updateAiRun(
    run.id,
    'succeeded',
    'LARGE_OUTPUT_CANARY' + 'a'.repeat(2 * 1024 * 1024 - 100),
  );
  expect(f.repository.listAiRuns()).toHaveLength(200);
  expect(f.queries.runs()).toHaveLength(205);
  expect(f.queries.runs().find((item) => item.id === run.id)?.hasResult).toBe(true);
  const metadata = JSON.stringify({
    providers: f.queries.providers(),
    models: f.queries.models(),
    conversations: f.queries.conversations(),
    runs: f.queries.runs(),
  });
  expect(metadata).not.toContain('DETAIL_CANARY');
  expect(metadata).not.toContain('CONTROLLED_REFERENCE');
  expect(metadata).not.toContain('LARGE_OUTPUT_CANARY');
  expect(Buffer.byteLength(metadata)).toBeLessThan(150000);
  expect(f.queries.conversations()[0]).toMatchObject({ messageCount: 1, name: 'Conversation' });
});
it('pages large messages and visible logs by durable cursor and byte budget without omission or duplicate replay', async () => {
  const f = await fixture();
  const conversation = f.repository.createAiConversation({ name: 'Large', modelId: randomUUID() });
  for (let index = 0; index < 3; index++) {
    const run = f.repository.createAiRun({
      engineId: 'pi',
      useCase: 'chat',
      request: {},
      conversation: { id: conversation.id, prompt: 'user ' + index },
    });
    f.repository.updateAiRun(run.id, 'succeeded', 'x'.repeat(2 * 1024 * 1024 - 200));
  }
  let cursor = 0;
  const ids: string[] = [];
  let pages = 0;
  for (;;) {
    const page = f.queries.messages(conversation.id, { after: cursor, limit: 100 });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(3 * 1024 * 1024);
    ids.push(...page.messages.map((item) => item.id));
    pages++;
    if (!page.hasMore) break;
    expect(page.nextCursor).toBeGreaterThan(cursor);
    cursor = page.nextCursor;
  }
  expect(ids).toHaveLength(6);
  expect(new Set(ids).size).toBe(6);
  expect(pages).toBeGreaterThan(1);
  const { run } = f.journal.admit(randomUUID(), f.generation, {
    engineId: 'pi',
    useCase: 'chat',
    prompt: 'visible',
  });
  f.journal.transition(run.id, 'running');
  for (let index = 0; index < 30; index++)
    f.journal.append(run.id, { kind: 'output', text: String(index) + ':' + 'a'.repeat(120000) });
  let after = 0;
  const seen: number[] = [];
  for (;;) {
    const page = f.queries.logs(run.id, { after, limit: 100 });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(3 * 1024 * 1024);
    seen.push(...page.entries.map((entry) => entry.cursor));
    if (!page.hasMore) break;
    expect(page.nextCursor).toBeGreaterThan(after);
    after = page.nextCursor;
  }
  expect(seen).toHaveLength(33);
  expect(new Set(seen).size).toBe(33);
  expect(() => f.queries.logs(run.id, { after: -1 })).toThrow();
  expect(() => f.queries.messages(conversation.id, { limit: 101 })).toThrow();
});
