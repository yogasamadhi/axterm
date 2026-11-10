import {
  idSchema,
  TERMINAL_STREAM_PATH,
  terminalControlSchema,
  type TerminalServerControl,
} from '@axterm/plugin-api/terminals';
import type { ConnectionHandle, ConnectionWebSocket } from '@axterm/infra-connection/client';
import { TerminalOutputConsumer, type TerminalOutputMetrics } from './terminal-output-consumer.ts';
import {
  decodeTerminalMessage,
  TerminalInputSender,
  type TerminalInputIssue,
} from './terminal-protocol.ts';

export type TerminalStreamIssue =
  | TerminalInputIssue
  | 'TERMINAL_PROTOCOL_INVALID'
  | 'TERMINAL_OUTPUT_LIMIT'
  | 'TERMINAL_STREAM_UNAVAILABLE';
export interface TerminalStreamOptions {
  readonly terminalId: string;
  /** Invoked only after raw frame budgets pass; acknowledgements still count original bytes. */
  readonly decodeOutput?: (bytes: Uint8Array) => string | Uint8Array;
  readonly clientId?: string;
  /** The xterm parser-completion callback controls output acknowledgement. */
  readonly writer: { write(bytes: string | Uint8Array, consumed: () => void): void };
  readonly control?: (control: TerminalServerControl) => void;
  readonly progress?: (metrics: TerminalOutputMetrics) => void;
  /** Replay remains active until its final parser callback, never merely socket receipt. */
  readonly replay?: (active: boolean) => void;
  readonly issue?: (issue: TerminalStreamIssue) => void;
  readonly closed?: () => void;
  readonly signal?: AbortSignal;
}

