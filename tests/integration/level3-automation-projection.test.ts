import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type {
  AutomationBaseline,
  AutomationCollection,
  AutomationUpdate,
} from '@axterm/plugin-api/automation';
import { AutomationProjection } from '../../packages/plugins/automation/src/client/projection.ts';
const empty = (): AutomationBaseline => ({
  generation: randomUUID(),
  cursor: 0,
  quickCommands: { revision: 1, etag: '"quick-command-tree-v1"', groups: [], commands: [] },
  triggers: { revision: 1, etag: '"trigger-list-v1"', triggers: [] },
  batches: [],
});
function frames(
  baseline: AutomationBaseline,
  names: AutomationCollection[] = ['quickCommands', 'triggers', 'batches'],
  mode: 'baseline' | 'delta' = 'baseline',
): AutomationUpdate[] {
  return [
    {
      type: 'begin',
      generation: baseline.generation,
      cursor: baseline.cursor,
      mode,
      collections: names,
    },
    ...names.map((collection) => ({
      type: 'chunk' as const,
      collection,
      offset: 0,
      final: true,
      text: JSON.stringify(baseline[collection]),
    })),
    { type: 'commit', cursor: baseline.cursor },
  ];
}
it('publishes only complete validated fact commits and replaces every collection on a new generation', () => {
  const p = new AutomationProjection();
  const initial = empty();
  const input = frames(initial);
  let accepted: AutomationBaseline | undefined;
  for (const frame of input.slice(0, -1)) expect(p.accept(frame)).toBeUndefined();
  accepted = p.accept(input.at(-1)!);
  expect(accepted).toEqual(initial);
  expect(Object.isFrozen(accepted?.quickCommands.commands)).toBe(true);
  const changed = {
    ...initial,
    cursor: 1,
    quickCommands: { ...initial.quickCommands, revision: 2, etag: '"quick-command-tree-v2"' },
  };
  for (const frame of frames(changed, ['quickCommands'], 'delta'))
    accepted = p.accept(frame) ?? accepted;
  expect(accepted?.quickCommands.revision).toBe(2);
  expect(() =>
    p.accept({
      type: 'begin',
      generation: initial.generation,
      cursor: 1,
      mode: 'delta',
      collections: ['triggers'],
    }),
  ).toThrow();
  p.reset();
  const next = empty();
  for (const frame of frames(next)) accepted = p.accept(frame) ?? accepted;
  expect(accepted?.generation).toBe(next.generation);
  expect(accepted?.quickCommands.revision).toBe(1);
});
it('rejects partial, reordered, duplicate and schema-invalid fragments before publishing a baseline', () => {
  const baseline = empty();
  for (const invalid of [
    {
      type: 'begin',
      generation: baseline.generation,
      cursor: 0,
      mode: 'baseline',
      collections: ['triggers'],
    },
    {
      type: 'begin',
      generation: baseline.generation,
      cursor: 0,
      mode: 'baseline',
      collections: ['quickCommands', 'quickCommands', 'batches'],
    },
  ] as AutomationUpdate[])
    expect(() => new AutomationProjection().accept(invalid)).toThrow();
  const p = new AutomationProjection();
  const initial = frames(baseline);
  p.accept(initial[0]!);
  expect(() =>
    p.accept({ type: 'chunk', collection: 'quickCommands', offset: 1, text: '{}', final: true }),
  ).toThrow();
  p.reset();
  p.accept(initial[0]!);
  p.accept({
    type: 'chunk',
    collection: 'quickCommands',
    offset: 0,
    text: '{"extra":true}',
    final: true,
  });
  p.accept(initial[2]!);
  p.accept(initial[3]!);
  expect(() => p.accept(initial.at(-1)!)).toThrow();
});
