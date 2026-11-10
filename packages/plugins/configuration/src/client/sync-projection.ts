import {
  SYNC_CHUNK_CHARACTERS,
  SYNC_MAX_SNAPSHOT_BYTES,
} from '@axterm/plugin-api/configuration-sync';
import {
  syncSnapshotSchema,
  type SyncBaseline,
  type SyncUpdate,
} from '@axterm/plugin-api/configuration-sync';
const invalid = (): never => {
  throw new Error('SYNC_PROJECTION_INVALID');
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
/** Only complete schema-validated sync metadata cross the publication boundary. */
export class SyncProjection {
  private baseline: SyncBaseline | undefined;
  private opening = true;
  private pending: Extract<SyncUpdate, { type: 'begin' }> | undefined;
  private text = '';
  private bytes = 0;
  private final = false;
  reset(): void {
    this.opening = true;
    this.pending = undefined;
    this.text = '';
    this.bytes = 0;
    this.final = false;
  }
  accept(frame: SyncUpdate): SyncBaseline | undefined {
    if (frame.type === 'begin') {
      if (
        this.pending ||
        !frame.generation ||
        !Number.isSafeInteger(frame.cursor) ||
        frame.cursor < 0
      )
        invalid();
      if (
        this.opening
          ? frame.mode !== 'baseline'
          : frame.mode !== 'replace' ||
            frame.generation !== this.baseline?.generation ||
            frame.cursor <= this.baseline.cursor
      )
        invalid();
      this.pending = frame;
      this.text = '';
      this.bytes = 0;
      this.final = false;
      return;
    }
    const pending = this.pending;
    if (!pending) return invalid();
    if (frame.type === 'chunk') {
      if (
        this.final ||
        frame.offset !== this.text.length ||
        !frame.text.length ||
        frame.text.length > SYNC_CHUNK_CHARACTERS
      )
        invalid();
      this.bytes += new TextEncoder().encode(frame.text).byteLength;
      if (this.bytes > SYNC_MAX_SNAPSHOT_BYTES) invalid();
      this.text += frame.text;
      this.final = frame.final;
      return;
    }
    if (!this.final || frame.cursor !== pending.cursor) invalid();
    const baseline: SyncBaseline = freeze({
      generation: pending.generation,
      cursor: pending.cursor,
      ...syncSnapshotSchema.parse(JSON.parse(this.text)),
    });
    if (
      new Set(baseline.profiles.map((item) => item.id)).size !== baseline.profiles.length ||
      new Set(baseline.runs.map((item) => item.commandId)).size !== baseline.runs.length
    )
      invalid();
    this.baseline = baseline;
    this.opening = false;
    this.pending = undefined;
    this.text = '';
    this.bytes = 0;
    this.final = false;
    return baseline;
  }
}
