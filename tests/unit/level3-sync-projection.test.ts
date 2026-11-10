import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { SyncProjection } from '../../packages/plugins/configuration/src/client/sync-projection.ts';
const run = () => ({
  ownerProfile: 'web',
  commandId: randomUUID(),
  generation: randomUUID(),
  profileId: randomUUID(),
  operation: 'upload',
  status: 'uncertain',
  reason: 'uncertain',
  cursor: 10,
});
it('publishes complete sync baselines, replaces atomically and resets on reconnect', () => {
  const projection = new SyncProjection();
  const generation = randomUUID();
  const value = run();
  projection.accept({ type: 'begin', mode: 'baseline', generation, cursor: 0 });
  expect(
    projection.accept({
      type: 'chunk',
      offset: 0,
      text: JSON.stringify({ profiles: [], runs: [value] }),
      final: true,
    }),
  ).toBeUndefined();
  const baseline = projection.accept({ type: 'commit', cursor: 0 });
  expect(baseline?.runs).toEqual([value]);
  expect(Object.isFrozen(baseline?.runs[0])).toBe(true);
  projection.accept({ type: 'begin', mode: 'replace', generation, cursor: 1 });
  projection.accept({ type: 'chunk', offset: 0, text: '{"profiles":[],"runs":[]}', final: true });
  expect(projection.accept({ type: 'commit', cursor: 1 })?.runs).toEqual([]);
  projection.reset();
  expect(() =>
    projection.accept({ type: 'begin', mode: 'replace', generation, cursor: 2 }),
  ).toThrow();
  projection.accept({ type: 'begin', mode: 'baseline', generation: randomUUID(), cursor: 0 });
});
it('rejects duplicated runs, secret fields, wrong offsets and incomplete updates', () => {
  for (const runs of [
    [{ ...run(), secret: 'PRIVATE' }],
    (() => {
      const value = run();
      return [value, value];
    })(),
  ]) {
    const projection = new SyncProjection();
    projection.accept({ type: 'begin', mode: 'baseline', generation: randomUUID(), cursor: 0 });
    projection.accept({
      type: 'chunk',
      offset: 0,
      text: JSON.stringify({ profiles: [], runs }),
      final: true,
    });
    expect(() => projection.accept({ type: 'commit', cursor: 0 })).toThrow();
  }
  const projection = new SyncProjection();
  expect(() => projection.accept({ type: 'commit', cursor: 0 })).toThrow();
  projection.accept({ type: 'begin', mode: 'baseline', generation: randomUUID(), cursor: 0 });
  expect(() => projection.accept({ type: 'chunk', offset: 1, text: '{}', final: true })).toThrow();
});
