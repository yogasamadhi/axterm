import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import type { TerminalBehavior } from '@axterm/plugin-api/terminals';

export const OSC52_MAX_BASE64_CHARACTERS = 52 * 1024;
export const OSC52_MAX_DECODED_BYTES = 36 * 1024;
export const OSC52_MAX_RESPONSE_BYTES = 48 * 1024;
export const OSC52_CLIPBOARD_TIMEOUT_MS = 3_000;

const OSC52_RESPONSE_PREFIX = '\x1b]52;c;';
const OSC52_RESPONSE_SUFFIX = '\x07';
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type Osc52FailureCode =
  | 'DISABLED'
  | 'MALFORMED_REQUEST'
  | 'UNSUPPORTED_TARGET'
  | 'READ_DENIED'
  | 'WRITE_DENIED'
  | 'INVALID_BASE64'
  | 'INVALID_UTF8'
  | 'PAYLOAD_TOO_LARGE'
  | 'RESPONSE_TOO_LARGE'
  | 'CLIPBOARD_BUSY'
  | 'CLIPBOARD_UNAVAILABLE'
  | 'CLIPBOARD_TIMEOUT'
  | 'CLIPBOARD_FAILED'
  | 'INPUT_UNAVAILABLE';

export type Osc52FeedbackCode = Osc52FailureCode | 'READ_SUCCEEDED' | 'WRITE_SUCCEEDED';

export type Osc52Request =
  { kind: 'read'; target: 'c' } | { kind: 'write'; target: 'c'; text: string };

export class Osc52RequestError extends Error {
  constructor(readonly code: Osc52FailureCode) {
    super(code);
    this.name = 'Osc52RequestError';
  }
}

export function parseOsc52Request(data: string): Osc52Request {
  const separator = data.indexOf(';');
  if (separator < 0) throw new Osc52RequestError('MALFORMED_REQUEST');
  const target = separator < 0 ? data : data.slice(0, separator);
  const payload = separator < 0 ? '' : data.slice(separator + 1);
  if (target !== 'c') throw new Osc52RequestError('UNSUPPORTED_TARGET');
  if (payload === '?') return { kind: 'read', target: 'c' };
  return { kind: 'write', target: 'c', text: decodeOsc52Payload(payload) };
}

export function decodeOsc52Payload(payload: string): string {
  if (
    payload.length > OSC52_MAX_BASE64_CHARACTERS ||
    payload.length % 4 !== 0 ||
    !STRICT_BASE64.test(payload)
  )
    throw new Osc52RequestError(
      payload.length > OSC52_MAX_BASE64_CHARACTERS ? 'PAYLOAD_TOO_LARGE' : 'INVALID_BASE64',
    );
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    throw new Osc52RequestError('INVALID_BASE64');
  }
  if (btoa(binary) !== payload) throw new Osc52RequestError('INVALID_BASE64');
  if (binary.length > OSC52_MAX_DECODED_BYTES) throw new Osc52RequestError('PAYLOAD_TOO_LARGE');
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Osc52RequestError('INVALID_UTF8');
  }
}

export function buildOsc52ClipboardResponse(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > OSC52_MAX_DECODED_BYTES) throw new Osc52RequestError('RESPONSE_TOO_LARGE');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8_192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  const response = `${OSC52_RESPONSE_PREFIX}${btoa(binary)}${OSC52_RESPONSE_SUFFIX}`;
  if (new TextEncoder().encode(response).byteLength > OSC52_MAX_RESPONSE_BYTES)
    throw new Osc52RequestError('RESPONSE_TOO_LARGE');
  return response;
}

interface Osc52Clipboard {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

interface Osc52AddonOptions {
  policy: TerminalBehavior;
  sendData(data: string): boolean;
  feedback(code: Osc52FeedbackCode, tone: 'success' | 'error'): void;
  getClipboard?(): Partial<Osc52Clipboard> | undefined;
  timeoutMs?: number;
}

export class Osc52Addon implements ITerminalAddon {
  private handler: { dispose(): void } | undefined;
  private disposed = false;
  private readonly lifetime = new AbortController();
  private readonly operations = new Set<Promise<unknown>>();

  constructor(private readonly options: Osc52AddonOptions) {}

  activate(terminal: Terminal): void {
    if (this.disposed) throw Error('OSC52_ADDON_RETIRED');
    this.handler?.dispose();
    this.handler = terminal.parser.registerOscHandler(52, (data) => this.handle(data));
  }

  dispose(): void {
    this.disposed = true;
    this.lifetime.abort();
    this.handler?.dispose();
    this.handler = undefined;
  }

  async drain(): Promise<void> {
    this.dispose();
    await Promise.allSettled([...this.operations]);
  }

  private operation<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    const release = () => this.operations.delete(operation);
    void operation.then(release, release);
    return clipboardTimeout(
      operation,
      this.options.timeoutMs ?? OSC52_CLIPBOARD_TIMEOUT_MS,
      this.lifetime.signal,
    );
  }

  private async handle(data: string): Promise<boolean> {
    try {
      if (this.disposed) return true;
      if (!this.options.policy.osc52Enabled) throw new Osc52RequestError('DISABLED');
      const request = parseOsc52Request(data);
      if (request.kind === 'read') {
        if (this.options.policy.osc52ReadPolicy !== 'allow')
          throw new Osc52RequestError('READ_DENIED');
        const clipboard = this.clipboard();
        if (!clipboard.readText) throw new Osc52RequestError('CLIPBOARD_UNAVAILABLE');
        if (this.operations.size) throw new Osc52RequestError('CLIPBOARD_BUSY');
        const text = await this.operation(clipboard.readText());
        const response = buildOsc52ClipboardResponse(text);
        if (!this.disposed) {
          if (!this.options.sendData(response)) throw new Osc52RequestError('INPUT_UNAVAILABLE');
          this.options.feedback('READ_SUCCEEDED', 'success');
        }
        return true;
      }
      if (this.options.policy.osc52WritePolicy !== 'allow')
        throw new Osc52RequestError('WRITE_DENIED');
      const clipboard = this.clipboard();
      if (!clipboard.writeText) throw new Osc52RequestError('CLIPBOARD_UNAVAILABLE');
      if (this.operations.size) throw new Osc52RequestError('CLIPBOARD_BUSY');
      await this.operation(clipboard.writeText(request.text));
      if (!this.disposed) this.options.feedback('WRITE_SUCCEEDED', 'success');
      return true;
    } catch (error) {
      if (!this.disposed)
        this.options.feedback(
          error instanceof Osc52RequestError
            ? error.code
            : error instanceof Osc52TimeoutError
              ? 'CLIPBOARD_TIMEOUT'
              : 'CLIPBOARD_FAILED',
          'error',
        );
      return true;
    }
  }

  private clipboard(): Partial<Osc52Clipboard> {
    const clipboard = this.options.getClipboard?.() ?? navigator.clipboard;
    if (!clipboard) throw new Osc52RequestError('CLIPBOARD_UNAVAILABLE');
    return clipboard;
  }
}

class Osc52TimeoutError extends Error {}

async function clipboardTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  let abort = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('OSC52_CLOSED'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Osc52TimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}
