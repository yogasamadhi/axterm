import { ApplicationError } from './errors.ts';

const assignments = [
  'api_key',
  'api-key',
  'api key',
  'apikey',
  'password',
  'passphrase',
  'token',
  'secret',
];
const prefixes = [
  ...assignments,
  'bearer',
  'authorization',
  'sk-',
  'akia',
  'asia',
  'aiza',
  '-----begin ',
];
type State = 'scan' | 'quoted' | 'value' | 'bearer' | 'api' | 'private';
/** Incremental visible-content policy. Never acknowledges a possible credential prefix.
 * Ordinary text streams as soon as it is distinguishable; secret values are discarded,
 * including escaped quotes and multiline values. No classifier stream belongs here. */
export class VisibleOutput {
  private pending = '';
  private state: State = 'scan';
  private quote = '';
  private escaped = false;
  private privateTail = '';
  private previous = '';
  private received = 0;
  private emitted = 0;
  private closed = false;
  constructor(private readonly maximumBytes = 2 * 1024 * 1024) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 2 * 1024 * 1024)
      throw new ApplicationError('VALIDATION_ERROR', 'Invalid AI visible output limit');
  }
  push(text: string): string {
    if (this.closed) throw new ApplicationError('INVALID_STATE', 'AI visible output closed');
    this.received += Buffer.byteLength(text);
    if (this.received > this.maximumBytes) this.fail();
    this.pending += text;
    return this.flush(false);
  }
  finish(): string {
    if (this.closed) throw new ApplicationError('INVALID_STATE', 'AI visible output closed');
    const output = this.flush(true);
    this.discard();
    return output;
  }
  discard(): void {
    this.closed = true;
    this.pending = '';
    this.privateTail = '';
    this.quote = '';
    this.previous = '';
  }
  private flush(final: boolean): string {
    let offset = 0;
    let output = '';
    const consume = (length: number) => {
      if (length) this.previous = this.pending[offset + length - 1]!;
      offset += length;
    };
    while (offset < this.pending.length) {
      const character = this.pending[offset]!;
      if (this.state === 'quoted') {
        consume(1);
        if (this.escaped) this.escaped = false;
        else if (character === '\\') this.escaped = true;
        else if (character === this.quote) {
          this.state = 'scan';
          this.quote = '';
        }
        continue;
      }
      if (this.state === 'private') {
        consume(1);
        this.privateTail = (this.privateTail + character).slice(-256);
        if (/-----END [A-Z ]*PRIVATE KEY-----$/i.test(this.privateTail)) {
          this.privateTail = '';
          this.state = 'scan';
        }
        continue;
      }
      if (this.state !== 'scan') {
        const accepts =
          this.state === 'value'
            ? !/[\s,;}\]]/u.test(character)
            : this.state === 'bearer'
              ? /[A-Za-z0-9._~+/=-]/u.test(character)
              : /[A-Za-z0-9_-]/u.test(character);
        if (accepts) {
          consume(1);
          continue;
        }
        this.state = 'scan';
        continue;
      }
      const rest = this.pending.slice(offset);
      const boundary = !/[A-Za-z0-9_]/u.test(this.previous);
      if (boundary) {
        const lower = rest.toLowerCase();
        if (!final && prefixes.some((prefix) => prefix.startsWith(lower))) break;
        const assignment = assignments.find((key) => lower.startsWith(key));
        if (assignment) {
          const tail = rest.slice(assignment.length);
          const separator = /^["']?\s*[:=]\s*/u.exec(tail);
          if (separator) {
            const value = tail.slice(separator[0].length);
            if (!value && !final) break;
            if (
              !final &&
              ('[REDACTED'.startsWith(value) || /^\[REDACTED(?:_[A-Z_]*)?$/u.test(value))
            )
              break;
            if (value) {
              output += rest.slice(0, assignment.length) + '=[REDACTED]';
              consume(assignment.length + separator[0].length);
              if (value[0] === '"' || value[0] === "'") {
                this.state = 'quoted';
                this.quote = value[0];
                this.escaped = false;
                consume(1);
              } else {
                const marker = /^\[REDACTED(?:_[A-Z_]+)?\]/u.exec(value);
                if (marker) consume(marker[0].length);
                this.state = 'value';
              }
              continue;
            }
          } else if (!final && /^["']?\s*$/u.test(tail)) break;
        }
        const bearer = /^Bearer\s+/iu.exec(rest);
        const basic = /^Authorization\s*:\s*Basic\s+/iu.exec(rest);
        const header = bearer ?? basic;
        if (header) {
          const value = rest.slice(header[0].length);
          if (!value && !final) break;
          if (/^[A-Za-z0-9._~+/=-]/u.test(value)) {
            output += header[0] + '[REDACTED]';
            consume(header[0].length);
            this.state = 'bearer';
            continue;
          }
        } else if (
          !final &&
          /^(?:Bearer\s*|Authorization\s*(?::\s*(?:B(?:a(?:s(?:i(?:c)?)?)?)?)?)?)$/iu.test(rest)
        )
          break;
        const key =
          /^(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35})/u.exec(
            rest,
          );
        if (key) {
          output += rest.startsWith('sk-') ? '[REDACTED_API_KEY]' : '[REDACTED_CLOUD_KEY]';
          consume(key[0].length);
          this.state = 'api';
          continue;
        }
        if (
          !final &&
          /^(?:sk-[A-Za-z0-9_-]*|(?:AKIA|ASIA)[A-Z0-9]*|AIza[A-Za-z0-9_-]*)$/u.test(rest)
        )
          break;
        const privateHeader = /^-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.exec(rest);
        if (privateHeader) {
          output += '[REDACTED_PRIVATE_KEY]';
          consume(privateHeader[0].length);
          this.state = 'private';
          continue;
        }
        if (!final && /^-----BEGIN [A-Z -]*$/iu.test(rest)) {
          if (rest.length > 256) this.fail();
          break;
        }
      }
      if (!final && offset === this.pending.length - 1 && /[\uD800-\uDBFF]/u.test(character)) break;
      output += character;
      consume(1);
    }
    this.pending = this.pending.slice(offset);
    this.emitted += Buffer.byteLength(output);
    if (this.emitted > this.maximumBytes) this.fail();
    return output;
  }
  private fail(): never {
    this.discard();
    throw new ApplicationError('CAPACITY_EXCEEDED', 'AI visible output capacity reached');
  }
}
