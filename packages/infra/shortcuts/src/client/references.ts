import type { Shortcuts } from '@axterm/ui/shortcuts';
import type { NormalizedBinding, ShortcutCommandId } from '@axterm/plugin-api/shortcuts';
type Source = Parameters<Shortcuts['registerConflictSource']>[0];
/** Readonly references have no keys, definitions, input listeners or execution path. */
export class ShortcutReferences {
  private readonly sources = new Set<{ read: Source }>();
  private closed = false;
  register(source: Source): () => void {
    if (this.closed || this.sources.size >= 64) throw Error('SHORTCUT_REFERENCE_UNAVAILABLE');
    const entry = { read: source };
    this.sources.add(entry);
    return () => {
      this.sources.delete(entry);
    };
  }
  describe(
    binding: NormalizedBinding,
    currentOwners: readonly ShortcutCommandId[],
  ): { id: ShortcutCommandId; label: string }[] {
    if (this.closed || currentOwners.length) return [];
    const rows: { id: ShortcutCommandId; label: string }[] = [];
    for (const source of this.sources)
      for (const row of source.read(binding)) {
        if (rows.length >= 128 || row.id.length > 256 || row.label.length > 1024)
          throw Error('SHORTCUT_REFERENCE_CAPACITY');
        rows.push({ id: row.id, label: row.label });
      }
    return rows;
  }
  close(): void {
    this.closed = true;
    this.sources.clear();
  }
}