/** Owns one byte channel. Generation changes close it; no pending input is replayed. */
export class TerminalStream {
  private readonly socket: ConnectionWebSocket;
  private replayIdentity = Symbol('terminal replay');
  private replayBytes = 0;
  private readonly input: TerminalInputSender;
  private readonly output: TerminalOutputConsumer;
  private readonly unsubscribe: () => void;
  private readonly readyTimer: ReturnType<typeof setTimeout>;
  private ready = false;
  private disposed = false;
  constructor(
    connection: Pick<ConnectionHandle, 'generation' | 'openWebSocket'>,
    private readonly options: TerminalStreamOptions,
  ) {
    options.signal?.throwIfAborted();
    const generation = connection.generation.getSnapshot();
    if (!generation) throw new Error('TERMINAL_GENERATION_UNAVAILABLE');
    const terminalId = idSchema.parse(options.terminalId);
    const clientId = idSchema.parse(options.clientId ?? crypto.randomUUID());
    this.socket = connection.openWebSocket(
      TERMINAL_STREAM_PATH + '?' + new URLSearchParams({ id: terminalId, clientId }),
    );
    this.socket.binaryType = 'arraybuffer';
    const socket = this.socket;
    this.input = new TerminalInputSender(
      {
        get readyState() {
          return socket.readyState;
        },
        get bufferedAmount() {
          return socket.bufferedAmount ?? 0;
        },
        send: (data) => socket.send(data),
      },
      (issue) => this.notifyIssue(issue),
    );
    this.output = new TerminalOutputConsumer(
      options.writer,
      () => performance.now(),
      (metrics) => options.progress?.(metrics),
      (streamId, consumedBytes) => {
        this.sendControl({ type: 'outputConsumed', streamId, consumedBytes });
      },
    );
    socket.addEventListener('message', this.message);
    socket.addEventListener('close', this.dispose);
    socket.addEventListener('error', this.failed);
    this.readyTimer = setTimeout(this.failed, 15_000);
    this.unsubscribe = connection.generation.subscribe(() => {
      if (connection.generation.getSnapshot() !== generation) this.dispose();
    });
    options.signal?.addEventListener('abort', this.dispose, { once: true });
    if (options.signal?.aborted || connection.generation.getSnapshot() !== generation)
      this.dispose();
  }
  sendInput(text: string): boolean {
    if (!this.ready || this.disposed) {
      this.notifyIssue('TERMINAL_INPUT_UNAVAILABLE');
      return false;
    }
    return this.input.enqueue(text);
  }
  resize(cols: number, rows: number): boolean {
    return this.sendControl({ type: 'resize', cols, rows });
  }
  ping(nonce: string): boolean {
    return this.sendControl({ type: 'ping', nonce });
  }
  metrics(): TerminalOutputMetrics {
    return this.output.snapshot();
  }
  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    clearTimeout(this.readyTimer);
    this.unsubscribe();
    this.options.signal?.removeEventListener('abort', this.dispose);
    this.socket.removeEventListener('message', this.message);
    this.socket.removeEventListener('close', this.dispose);
    this.socket.removeEventListener('error', this.failed);
    this.input.cancel();
    try {
      this.output.dispose();
    } catch {
      /* Observer failures cannot retain a socket. */
    }
    try {
      this.socket.close(1000, 'terminal channel closed');
    } catch {
      /* Already closed. */
    }
    try {
      this.options.closed?.();
    } catch {
      console.warn('TERMINAL_STREAM_OBSERVER_FAILED');
    }
  };
  private failed = (): void => {
    this.notifyIssue('TERMINAL_STREAM_UNAVAILABLE');
    this.dispose();
  };
  private notifyIssue(issue: TerminalStreamIssue): void {
    try {
      this.options.issue?.(issue);
    } catch {
      console.warn('TERMINAL_STREAM_OBSERVER_FAILED');
    }
  }
  private sendControl(value: unknown): boolean {
    if (!this.ready || this.disposed || this.socket.readyState !== 1) return false;
    const control = terminalControlSchema.safeParse(value);
    if (!control.success || (this.socket.bufferedAmount ?? 0) > 1024 * 1024) return false;
    try {
      this.socket.send(JSON.stringify(control.data));
      return true;
    } catch {
      this.failed();
      return false;
    }
  }
  private message = (event: { readonly data: unknown }): void => {
    if (this.disposed) return;
    try {
      const message = decodeTerminalMessage(event.data);
      if (message.kind === 'invalid') {
        this.notifyIssue('TERMINAL_PROTOCOL_INVALID');
        this.dispose();
        return;
      }
      if (message.kind === 'binary') {
        if (!this.ready) {
          this.notifyIssue('TERMINAL_PROTOCOL_INVALID');
          this.dispose();
          return;
        }
        let replayConsumed: (() => void) | undefined;
        if (this.replayBytes > 0) {
          if (message.data.byteLength > this.replayBytes) {
            this.notifyIssue('TERMINAL_PROTOCOL_INVALID');
            this.dispose();
            return;
          }
          this.replayBytes -= message.data.byteLength;
          if (this.replayBytes === 0) {
            const identity = this.replayIdentity;
            replayConsumed = () => {
              if (this.replayIdentity === identity) this.options.replay?.(false);
            };
          }
        }
        if (
          !this.output.write(
            () => this.options.decodeOutput?.(message.data) ?? message.data,
            message.data.byteLength,
            replayConsumed,
          )
        ) {
          this.notifyIssue('TERMINAL_OUTPUT_LIMIT');
          this.dispose();
        }
        return;
      }
      const control = message.control;
      if (control.type === 'ready') {
        if (this.ready || !control.outputFlow || !this.output.configureFlow(control.outputFlow)) {
          this.notifyIssue('TERMINAL_PROTOCOL_INVALID');
          this.dispose();
          return;
        }
        this.ready = true;
        clearTimeout(this.readyTimer);
      }
      if (control.type === 'replay') {
        if (!this.ready || this.replayBytes > 0) {
          this.notifyIssue('TERMINAL_PROTOCOL_INVALID');
          this.dispose();
          return;
        }
        this.replayBytes = control.byteLength;
        if (this.replayBytes > 0) {
          this.replayIdentity = Symbol('terminal replay');
          this.options.replay?.(true);
        }
      }
      this.options.control?.(control);
    } catch {
      this.failed();
    }
  };
}
