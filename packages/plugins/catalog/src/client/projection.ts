import {
  hostSchema,
  hostGroupSchema,
  bookmarkTreeSchema,
  connectionProfileSchema,
  connectionHistoryPageSchema,
  CATALOG_CHUNK_CHARACTERS,
  CATALOG_MAX_SNAPSHOT_BYTES,
  type CatalogBaseline,
  type CatalogCollection,
  type CatalogUpdate,
} from '@axterm/plugin-api/catalog';
const names: readonly CatalogCollection[] = [
  'hosts',
  'hostGroups',
  'bookmarks',
  'connectionProfiles',
  'history',
];
const invalid = (): never => {
  throw new Error('CATALOG_PROJECTION_INVALID');
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Stage bounded fragments privately; observers see only schema-validated atomic commits. */
export class CatalogProjection {
  private baseline: CatalogBaseline | undefined;
  private opening = true;
  private pending: Extract<CatalogUpdate, { type: 'begin' }> | undefined;
  private fragments = new Map<CatalogCollection, { text: string; final: boolean }>();
  private bytes = 0;
  reset(): void {
    this.opening = true;
    this.pending = undefined;
    this.fragments.clear();
    this.bytes = 0;
  }
  accept(frame: CatalogUpdate): CatalogBaseline | undefined {
    if (frame.type === 'begin') {
      if (
        this.pending ||
        !Number.isSafeInteger(frame.cursor) ||
        frame.cursor < 0 ||
        !frame.generation ||
        !frame.collections.length ||
        frame.collections.length > names.length ||
        new Set(frame.collections).size !== frame.collections.length ||
        frame.collections.some((name) => !names.includes(name))
      )
        invalid();
      if (
        this.opening
          ? frame.mode !== 'baseline' || frame.collections.length !== names.length
          : frame.mode !== 'delta' ||
            frame.generation !== this.baseline?.generation ||
            frame.cursor <= this.baseline.cursor
      )
        invalid();
      this.pending = frame;
      this.fragments.clear();
      this.bytes = 0;
      return;
    }
    const pending = this.pending;
    if (!pending) return invalid();
    if (frame.type === 'chunk') {
      const previous = this.fragments.get(frame.collection);
      if (
        !pending.collections.includes(frame.collection) ||
        previous?.final ||
        frame.offset !== (previous?.text.length ?? 0) ||
        !frame.text.length ||
        frame.text.length > CATALOG_CHUNK_CHARACTERS
      )
        invalid();
      this.bytes += new TextEncoder().encode(frame.text).byteLength;
      if (this.bytes > CATALOG_MAX_SNAPSHOT_BYTES) invalid();
      this.fragments.set(frame.collection, {
        text: (previous?.text ?? '') + frame.text,
        final: frame.final,
      });
      return;
    }
    if (
      frame.cursor !== pending.cursor ||
      pending.collections.some((name) => !this.fragments.get(name)?.final)
    )
      invalid();
    const selected = <T>(name: CatalogCollection, parse: (value: unknown) => T): T => {
      const entry = this.fragments.get(name);
      return entry ? parse(JSON.parse(entry.text)) : (this.baseline![name] as T);
    };
    const baseline: CatalogBaseline = freeze({
      generation: pending.generation,
      cursor: pending.cursor,
      hosts: selected('hosts', (value) => hostSchema.array().parse(value)),
      hostGroups: selected('hostGroups', (value) => hostGroupSchema.array().parse(value)),
      bookmarks: selected('bookmarks', (value) => bookmarkTreeSchema.parse(value)),
      connectionProfiles: selected('connectionProfiles', (value) =>
        connectionProfileSchema.array().parse(value),
      ),
      history: selected('history', (value) => connectionHistoryPageSchema.parse(value)),
    });
    this.baseline = baseline;
    this.opening = false;
    this.pending = undefined;
    this.fragments.clear();
    this.bytes = 0;
    return baseline;
  }
}
