import { expect, it } from 'vitest';
import type { FileGrant } from '@axterm/plugin-api/files';
import { FileGrantsObservation } from '../../packages/plugins/files/src/observation.ts';
import { FileGrantsProjection } from '../../packages/plugins/files/src/client/projection.ts';
import { parsePanelFrame, panelId } from '../../apps/desktop/src/shell/native-panel-protocol.ts';
const grant: FileGrant = {
  grantId: 'controlled',
  kind: 'directory',
  name: 'workspace',
  permissions: ['read', 'write'],
  createdAt: '2026-11-05T00:00:00.000Z',
};
it('publishes complete validated file-grant snapshots and rejects partial or reordered updates', async () => {
  const observation = new FileGrantsObservation('generation', async () => [grant]);
  const stream = observation.watch(new AbortController().signal);
  const projection = new FileGrantsProjection();
  try {
    const begin = (await stream.next()).value!;
    expect(projection.accept(begin)).toBeUndefined();
    const chunk = (await stream.next()).value!;
    expect(projection.accept(chunk)).toBeUndefined();
    const commit = (await stream.next()).value!;
    const baseline = projection.accept(commit)!;
    expect(baseline.grants).toEqual([grant]);
    expect(Object.isFrozen(baseline.grants[0]?.permissions)).toBe(true);
    expect(() => projection.accept(commit)).toThrow('FILE_GRANTS_PROJECTION_INVALID');
    projection.reset();
    projection.accept(begin);
    expect(() =>
      projection.accept({ ...chunk, type: 'chunk', offset: 1, text: 'x', final: true }),
    ).toThrow('FILE_GRANTS_PROJECTION_INVALID');
  } finally {
    await stream.return!();
    await observation.dispose();
  }
});
it('limits followers and drains in-flight snapshot reads on owner unload', async () => {
  let aborted = false;
  const observation = new FileGrantsObservation(
    'generation',
    (signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve([]);
          },
          { once: true },
        );
      }),
  );
  const followers = Array.from({ length: 16 }, () =>
    observation.watch(new AbortController().signal),
  );
  expect(() => observation.watch(new AbortController().signal)).toThrowError(
    expect.objectContaining({ details: { reason: 'capacity' } }),
  );
  const first = followers[0]!.next();
  await expect(followers[0]!.next()).rejects.toMatchObject({ details: { reason: 'conflict' } });
  await observation.dispose();
  expect(aborted).toBe(true);
  expect(await first).toEqual({ done: true, value: undefined });
  expect(() => observation.watch(new AbortController().signal)).toThrowError(
    expect.objectContaining({ details: { reason: 'closed' } }),
  );
});
it('rejects native helper business dispatch, extra fields, wrong versions and oversized selection results', () => {
  const select = {
    kind: 'axterm-native-panel',
    version: 1,
    id: panelId(),
    type: 'select',
    selection: 'open-file',
  };
  expect(parsePanelFrame(select)).toEqual(select);
  for (const input of [
    { ...select, type: 'connections.exec' },
    { ...select, args: [] },
    { ...select, version: 2 },
    { ...select, id: 'old' },
    { ...select, selection: 'read-file' },
    { kind: select.kind, version: 1, id: select.id, type: 'result', path: 'x'.repeat(4097) },
  ])
    expect(() => parsePanelFrame(input)).toThrow('NATIVE_PANEL_PROTOCOL');
});
