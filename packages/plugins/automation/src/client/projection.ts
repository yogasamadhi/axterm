import {
  quickCommandTreeSchema,
  triggerCollectionSchema,
  batchOperationSchema,
  AUTOMATION_CHUNK_CHARACTERS,
  AUTOMATION_MAX_SNAPSHOT_BYTES,
  type AutomationBaseline,
  type AutomationCollection,
  type AutomationUpdate,
} from '@axterm/plugin-api/automation';
const names: readonly AutomationCollection[] = ['quickCommands', 'triggers', 'batches'];
const invalid = (): never => {
  throw new Error('AUTOMATION_PROJECTION_INVALID');
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Stage bounded fragments privately; observers see only schema-validated atomic commits. */
export class AutomationProjection {
  private baseline: AutomationBaseline | undefined;
  private opening = true;
  private pending: Extract<AutomationUpdate, { type: 'begin' }> | undefined;
  private fragments = new Map<AutomationCollection, { text: string; final: boolean }>();
  private bytes = 0;
  reset(): void {
    this.opening = true;
    this.pending = undefined;
    this.fragments.clear();
    this.bytes = 0;
  }
  accept(frame: AutomationUpdate): AutomationBaseline | undefined {
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
        frame.text.length > AUTOMATION_CHUNK_CHARACTERS
      )
        invalid();
      this.bytes += new TextEncoder().encode(frame.text).byteLength;
      if (this.bytes > AUTOMATION_MAX_SNAPSHOT_BYTES) invalid();
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
    const selected = <T>(name: AutomationCollection, parse: (value: unknown) => T): T => {
      const entry = this.fragments.get(name);
      return entry ? parse(JSON.parse(entry.text)) : (this.baseline![name] as T);
    };
    const baseline: AutomationBaseline = freeze({
      generation: pending.generation,
      cursor: pending.cursor,
      quickCommands: selected('quickCommands', (value) => quickCommandTreeSchema.parse(value)),
      triggers: selected('triggers', (value) => triggerCollectionSchema.parse(value)),
      batches: selected('batches', (value) => batchOperationSchema.array().max(104).parse(value)),
    });
    this.baseline = baseline;
    this.opening = false;
    this.pending = undefined;
    this.fragments.clear();
    this.bytes = 0;
    return baseline;
  }
}
