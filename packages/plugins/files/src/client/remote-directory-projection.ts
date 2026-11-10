import {
  remoteDirectoryListingSchema,
  FILE_GRANTS_CHUNK_CHARACTERS,
  FILE_GRANTS_MAX_SNAPSHOT_BYTES,
  type RemoteDirectoryBaseline,
  type RemoteDirectoryUpdate,
} from '@axterm/plugin-api/files';
const invalid = (): never => {
  throw new Error('REMOTE_DIRECTORY_PROJECTION_INVALID');
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
/** Only complete schema-validated directory entries cross the publication boundary. */
export class RemoteDirectoryProjection {
  private baseline: RemoteDirectoryBaseline | undefined;
  private opening = true;
  private pending: Extract<RemoteDirectoryUpdate, { type: 'begin' }> | undefined;
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
  accept(frame: RemoteDirectoryUpdate): RemoteDirectoryBaseline | undefined {
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
        frame.text.length > FILE_GRANTS_CHUNK_CHARACTERS
      )
        invalid();
      this.bytes += new TextEncoder().encode(frame.text).byteLength;
      if (this.bytes > FILE_GRANTS_MAX_SNAPSHOT_BYTES) invalid();
      this.text += frame.text;
      this.final = frame.final;
      return;
    }
    if (!this.final || frame.cursor !== pending.cursor) invalid();
    const baseline: RemoteDirectoryBaseline = freeze({
      generation: pending.generation,
      cursor: pending.cursor,
      ...remoteDirectoryListingSchema.parse(JSON.parse(this.text)),
    });
    this.baseline = baseline;
    this.opening = false;
    this.pending = undefined;
    this.text = '';
    this.bytes = 0;
    this.final = false;
    return baseline;
  }
}
