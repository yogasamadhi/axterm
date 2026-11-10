import { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import { AiObservation } from '../../packages/plugins/ai/src/observation.ts';
import { AiProjection } from '../../packages/plugins/ai/src/client/projection.ts';
import { AiRepository } from '../../packages/plugins/ai/src/adapters/repository.ts';
import { AiStorage } from '../../packages/plugins/ai/src/adapters/storage.ts';
import { AiRunJournal } from '../../packages/plugins/ai/src/adapters/run-journal.ts';
import { AiQueries } from '../../packages/plugins/ai/src/adapters/queries.ts';
import type { AiBaseline, AiCollection, AiEngineHeader, AiUpdate } from '@axterm/plugin-api/ai';
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
  const engines: AiEngineHeader[] = [];
  const reads: AiCollection[] = [];
  const observation = new AiObservation(domain, (selected) => {
    const baseline: { generation: string; cursor: number } & {
      -readonly [K in AiCollection]?: AiBaseline[K];
    } = { generation, cursor: domain.cursor() };
    for (const name of selected) {
      reads.push(name);
      switch (name) {
        case 'providers':
          baseline.providers = queries.providers();
          break;
        case 'models':
          baseline.models = queries.models();
          break;
        case 'conversations':
          baseline.conversations = queries.conversations();
          break;
        case 'runs':
          baseline.runs = queries.runs();
          break;
        case 'approvals':
          baseline.approvals = repository.pendingApprovals();
          break;
        case 'engines':
          baseline.engines = [...engines];
          break;
      }
    }
    return baseline;
  });
  cleanup.push(() => observation.dispose());
  return { domain, repository, generation, journal, observation, engines, reads };
}
async function baseline(
  stream: AsyncIterableIterator<AiUpdate>,
  projection: AiProjection,
): Promise<AiBaseline> {
  for (;;) {
    const item = await stream.next();
    if (item.done) throw new Error('stream closed');
    const state = projection.accept(item.value);
    if (state) return state;
  }
}
it('atomically publishes complete metadata, advances durable cursors without reloading metadata for output, and replaces a reconnected baseline', async () => {
  const f = await fixture();
  const signal = new AbortController();
  const stream = f.observation.watch(signal.signal);
  const projection = new AiProjection();
  const initial = await baseline(stream, projection);
  expect(initial).toMatchObject({
    generation: f.generation,
    providers: [],
    models: [],
    conversations: [],
    runs: [],
    approvals: [],
    engines: [],
  });
  expect(Object.isFrozen(initial)).toBe(true);
  const { run } = f.journal.admit(randomUUID(), f.generation, {
    engineId: 'pi',
    useCase: 'chat',
    prompt: 'visible',
  });
  f.journal.transition(run.id, 'running');
  const running = await baseline(stream, projection);
  expect(running.runs.map((item) => item.id)).toEqual([run.id]);
  f.reads.length = 0;
  f.journal.append(run.id, { kind: 'output', text: 'visible output' });
  const output = await baseline(stream, projection);
  expect(output.cursor).toBeGreaterThan(running.cursor);
  expect(output.runs).toBe(running.runs);
  expect(f.reads).toEqual([]);
  await stream.return!();
  projection.reset();
  const reconnect = f.observation.watch(signal.signal);
  const recovered = await baseline(reconnect, projection);
  expect(recovered.runs.map((item) => item.id)).toEqual([run.id]);
  expect(recovered.cursor).toBe(output.cursor);
  await reconnect.return!();
  await f.observation.dispose();
  expect(f.observation.resourceCount()).toBe(0);
});
it('does not lose Engine changes while a snapshot consumer pauses before commit and closes paused readers deterministically', async () => {
  const f = await fixture();
  const stream = f.observation.watch(new AbortController().signal);
  const projection = new AiProjection();
  const begin = await stream.next();
  expect(begin.value.type).toBe('begin');
  projection.accept(begin.value);
  f.engines.push({
    id: 'external',
    label: 'External',
    capabilities: { cancellation: true, tools: false, resume: false },
    state: 'ready',
  });
  f.observation.invalidateEngines();
  const old = await baseline(stream, projection);
  expect(old.engines).toEqual([]);
  const changed = await baseline(stream, projection);
  expect(changed.engines.map((engine) => engine.id)).toEqual(['external']);
  expect(changed.revision).toBeGreaterThan(old.revision);
  const pending = stream.next();
  await f.observation.dispose();
  expect((await pending).done).toBe(true);
  expect(f.observation.resourceCount()).toBe(0);
});
it('rejects incomplete/replayed/generation-changing metadata commits and discards a partial reconnect', async () => {
  const f = await fixture();
  const stream = f.observation.watch(new AbortController().signal);
  const frames: AiUpdate[] = [];
  for (;;) {
    const item = await stream.next();
    frames.push(item.value);
    if (item.value.type === 'commit') break;
  }
  await stream.return!();
  const projection = new AiProjection();
  for (const frame of frames) projection.accept(frame);
  expect(() =>
    projection.accept({
      ...frames[0],
      type: 'begin',
      generation: randomUUID(),
      cursor: 0,
      revision: 2,
      mode: 'delta',
      collections: [],
    }),
  ).toThrow('INVALID');
  projection.reset();
  expect(() =>
    projection.accept({
      type: 'begin',
      generation: 'invalid',
      cursor: 0,
      revision: 0,
      mode: 'baseline',
      collections: ['providers'],
    }),
  ).toThrow('INVALID');
  const incomplete = new AiProjection();
  incomplete.accept(frames[0]!);
  expect(() => incomplete.accept(frames.at(-1)!)).toThrow('INVALID');
  const replay = new AiProjection();
  for (const frame of frames) replay.accept(frame);
  expect(() =>
    replay.accept({
      type: 'begin',
      generation: f.generation,
      cursor: 0,
      revision: 0,
      mode: 'delta',
      collections: [],
    }),
  ).toThrow('INVALID');
});
