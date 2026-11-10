import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  axtermConfigurationPreviewSchema,
  CONFIGURATION_PORTABLE_CHUNK_CHARACTERS,
  CONFIGURATION_PORTABLE_MAX_SNAPSHOT_BYTES,
} from '@axterm/plugin-api/configuration-portable';
import { ConfigurationPortableProjection } from '../../packages/plugins/configuration/src/client/portable-projection.ts';
const preview = () =>
  axtermConfigurationPreviewSchema.parse({
    previewId: randomUUID(),
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    appVersion: '0.10.0',
    exportedAt: new Date().toISOString(),
    bytes: 2,
    sha256: 'a'.repeat(64),
    entityCount: 0,
    counts: { create: 0, unchanged: 0, conflict: 0, skipped: 1 },
    settings: 'preserved',
    canCommit: true,
    issues: [],
    issueCount: 0,
    issuesTruncated: false,
  });
it('publishes complete preview metadata atomically and requires a fresh baseline after reset', () => {
  const model = new ConfigurationPortableProjection();
  const value = preview();
  const generation = randomUUID();
  model.accept({ type: 'begin', mode: 'baseline', generation, cursor: 0 });
  expect(
    model.accept({
      type: 'chunk',
      offset: 0,
      text: JSON.stringify({ previews: [value] }),
      final: true,
    }),
  ).toBeUndefined();
  const baseline = model.accept({ type: 'commit', cursor: 0 });
  expect(baseline?.previews).toEqual([value]);
  expect(Object.isFrozen(baseline?.previews[0]?.counts)).toBe(true);
  model.reset();
  expect(() => model.accept({ type: 'begin', mode: 'replace', generation, cursor: 1 })).toThrow();
});
it('rejects extra document bodies, duplicate preview ids and more than four retained previews', () => {
  const value = preview();
  for (const payload of [
    { previews: [value], document: { secret: 'PRIVATE_DATA' } },
    { previews: [value, value] },
    { previews: Array.from({ length: 5 }, preview) },
  ]) {
    const model = new ConfigurationPortableProjection();
    model.accept({ type: 'begin', mode: 'baseline', generation: randomUUID(), cursor: 0 });
    model.accept({ type: 'chunk', offset: 0, text: JSON.stringify(payload), final: true });
    expect(() => model.accept({ type: 'commit', cursor: 0 })).toThrow();
  }
});
it('rejects a growing metadata frame before exceeding its byte budget', () => {
  const model = new ConfigurationPortableProjection();
  model.accept({ type: 'begin', mode: 'baseline', generation: randomUUID(), cursor: 0 });
  const chunk = 'x'.repeat(CONFIGURATION_PORTABLE_CHUNK_CHARACTERS);
  for (let offset = 0; offset < CONFIGURATION_PORTABLE_MAX_SNAPSHOT_BYTES; offset += chunk.length)
    model.accept({ type: 'chunk', offset, text: chunk, final: false });
  expect(() =>
    model.accept({
      type: 'chunk',
      offset: CONFIGURATION_PORTABLE_MAX_SNAPSHOT_BYTES,
      text: 'x',
      final: true,
    }),
  ).toThrow();
});
