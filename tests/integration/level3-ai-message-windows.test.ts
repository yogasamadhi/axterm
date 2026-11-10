import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import { AiRepository } from '../../packages/plugins/ai/src/adapters/repository.ts';
import { AiStorage } from '../../packages/plugins/ai/src/adapters/storage.ts';
import { AiMessageWindows } from '../../packages/plugins/ai/src/adapters/message-windows.ts';
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
  const windows = new AiMessageWindows(domain, (id) => repository.getAiConversation(id));
  const conversation = repository.createAiConversation({ name: 'Window', modelId: randomUUID() });
  return { domain, repository, windows, conversation };
}
it('opens the latest bounded conversation window and traverses all interleaved durable cursors in both directions', async () => {
  const f = await fixture();
  const other = f.repository.createAiConversation({ name: 'Other', modelId: randomUUID() });
  for (let index = 0; index < 64; index++) {
    const run = f.repository.createAiRun({
      engineId: 'pi',
      useCase: 'chat',
      request: {},
      conversation: { id: f.conversation.id, prompt: 'question ' + index },
    });
    f.repository.updateAiRun(run.id, 'succeeded', 'answer ' + index);
    f.repository.createAiRun({
      engineId: 'pi',
      useCase: 'chat',
      request: {},
      conversation: { id: other.id, prompt: 'not included' },
    });
  }
  const latest = f.windows.read(f.conversation.id, { direction: 'latest', limit: 20 });
  expect(latest.messages).toHaveLength(20);
  expect(latest.hasEarlier).toBe(true);
  expect(latest.hasLater).toBe(false);
  expect(latest.messages.at(-1)?.content).toBe('answer 63');
  const backward = [...latest.messages.map((row) => row.id)];
  let page = latest;
  while (page.hasEarlier) {
    const previous = f.windows.read(f.conversation.id, {
      direction: 'earlier',
      cursor: page.firstCursor,
      limit: 20,
    });
    expect(previous.lastCursor).toBeLessThan(page.firstCursor);
    backward.unshift(...previous.messages.map((row) => row.id));
    page = previous;
  }
  expect(backward).toHaveLength(128);
  expect(new Set(backward).size).toBe(128);
  expect(page.messages[0]?.content).toBe('question 0');
  const forward = [...page.messages.map((row) => row.id)];
  while (page.hasLater) {
    const next = f.windows.read(f.conversation.id, {
      direction: 'later',
      cursor: page.lastCursor,
      limit: 20,
    });
    expect(next.firstCursor).toBeGreaterThan(page.lastCursor);
    forward.push(...next.messages.map((row) => row.id));
    page = next;
  }
  expect(forward).toEqual(backward);
});
it('respects the shared detail byte budget without skipping a large message and rejects invalid bounds', async () => {
  const f = await fixture();
  for (let index = 0; index < 3; index++) {
    const run = f.repository.createAiRun({
      engineId: 'pi',
      useCase: 'chat',
      request: {},
      conversation: { id: f.conversation.id, prompt: 'question ' + index },
    });
    f.repository.updateAiRun(run.id, 'succeeded', 'x'.repeat(2 * 1024 * 1024 - 200));
  }
  let page = f.windows.read(f.conversation.id, { direction: 'latest', limit: 100 });
  const ids = page.messages.map((row) => row.id);
  expect(page.hasEarlier).toBe(true);
  while (page.hasEarlier) {
    page = f.windows.read(f.conversation.id, {
      direction: 'earlier',
      cursor: page.firstCursor,
      limit: 100,
    });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(3 * 1024 * 1024);
    ids.push(...page.messages.map((row) => row.id));
  }
  expect(ids).toHaveLength(6);
  expect(new Set(ids).size).toBe(6);
  expect(() => f.windows.read(f.conversation.id, { direction: 'earlier', cursor: -1 })).toThrow();
  expect(() => f.windows.read(f.conversation.id, { direction: 'latest', limit: 101 })).toThrow();
});
