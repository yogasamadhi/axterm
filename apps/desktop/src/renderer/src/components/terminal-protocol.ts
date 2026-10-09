import {
  TERMINAL_INPUT_FRAME_MAX_BYTES,
  terminalServerControlSchema,
  type TerminalServerControl,
} from '@workspace/contracts';

export const TERMINAL_INPUT_CHUNK_BYTES = 32 * 1024;
export const TERMINAL_INPUT_MAX_BYTES = 1024 * 1024;
export const TERMINAL_INPUT_QUEUE_MAX_BYTES = 1024 * 1024;
export const TERMINAL_CONTROL_MAX_CHARS = 4 * 1024;

if (TERMINAL_INPUT_CHUNK_BYTES >= TERMINAL_INPUT_FRAME_MAX_BYTES)
  throw new Error('Terminal input chunks must stay below the Runtime frame limit');

export type DecodedTerminalMessage =
  | { kind: 'binary'; data: Uint8Array }
  | { kind: 'control'; control: TerminalServerControl }
  | { kind: 'invalid'; code: 'INVALID_CONTROL_MESSAGE' | 'INVALID_BINARY_MESSAGE' };

export function decodeTerminalMessage(data: unknown): DecodedTerminalMessage {
  if (typeof data === 'string') {
    if (data.length > TERMINAL_CONTROL_MAX_CHARS)
      return { kind: 'invalid', code: 'INVALID_CONTROL_MESSAGE' };
    try {
      const parsed = terminalServerControlSchema.safeParse(JSON.parse(data));
      return parsed.success
        ? { kind: 'control', control: parsed.data }
        : { kind: 'invalid', code: 'INVALID_CONTROL_MESSAGE' };
    } catch {
      return { kind: 'invalid', code: 'INVALID_CONTROL_MESSAGE' };
    }
  }
  if (data instanceof ArrayBuffer) return { kind: 'binary', data: new Uint8Array(data) };
  if (ArrayBuffer.isView(data))
    return {
      kind: 'binary',
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    };
  return { kind: 'invalid', code: 'INVALID_BINARY_MESSAGE' };
}

export function splitUtf8Input(
  text: string,
):
  | { accepted: true; byteLength: number; frames: Uint8Array[] }
  | { accepted: false; byteLength: number; code: 'TERMINAL_INPUT_TOO_LARGE' } {
  // Bound the allocation before encoding. A UTF-16 code unit expands to at
  // most three UTF-8 bytes, so this also caps pathological pasted strings.
  if (text.length > TERMINAL_INPUT_MAX_BYTES)
    return {
      accepted: false,
      byteLength: text.length,
      code: 'TERMINAL_INPUT_TOO_LARGE',
    };
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > TERMINAL_INPUT_MAX_BYTES)
    return {
      accepted: false,
      byteLength: bytes.byteLength,
      code: 'TERMINAL_INPUT_TOO_LARGE',
    };
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    let end = Math.min(offset + TERMINAL_INPUT_CHUNK_BYTES, bytes.byteLength);
    if (end < bytes.byteLength) {
      while (end > offset && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    }
    if (end === offset) end = Math.min(offset + TERMINAL_INPUT_CHUNK_BYTES, bytes.byteLength);
    frames.push(bytes.slice(offset, end));
    offset = end;
  }
  return { accepted: true, byteLength: bytes.byteLength, frames };
}

export type TerminalInputIssue =
  | 'TERMINAL_INPUT_TOO_LARGE'
  | 'TERMINAL_INPUT_QUEUE_FULL'
  | 'TERMINAL_INPUT_UNAVAILABLE'
  | 'TERMINAL_INPUT_CANCELED';

interface InputSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
}

export class TerminalInputSender {
  private readonly queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly socket: InputSocket,
    private readonly onIssue: (issue: TerminalInputIssue) => void,
  ) {}

  enqueue(text: string): boolean {
    if (this.disposed || this.socket.readyState !== 1) {
      this.onIssue('TERMINAL_INPUT_UNAVAILABLE');
      return false;
    }
    const split = splitUtf8Input(text);
    if (!split.accepted) {
      this.onIssue(split.code);
      return false;
    }
    if (this.queuedBytes + split.byteLength > TERMINAL_INPUT_QUEUE_MAX_BYTES) {
      this.onIssue('TERMINAL_INPUT_QUEUE_FULL');
      return false;
    }
    this.queue.push(...split.frames);
    this.queuedBytes += split.byteLength;
    this.flush();
    return true;
  }

  cancel(report = false): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const hadPendingInput = this.queuedBytes > 0;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.disposed = true;
    if (report && hadPendingInput) this.onIssue('TERMINAL_INPUT_CANCELED');
  }

  private flush(): void {
    if (this.disposed) return;
    if (this.socket.readyState !== 1) {
      this.cancel(true);
      return;
    }
    while (this.queue.length && this.socket.bufferedAmount < TERMINAL_INPUT_QUEUE_MAX_BYTES / 4) {
      const frame = this.queue.shift()!;
      try {
        this.socket.send(frame);
      } catch {
        this.cancel(true);
        return;
      }
      this.queuedBytes -= frame.byteLength;
    }
    if (!this.queue.length || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 16);
  }
}
