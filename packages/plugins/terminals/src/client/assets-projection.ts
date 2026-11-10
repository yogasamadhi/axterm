import {
  terminalAssetsContentSchema,
  TERMINAL_ASSETS_CHUNK_CHARACTERS,
  TERMINAL_ASSETS_MAX_SNAPSHOT_BYTES,
  type TerminalAssetsBaseline,
  type TerminalAssetsUpdate,
} from '@axterm/plugin-api/terminals';
const invalid = (): never => {
  throw new Error('TERMINAL_ASSETS_PROJECTION_INVALID');
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
/** Only complete schema-validated terminal facts cross the publication boundary. */
export class TerminalAssetsProjection {
  private baseline: TerminalAssetsBaseline | undefined;
  private opening = true;
  private pending: Extract<TerminalAssetsUpdate, { type: 'begin' }> | undefined;
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
  accept(frame: TerminalAssetsUpdate): TerminalAssetsBaseline | undefined {
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
        frame.text.length > TERMINAL_ASSETS_CHUNK_CHARACTERS
      )
        invalid();
      this.bytes += new TextEncoder().encode(frame.text).byteLength;
      if (this.bytes > TERMINAL_ASSETS_MAX_SNAPSHOT_BYTES) invalid();
      this.text += frame.text;
      this.final = frame.final;
      return;
    }
    if (!this.final || frame.cursor !== pending.cursor) invalid();
    const baseline: TerminalAssetsBaseline = freeze({
      generation: pending.generation,
      cursor: pending.cursor,
      ...terminalAssetsContentSchema.parse(JSON.parse(this.text)),
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
