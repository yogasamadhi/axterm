import {
  TERMINAL_OUTPUT_FRAME_MAX_BYTES,
  TERMINAL_OUTPUT_HIGH_WATER_BYTES,
  TERMINAL_OUTPUT_LOW_WATER_BYTES,
  TERMINAL_OUTPUT_PENDING_MAX_BYTES,
  TERMINAL_OUTPUT_PENDING_MAX_FRAMES,
  type TerminalOutputFlow,
} from '@workspace/contracts';

export const OUTPUT_FLOW_HIGH_WATER_FRAMES = 4_096;
export const OUTPUT_FLOW_MAX_PENDING_FRAMES = TERMINAL_OUTPUT_PENDING_MAX_FRAMES;

/** Socket-local credit and whole-source-chunk checkpoints. Contains no terminal bytes. */
export class TerminalOutputWindow {
  private sentBytes = 0;
  private consumedBytes = 0;
  private disposed = false;
  private readonly checkpoints: Array<{ endBytes: number; sequence: number }> = [];
  lastSentSequence: number;
  lastConsumedSequence: number;

  constructor(
    readonly streamId: string,
    initialSequence: number,
  ) {
    this.lastSentSequence = initialSequence;
    this.lastConsumedSequence = initialSequence;
  }

  metadata(): TerminalOutputFlow {
    return {
      streamId: this.streamId,
      highWaterBytes: TERMINAL_OUTPUT_HIGH_WATER_BYTES,
      lowWaterBytes: TERMINAL_OUTPUT_LOW_WATER_BYTES,
      maxPendingBytes: TERMINAL_OUTPUT_PENDING_MAX_BYTES,
      maxFrameBytes: TERMINAL_OUTPUT_FRAME_MAX_BYTES,
    };
  }
  pendingBytes(): number {
    return this.sentBytes - this.consumedBytes;
  }
  high(): boolean {
    return (
      this.pendingBytes() >= TERMINAL_OUTPUT_HIGH_WATER_BYTES ||
      this.checkpoints.length >= OUTPUT_FLOW_HIGH_WATER_FRAMES
    );
  }
  low(): boolean {
    return (
      this.pendingBytes() <= TERMINAL_OUTPUT_LOW_WATER_BYTES &&
      this.checkpoints.length < OUTPUT_FLOW_HIGH_WATER_FRAMES
    );
  }
  canSend(bytes: number): boolean {
    return (
      !this.disposed &&
      Number.isSafeInteger(bytes) &&
      bytes > 0 &&
      bytes <= TERMINAL_OUTPUT_FRAME_MAX_BYTES &&
      Number.isSafeInteger(this.sentBytes + bytes) &&
      this.pendingBytes() + bytes <= TERMINAL_OUTPUT_PENDING_MAX_BYTES &&
      this.checkpoints.length < OUTPUT_FLOW_MAX_PENDING_FRAMES
    );
  }
  sent(bytes: number, completedSequence?: number): void {
    if (!this.canSend(bytes)) throw new RangeError('Terminal output window exhausted');
    this.sentBytes += bytes;
    if (completedSequence !== undefined) this.lastSentSequence = completedSequence;
    this.checkpoints.push({
      endBytes: this.sentBytes,
      sequence: completedSequence ?? this.lastConsumedSequence,
    });
  }
  acknowledge(streamId: string, bytes: number): boolean {
    if (
      this.disposed ||
      streamId !== this.streamId ||
      !Number.isSafeInteger(bytes) ||
      bytes < this.consumedBytes ||
      bytes > this.sentBytes
    )
      return false;
    this.consumedBytes = bytes;
    while (this.checkpoints[0] && this.checkpoints[0].endBytes <= bytes) {
      this.lastConsumedSequence = Math.max(
        this.lastConsumedSequence,
        this.checkpoints.shift()!.sequence,
      );
    }
    return true;
  }
  dispose(): void {
    this.disposed = true;
    this.checkpoints.length = 0;
    this.sentBytes = 0;
    this.consumedBytes = 0;
  }
}
