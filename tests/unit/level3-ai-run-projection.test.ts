import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { aiRunSchema, type AiLogPayload } from '@axterm/plugin-api/ai';
import { AiRunProjection } from '../../packages/plugins/ai/src/client/run-projection.ts';
function fixture() {
  const run = aiRunSchema.parse({
    id: randomUUID(),
    engineId: 'pi',
    state: 'running',
    useCase: 'chat',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 2,
  });
  const projection = new AiRunProjection(run);
  let cursor = 0;
  return {
    run,
    projection,
    event: (payload: AiLogPayload) => ({
      cursor: ++cursor,
      runId: run.id,
      createdAt: new Date().toISOString(),
      payload,
    }),
  };
}
it('distinguishes streamed append from final visible replacement without duplicating output or billing review as execution', () => {
  const f = fixture();
  f.projection.accept(f.event({ kind: 'output', text: 'streamed ' }));
  f.projection.accept(f.event({ kind: 'output', text: 'text' }));
  expect(f.projection.snapshot().output).toBe('streamed text');
  f.projection.accept(f.event({ kind: 'output', mode: 'replace', text: 'normalized ' }));
  f.projection.accept(f.event({ kind: 'output', mode: 'append', text: 'final' }));
  expect(f.projection.snapshot().output).toBe('normalized final');
  f.projection.accept(
    f.event({ kind: 'usage', purpose: 'review', inputTokens: 10, outputTokens: 2 }),
  );
  f.projection.accept(
    f.event({ kind: 'usage', purpose: 'execution', inputTokens: 20, outputTokens: 4 }),
  );
  expect(f.projection.snapshot().usage).toEqual({
    execution: { inputTokens: 20, outputTokens: 4 },
    review: { inputTokens: 10, outputTokens: 2 },
  });
  f.projection.accept(f.event({ kind: 'output', mode: 'replace', text: '' }));
  expect(f.projection.snapshot().output).toBe('');
});
it('refuses other Runs, cursor replay, private reasoning and oversized output while retaining the last accepted cursor', () => {
  const f = fixture();
  const first = f.event({ kind: 'output', text: 'safe' });
  f.projection.accept(first);
  expect(() => f.projection.accept(first)).toThrow('INVALID');
  expect(() =>
    f.projection.accept({ ...f.event({ kind: 'output', text: 'other' }), runId: randomUUID() }),
  ).toThrow('INVALID');
  expect(() =>
    f.projection.accept(f.event({ kind: 'reasoning', text: 'private' } as never)),
  ).toThrow();
  expect(f.projection.snapshot().cursor).toBe(first.cursor);
  expect(f.projection.snapshot().output).toBe('safe');
  const maximum = 'a'.repeat(120000);
  for (let index = 0; index < 17; index++)
    f.projection.accept(
      f.event({ kind: 'output', mode: index === 0 ? 'replace' : 'append', text: maximum }),
    );
  const cursor = f.projection.snapshot().cursor;
  expect(() => f.projection.accept(f.event({ kind: 'output', text: maximum }))).toThrow('CAPACITY');
  expect(f.projection.snapshot().cursor).toBe(cursor);
});
