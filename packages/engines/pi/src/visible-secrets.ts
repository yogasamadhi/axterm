import { EngineError } from '@axterm/engine-api';
interface Pattern {
  text: string;
  prefix: Uint32Array;
  matched: number;
}
interface Match {
  start: number;
  end: number;
}
/** Bounded literal redaction before an Engine event is acknowledged. Handles split and overlapping secrets. */
export class VisibleSecrets {
  private readonly patterns: Pattern[];
  private matches: Match[] = [];
  private pending = '';
  private offset = 0;
  private received = 0;
  private emitted = 0;
  private ended = false;
  constructor(
    secrets: readonly string[],
    private readonly maximumBytes = 2 * 1024 * 1024,
  ) {
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 1 ||
      maximumBytes > 2 * 1024 * 1024 ||
      !Array.isArray(secrets) ||
      secrets.some((text) => typeof text !== 'string')
    )
      throw new EngineError('invalid');
    const unique = [...new Set(secrets.filter(Boolean))];
    if (unique.length > 33 || unique.some((text) => text.length > 131072))
      throw new EngineError('capacity');
    this.patterns = unique.map((text) => {
      const prefix = new Uint32Array(text.length);
      for (let i = 1, length = 0; i < text.length; i++) {
        while (length && text[i] !== text[length]) length = prefix[length - 1]!;
        if (text[i] === text[length]) length++;
        prefix[i] = length;
      }
      return { text, prefix, matched: 0 };
    });
  }
  push(text: string): string {
    if (this.ended) throw new EngineError('closed');
    this.received += Buffer.byteLength(text, 'utf8');
    if (this.received > this.maximumBytes) this.fail();
    const start = this.offset + this.pending.length;
    this.pending += text;
    for (let i = 0; i < text.length; i++)
      for (const pattern of this.patterns) {
        while (pattern.matched && text[i] !== pattern.text[pattern.matched])
          pattern.matched = pattern.prefix[pattern.matched - 1]!;
        if (text[i] === pattern.text[pattern.matched]) pattern.matched++;
        if (pattern.matched === pattern.text.length) {
          this.matches.push({ start: start + i + 1 - pattern.text.length, end: start + i + 1 });
          if (this.matches.length > 8192) this.fail();
          pattern.matched = pattern.prefix[pattern.matched - 1]!;
        }
      }
    let cut =
      this.offset +
      this.pending.length -
      Math.max(0, ...this.patterns.map((pattern) => pattern.matched));
    const before = this.pending.charCodeAt(cut - this.offset - 1);
    if (before >= 0xd800 && before <= 0xdbff) cut--;
    for (let i = this.matches.length - 1; i >= 0; i--) {
      const match = this.matches[i]!;
      if (match.start < cut && match.end > cut) cut = match.start;
    }
    return this.consume(Math.max(this.offset, cut));
  }
  finish(): string {
    if (this.ended) throw new EngineError('closed');
    this.ended = true;
    return this.consume(this.offset + this.pending.length);
  }
  discard(): void {
    this.ended = true;
    this.pending = '';
    this.matches = [];
    for (const pattern of this.patterns) pattern.matched = 0;
  }
  private consume(cut: number): string {
    const selected = this.matches
      .filter((match) => match.end <= cut)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const groups: Match[] = [];
    for (const match of selected) {
      const last = groups.at(-1);
      if (last && match.start < last.end) last.end = Math.max(last.end, match.end);
      else groups.push({ ...match });
    }
    let cursor = this.offset;
    let output = '';
    for (const match of groups) {
      output +=
        this.pending.slice(cursor - this.offset, match.start - this.offset) +
        '[REDACTED_KNOWN_SECRET]';
      cursor = match.end;
      if (Buffer.byteLength(output) + this.emitted > this.maximumBytes) this.fail();
    }
    output += this.pending.slice(cursor - this.offset, cut - this.offset);
    this.emitted += Buffer.byteLength(output);
    if (this.emitted > this.maximumBytes) this.fail();
    this.pending = this.pending.slice(cut - this.offset);
    this.offset = cut;
    this.matches = this.matches.filter((match) => match.end > cut);
    return output;
  }
  private fail(): never {
    this.discard();
    throw new EngineError('capacity');
  }
}
