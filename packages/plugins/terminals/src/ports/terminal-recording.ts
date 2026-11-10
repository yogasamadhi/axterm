import type { TerminalBehavior } from '@axterm/plugin-api/terminals';
export interface TerminalRecordingWriterOptions {
  signal?: AbortSignal;
  path: string;
  encoding: TerminalBehavior['encoding'];
  timestamps: boolean;
  onDrain(): void;
  onError(): void;
  now?: (() => Date) | undefined;
}
export interface TerminalRecorder {
  readonly bytesWritten: number;
  write(data: Uint8Array): boolean;
  close(): Promise<void>;
}
export interface TerminalRecorderFactory {
  open(options: TerminalRecordingWriterOptions): Promise<TerminalRecorder>;
}
