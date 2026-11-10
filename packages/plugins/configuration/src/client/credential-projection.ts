import {
  savedCredentialsSnapshotSchema,
  CREDENTIALS_CHUNK_CHARACTERS,
  CREDENTIALS_MAX_SNAPSHOT_BYTES,
  type SavedCredentialsBaseline,
  type SavedCredentialsUpdate,
} from '@axterm/plugin-api/saved-credentials';
const invalid = (): never => {
  throw new Error('CREDENTIALS_PROJECTION_INVALID');
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
/** Only complete schema-validated credential metadata cross the publication boundary. */
export class SavedCredentialsProjection {
  private baseline: SavedCredentialsBaseline | undefined;
  private opening = true;
  private pending: Extract<SavedCredentialsUpdate, { type: 'begin' }> | undefined;
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
  accept(frame: SavedCredentialsUpdate): SavedCredentialsBaseline | undefined {
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
        frame.text.length > CREDENTIALS_CHUNK_CHARACTERS
      )
        invalid();
      this.bytes += new TextEncoder().encode(frame.text).byteLength;
      if (this.bytes > CREDENTIALS_MAX_SNAPSHOT_BYTES) invalid();
      this.text += frame.text;
      this.final = frame.final;
      return;
    }
    if (!this.final || frame.cursor !== pending.cursor) invalid();
    const baseline: SavedCredentialsBaseline = freeze({
      generation: pending.generation,
      cursor: pending.cursor,
      credentials: savedCredentialsSnapshotSchema.parse(JSON.parse(this.text)).credentials,
    });
    if (new Set(baseline.credentials.map((item) => item.ref)).size !== baseline.credentials.length)
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
