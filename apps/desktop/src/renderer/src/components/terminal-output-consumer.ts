import {
  TERMINAL_OUTPUT_FRAME_MAX_BYTES,
  TERMINAL_OUTPUT_PENDING_MAX_BYTES,
  TERMINAL_OUTPUT_PENDING_MAX_FRAMES,
  type TerminalOutputFlow,
} from '@workspace/contracts';

export interface TerminalOutputMetrics {
  receivedBytes: number;
  consumedBytes: number;
  pendingBytes: number;
  peakPendingBytes: number;
  writeCalls: number;
  completedWrites: number;
  abandonedBytes: number;
  peakCallbackMs: number;
  disposed: boolean;
}

interface OutputWriter {
  write(data: string | Uint8Array, consumed: () => void): void;
}

/** Accounts for the public parser-completion callback. It retains no output or intermediate queue. */
export class TerminalOutputConsumer {
  private flow: TerminalOutputFlow | undefined;
  private lastAcknowledgedBytes = 0;
  private acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
  private state: TerminalOutputMetrics = {
    receivedBytes: 0,
    consumedBytes: 0,
    pendingBytes: 0,
    peakPendingBytes: 0,
    writeCalls: 0,
    completedWrites: 0,
    abandonedBytes: 0,
    peakCallbackMs: 0,
    disposed: false,
  };

  constructor(
    private readonly writer: OutputWriter,
    private readonly now: () => number,
    private readonly progress: (metrics: TerminalOutputMetrics) => void,
    private readonly acknowledge?: (streamId: string, consumedBytes: number) => void,
  ) {}

  configureFlow(flow: TerminalOutputFlow): boolean {
    if (this.flow || this.state.disposed || this.state.receivedBytes !== 0) return false;
    this.flow = flow;
    return true;
  }

  snapshot(): TerminalOutputMetrics {
    return { ...this.state };
  }

  write(
    data: string | Uint8Array | (() => string | Uint8Array),
    rawBytes: number,
    afterConsumed?: () => void,
  ): boolean {
    if (this.state.disposed) return false;
    if (!Number.isSafeInteger(rawBytes) || rawBytes < 0) throw new RangeError('Invalid byte count');
    if (
      rawBytes > TERMINAL_OUTPUT_FRAME_MAX_BYTES ||
      rawBytes === 0 ||
      this.state.writeCalls - this.state.completedWrites >= TERMINAL_OUTPUT_PENDING_MAX_FRAMES ||
      this.state.pendingBytes + rawBytes > TERMINAL_OUTPUT_PENDING_MAX_BYTES ||
      !Number.isSafeInteger(this.state.receivedBytes + rawBytes)
    )
      return false;
    const output = typeof data === 'function' ? data() : data;
    const startedAt = this.now();
    this.state.receivedBytes += rawBytes;
    this.state.pendingBytes += rawBytes;
    this.state.peakPendingBytes = Math.max(this.state.peakPendingBytes, this.state.pendingBytes);
    this.state.writeCalls += 1;
    this.progress(this.snapshot());
    let completed = false;
    try {
      this.writer.write(output, () => {
        if (completed || this.state.disposed) return;
        completed = true;
        this.state.pendingBytes -= rawBytes;
        this.state.consumedBytes += rawBytes;
        this.state.completedWrites += 1;
        this.state.peakCallbackMs = Math.max(this.state.peakCallbackMs, this.now() - startedAt);
        this.progress(this.snapshot());
        afterConsumed?.();
        if (!this.state.disposed && this.flow) this.scheduleAcknowledgement();
      });
    } catch {
      this.dispose();
      return false;
    }
    return true;
  }

  dispose(): void {
    if (this.state.disposed) return;
    this.flushAcknowledgement();
    this.state.disposed = true;
    this.state.abandonedBytes += this.state.pendingBytes;
    this.state.pendingBytes = 0;
    this.progress(this.snapshot());
  }

  private scheduleAcknowledgement(): void {
    if (this.state.consumedBytes - this.lastAcknowledgedBytes >= 32 * 1024) {
      this.flushAcknowledgement();
      return;
    }
    this.acknowledgementTimer ??= setTimeout(() => this.flushAcknowledgement(), 25);
  }

  private flushAcknowledgement(): void {
    if (this.acknowledgementTimer) clearTimeout(this.acknowledgementTimer);
    this.acknowledgementTimer = undefined;
    if (
      this.state.disposed ||
      !this.flow ||
      this.state.consumedBytes === this.lastAcknowledgedBytes
    )
      return;
    this.lastAcknowledgedBytes = this.state.consumedBytes;
    this.acknowledge?.(this.flow.streamId, this.lastAcknowledgedBytes);
  }
}
