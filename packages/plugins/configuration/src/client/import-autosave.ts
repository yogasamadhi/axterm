import { remoteErrorOf } from '@axterm/plugin-api';
import type { WorkspaceAutosaveUi } from '@axterm/ui/workspace';
/** Holds only admitted UI barriers, never imported facts or replayable IO. */
export class ImportAutosaveGuard {
  private readonly holds = new Map<
    string,
    { generation: string; release: () => void; uncertain: boolean }
  >();
  private readonly pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  private readonly pendingKeys = new Set<string>();
  constructor(private readonly autosave: () => WorkspaceAutosaveUi | undefined) {}
  run<
    T extends
      { settings: 'applied' | 'preserved' } | { result: { settings: 'applied' | 'preserved' } },
  >(
    key: string,
    generation: string,
    current: () => boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.closing || this.pending.size >= 8 || this.pendingKeys.has(key))
      throw Error('IMPORT_AUTOSAVE_UNAVAILABLE');
    if (!this.holds.has(key) && this.holds.size + this.pendingKeys.size >= 8)
      throw Error('IMPORT_AUTOSAVE_CAPACITY');
    this.pendingKeys.add(key);
    const task = Promise.resolve().then(async () => {
      let hold = this.holds.get(key);
      if (hold && hold.generation !== generation) throw Error('IMPORT_AUTOSAVE_RETIRED');
      if (!hold) {
        if (this.holds.size >= 8) throw Error('IMPORT_AUTOSAVE_CAPACITY');
        const release = (await this.autosave()?.pause()) ?? (() => {});
        if (!current()) {
          release();
          throw Error('IMPORT_AUTOSAVE_RETIRED');
        }
        hold = { generation, release, uncertain: false };
        this.holds.set(key, hold);
      }
      if (!current()) throw Error('IMPORT_AUTOSAVE_RETIRED');
      try {
        const result = await operation();
        if (('settings' in result ? result.settings : result.result.settings) === 'preserved') {
          hold.release();
          this.holds.delete(key);
        } else hold.uncertain = true;
        return result;
      } catch (error) {
        const marked = remoteErrorOf(error);
        const definite =
          marked?.code === 'configuration/portable-failure' &&
          ['invalid-input', 'stale', 'conflict', 'capacity', 'closed', 'not-found'].includes(
            marked.details.reason,
          );
        if (definite && !hold.uncertain) {
          hold.release();
          this.holds.delete(key);
        } else hold.uncertain = true;
        throw error;
      }
    });
    this.pending.add(task);
    void task.then(
      () => {
        this.pending.delete(task);
        this.pendingKeys.delete(key);
      },
      () => {
        this.pending.delete(task);
        this.pendingKeys.delete(key);
      },
    );
    return task;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      await Promise.allSettled([...this.pending]);
      for (const hold of this.holds.values()) hold.release();
      this.holds.clear();
    })());
  }
}
