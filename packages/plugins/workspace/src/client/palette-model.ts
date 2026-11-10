import type { WorkspacePaletteItem, WorkspacePaletteUi } from '@axterm/ui/workspace';

export const MAX_PALETTE_RESULTS = 50,
  MAX_PALETTE_USAGE = 50;
export interface PaletteUsage {
  id: string;
  count: number;
  lastUsed: number;
}
const groups = ['recent', 'actions', 'terminal', 'sections', 'sessions', 'hosts', 'workspaces'];
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().trim();
/** Bounded presentation ranking; retains no command, host, or terminal output data. */
export function paletteResults(
  items: readonly WorkspacePaletteItem[],
  query: string,
  usage: readonly PaletteUsage[],
) {
  const terms = normalize(query).split(/\s+/u).filter(Boolean),
    byId = new Map(usage.map((item) => [item.id, item]));
  const matches = items
    .filter((item) => {
      const text = normalize([item.label, ...item.aliases].join(' '));
      return terms.every((term) => text.includes(term));
    })
    .map((item, index) => ({
      item: !terms.length && byId.has(item.id) ? { ...item, group: 'recent' as const } : item,
      index,
    }))
    .sort(
      (a, b) =>
        groups.indexOf(a.item.group) - groups.indexOf(b.item.group) ||
        (byId.get(b.item.id)?.count ?? 0) - (byId.get(a.item.id)?.count ?? 0) ||
        (byId.get(b.item.id)?.lastUsed ?? 0) - (byId.get(a.item.id)?.lastUsed ?? 0) ||
        a.index - b.index,
    );
  return {
    total: matches.length,
    items: matches.slice(0, MAX_PALETTE_RESULTS).map((row) => row.item),
  };
}
export function rememberPaletteUsage(usage: readonly PaletteUsage[], id: string): PaletteUsage[] {
  const previous = usage.find((item) => item.id === id),
    lastUsed = Math.max(0, ...usage.map((item) => item.lastUsed)) + 1;
  return [
    ...usage.filter((item) => item.id !== id),
    { id, count: Math.min(1_000_000, (previous?.count ?? 0) + 1), lastUsed },
  ]
    .sort((a, b) => a.lastUsed - b.lastUsed)
    .slice(-MAX_PALETTE_USAGE);
}
/** Sources are callbacks into their canonical models, not an additional business cache. */
export class PaletteSources implements WorkspacePaletteUi {
  private readonly sources = new Map<string, { read: () => readonly WorkspacePaletteItem[] }>();
  private closed = false;
  registerSource(id: string, source: () => readonly WorkspacePaletteItem[]): () => void {
    if (this.closed || !id || id.length > 160 || this.sources.has(id) || this.sources.size >= 64)
      throw Error('PALETTE_SOURCE_UNAVAILABLE');
    const entry = { read: source };
    this.sources.set(id, entry);
    return () => {
      if (this.sources.get(id) === entry) this.sources.delete(id);
    };
  }
  capture(): WorkspacePaletteItem[] {
    if (this.closed) throw Error('PALETTE_CLOSED');
    const items: WorkspacePaletteItem[] = [],
      ids = new Set<string>();
    for (const [owner, source] of this.sources)
      for (const item of source.read()) {
        const id = `${owner}:${item.id}`;
        if (ids.has(id) || items.length >= 10000) throw Error('PALETTE_SOURCE_CAPACITY');
        ids.add(id);
        items.push({
          ...item,
          id,
          execute: () => {
            if (this.closed || this.sources.get(owner) !== source)
              throw Error('PALETTE_SOURCE_RETIRED');
            return item.execute();
          },
        });
      }
    return items;
  }
  close(): void {
    this.closed = true;
    this.sources.clear();
  }
}
