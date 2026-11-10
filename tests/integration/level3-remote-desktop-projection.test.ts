import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type {
  RemoteDesktopBaseline,
  RemoteDesktopSession,
} from '@axterm/plugin-api/remote-desktop';
import { RemoteDesktopProjection } from '../../packages/plugins/remote-desktop/src/client/projection.ts';
const session = (): Extract<RemoteDesktopSession, { protocol: 'spice' }> => ({
  id: randomUUID(),
  bookmarkId: randomUUID(),
  protocol: 'spice',
  title: 'Desktop',
  state: 'created',
  viewOnly: false,
  scaleViewport: true,
  activeChannels: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
it('replaces complete baselines across generations, joins exact revisions and rejects gaps and malformed metadata', () => {
  const projection = new RemoteDesktopProjection();
  const a = session();
  const baseline: RemoteDesktopBaseline = {
    type: 'baseline',
    generation: randomUUID(),
    revision: 0,
    sessions: [a],
  };
  expect(Object.isFrozen(projection.replace(baseline).sessions)).toBe(true);
  expect(
    projection.apply({
      type: 'upsert',
      generation: baseline.generation,
      revision: 1,
      session: { ...a, state: 'ready' },
    }).sessions[0]?.state,
  ).toBe('ready');
  expect(() =>
    projection.apply({ type: 'remove', generation: randomUUID(), revision: 2, id: a.id }),
  ).toThrow();
  expect(() =>
    projection.apply({ type: 'remove', generation: baseline.generation, revision: 3, id: a.id }),
  ).toThrow();
  expect(() =>
    projection.apply({
      type: 'remove',
      generation: baseline.generation,
      revision: 2,
      id: randomUUID(),
    }),
  ).toThrow();
  expect(() => projection.replace({ ...baseline, sessions: [a, a] })).toThrow();
  expect(() =>
    projection.replace({ ...baseline, sessions: [{ ...a, activeChannels: 17 }] }),
  ).toThrow();
  expect(
    projection.apply({ type: 'remove', generation: baseline.generation, revision: 2, id: a.id })
      .sessions,
  ).toEqual([]);
  const b = session();
  expect(
    projection
      .replace({ ...baseline, generation: randomUUID(), sessions: [b] })
      .sessions.map((s) => s.id),
  ).toEqual([b.id]);
});
