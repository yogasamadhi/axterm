import { expect, it } from 'vitest';
import type { CatalogCollection, CatalogUpdate } from '@axterm/plugin-api/catalog';
import { CatalogProjection } from './projection.ts';
const names: CatalogCollection[] = [
  'hosts',
  'hostGroups',
  'bookmarks',
  'connectionProfiles',
  'history',
];
const begin = (): CatalogUpdate => ({
  type: 'begin',
  mode: 'baseline',
  generation: 'fixture-generation',
  cursor: 0,
  collections: names,
});
it('rejects incomplete, reordered, duplicate and oversized transfer frames before publishing a baseline', () => {
  for (const frame of [
    { type: 'commit', cursor: 0 },
    { type: 'chunk', collection: 'hosts', offset: 0, text: '[]', final: true },
    { ...begin(), collections: ['hosts', 'hosts', 'bookmarks', 'connectionProfiles', 'history'] },
    { ...begin(), mode: 'delta' },
  ] as CatalogUpdate[])
    expect(() => new CatalogProjection().accept(frame)).toThrow('CATALOG_PROJECTION_INVALID');
  for (const frames of [
    [{ type: 'commit', cursor: 0 }],
    [{ type: 'chunk', collection: 'hosts', offset: 1, text: '[]', final: true }],
    [{ type: 'chunk', collection: 'hosts', offset: 0, text: 'x'.repeat(16_385), final: true }],
    [begin()],
    [
      { type: 'chunk', collection: 'hosts', offset: 0, text: '[]', final: true },
      { type: 'chunk', collection: 'hosts', offset: 2, text: '[]', final: true },
    ],
  ] as CatalogUpdate[][]) {
    const projection = new CatalogProjection();
    projection.accept(begin());
    expect(() => {
      for (const frame of frames) projection.accept(frame);
    }).toThrow('CATALOG_PROJECTION_INVALID');
  }
});

it('clears incomplete fragments on a new carrier generation and validates collection semantics at commit', () => {
  const projection = new CatalogProjection();
  projection.accept(begin());
  projection.accept({ type: 'chunk', collection: 'hosts', offset: 0, text: '[', final: false });
  projection.reset();
  projection.accept(begin());
  for (const collection of names)
    projection.accept({ type: 'chunk', collection, offset: 0, text: '[]', final: true });
  expect(() => projection.accept({ type: 'commit', cursor: 0 })).toThrow();
});
