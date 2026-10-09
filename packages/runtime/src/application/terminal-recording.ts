/* eslint-disable @typescript-eslint/triple-slash-reference -- @xterm/headless 6.0.0 declares only its broken package module entry. */
/// <reference path="../types/xterm-headless-entry.d.ts" />

import type { WriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Terminal } from '@xterm/headless/lib-headless/xterm-headless.js';
import iconv from 'iconv-lite';
import type { TerminalBehavior } from '@workspace/contracts';

const PARSER_COLUMNS = 4_096;
const PARSER_ROWS = 50;
const PARSE_CHUNK_BYTES = 16 * 1_024;
const PARSER_HIGH_WATER_BYTES = 256 * 1_024;
const PARSER_LOW_WATER_BYTES = 64 * 1_024;
const PARSER_MAX_PENDING_BYTES = 1_024 * 1_024;

interface PendingText {
  text: string;
  sourceBytes: number;
}

export interface TerminalRecordingWriterOptions {
  path: string;
  encoding: TerminalBehavior['encoding'];
  timestamps: boolean;
  onDrain(): void;
  onError(): void;
  now?: (() => Date) | undefined;
}

/**
 * Streams terminal output through the same VT parser family as the Renderer.
 * Only completed visual lines reach disk; parser and file-stream pressure pause
 * the owned terminal channel through the callbacks supplied by TerminalService.
 */
export class TerminalRecordingWriter {
  private readonly decoder: { write(buffer: Buffer): string; end(): string | undefined };
  private readonly terminal = new Terminal({
    cols: PARSER_COLUMNS,
    rows: PARSER_ROWS,
    allowProposedApi: true,
    convertEol: false,
    scrollback: 0,
  });
  private readonly pending: PendingText[] = [];
  private readonly lineFeedSubscription: { dispose(): void };
  private pendingBytes = 0;
  private processing = false;
  private fileBackpressured = false;
  private accepting = true;
  private disposed = false;
  private failure: Error | undefined;
  private closeCompletion: Promise<void> | undefined;
  private resolveClose: (() => void) | undefined;
  private rejectClose: ((error: Error) => void) | undefined;
  bytesWritten = 0;

  private constructor(
    private readonly stream: WriteStream,
    encoding: TerminalBehavior['encoding'],
    private readonly timestamps: boolean,
    private readonly onDrain: () => void,
    private readonly onError: () => void,
    private readonly now: () => Date,
  ) {
    this.decoder = iconv.getDecoder(iconv.encodingExists(encoding) ? encoding : 'utf-8');
    this.lineFeedSubscription = this.terminal.onLineFeed(() => this.writeCompletedLine());
    stream.on('drain', () => {
      this.fileBackpressured = false;
      this.notifyDrainIfReady();
      this.pump();
    });
    stream.on('error', (error) => this.fail(error));
  }

  static async open(options: TerminalRecordingWriterOptions): Promise<TerminalRecordingWriter> {
    const handle = await open(options.path, 'a');
    const stream = handle.createWriteStream({ encoding: 'utf8', highWaterMark: 64 * 1_024 });
    return new TerminalRecordingWriter(
      stream,
      options.encoding,
      options.timestamps,
      options.onDrain,
      options.onError,
      options.now ?? (() => new Date()),
    );
  }

  write(data: Uint8Array): boolean {
    if (!this.accepting || this.failure) return true;
    const bytes = Buffer.from(data);
    if (this.pendingBytes + bytes.byteLength > PARSER_MAX_PENDING_BYTES) {
      this.fail(new Error('Terminal log parser queue exceeded its bounded capacity'));
      return true;
    }
    for (let offset = 0; offset < bytes.byteLength; offset += PARSE_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + PARSE_CHUNK_BYTES);
      this.pending.push({ text: this.decoder.write(chunk), sourceBytes: chunk.byteLength });
      this.pendingBytes += chunk.byteLength;
    }
    this.pump();
    return !this.fileBackpressured && this.pendingBytes < PARSER_HIGH_WATER_BYTES;
  }

  async close(): Promise<void> {
    if (this.closeCompletion) return this.closeCompletion;
    if (this.failure) throw this.failure;
    this.accepting = false;
    const tail = this.decoder.end() ?? '';
    if (tail) this.pending.push({ text: tail, sourceBytes: 0 });
    this.closeCompletion = new Promise<void>((resolve, reject) => {
      this.resolveClose = resolve;
      this.rejectClose = reject;
    });
    this.pump();
    this.finishIfReady();
    return this.closeCompletion;
  }

  private pump(): void {
    if (this.processing || this.fileBackpressured || this.failure || this.disposed) return;
    const next = this.pending.shift();
    if (!next) {
      this.finishIfReady();
      return;
    }
    this.processing = true;
    this.terminal.write(normalizeBareCarriageReturns(next.text), () => {
      this.processing = false;
      this.pendingBytes = Math.max(0, this.pendingBytes - next.sourceBytes);
      this.notifyDrainIfReady();
      this.pump();
    });
  }

  private writeCompletedLine(): void {
    if (this.failure || this.disposed) return;
    const buffer = this.terminal.buffer.active;
    const row = buffer.baseY + buffer.cursorY - 1;
    if (row < 0) return;
    const text = buffer.getLine(row)?.translateToString(true);
    if (text === undefined) return;
    const prefix = this.timestamps ? `[${formatLogTimestamp(this.now())}] ` : '';
    const output = `${prefix}${text}\n`;
    if (!this.stream.write(output, 'utf8')) this.fileBackpressured = true;
    this.bytesWritten += Buffer.byteLength(output, 'utf8');
  }

  private notifyDrainIfReady(): void {
    if (!this.fileBackpressured && this.pendingBytes <= PARSER_LOW_WATER_BYTES) this.onDrain();
  }

  private finishIfReady(): void {
    if (
      this.accepting ||
      this.processing ||
      this.fileBackpressured ||
      this.pending.length ||
      this.disposed ||
      !this.closeCompletion
    )
      return;
    this.disposeParser();
    this.stream.end(() => {
      if (this.failure) return;
      this.resolveClose?.();
      this.resolveClose = undefined;
      this.rejectClose = undefined;
    });
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.accepting = false;
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.disposeParser();
    if (!this.stream.destroyed) this.stream.destroy();
    this.rejectClose?.(error);
    this.resolveClose = undefined;
    this.rejectClose = undefined;
    this.onError();
  }

  private disposeParser(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lineFeedSubscription.dispose();
    this.terminal.dispose();
  }
}

export function normalizeBareCarriageReturns(text: string): string {
  return text.replace(/\r(?!\n)/g, '\r\n');
}

export function formatLogTimestamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
