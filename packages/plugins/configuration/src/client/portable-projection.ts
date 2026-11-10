import {
  CONFIGURATION_PORTABLE_CHUNK_CHARACTERS,
  CONFIGURATION_PORTABLE_MAX_SNAPSHOT_BYTES,
} from '@axterm/plugin-api/configuration-portable';
import {
  configurationPortableSnapshotSchema,
  type ConfigurationPortableBaseline,
  type ConfigurationPortableUpdate,
} from '@axterm/plugin-api/configuration-portable';
const invalid = (): never => {
  throw new Error('CONFIGURATION_PORTABLE_PROJECTION_INVALID');
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
/** Only complete schema-validated configuration previews cross the publication boundary. */
export class ConfigurationPortableProjection {
  private baseline: ConfigurationPortableBaseline | undefined;
  private opening = true;
  private pending: Extract<ConfigurationPortableUpdate, { type: 'begin' }> | undefined;
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
  accept(frame: ConfigurationPortableUpdate): ConfigurationPortableBaseline | undefined {
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
        frame.text.length > CONFIGURATION_PORTABLE_CHUNK_CHARACTERS
      )
        invalid();
      this.bytes += new TextEncoder().encode(frame.text).byteLength;
      if (this.bytes > CONFIGURATION_PORTABLE_MAX_SNAPSHOT_BYTES) invalid();
      this.text += frame.text;
      this.final = frame.final;
      return;
    }
    if (!this.final || frame.cursor !== pending.cursor) invalid();
    const baseline: ConfigurationPortableBaseline = freeze({
      generation: pending.generation,
      cursor: pending.cursor,
      previews: configurationPortableSnapshotSchema.parse(JSON.parse(this.text)).previews,
    });
    if (new Set(baseline.previews.map((item) => item.previewId)).size !== baseline.previews.length)
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
