import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  decodeHeader,
  Encoding,
  Frame,
  Receiver,
  ReceiverEvent,
  Sender,
  SenderEvent,
} from 'zmodem2';
import safeTransferName from './safe-transfer-name.cjs';
import {
  destinationDoesNotSupportAtomicPublication,
  publishStagedFile,
} from './staged-file-publication';
import type { StageOwnershipWriter } from './owned-stage-journal';

const safeName = safeTransferName as (value: unknown, reservedBytes?: number) => string;
const HEADER_PREFIX = Buffer.from([0x2a, 0x2a, 0x18, 0x42]);
const HEADER_BYTES = 18;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_CHUNKS = 4_096;
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_FILES = 100;
const TIMEOUT_MS = 60_000;
const CANCEL = Buffer.from([0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x42]);

interface Terminal {
  write(data: Uint8Array): void;
}

interface Socket {
  s(message: Record<string, unknown>): void;
  send(data: Uint8Array): void;
}

export type ZmodemReceiveWrite = (
  handle: FileHandle,
  buffer: Uint8Array,
  offset: number,
  length: number,
) => Promise<number>;

export type ZmodemReceiveFileFactory = (
  finalPath: string,
  name: string,
  size: number,
) => ZmodemReceiveFile;

const writeZmodemReceiveBytes: ZmodemReceiveWrite = async (handle, buffer, offset, length) => {
  const { bytesWritten } = await handle.write(buffer, offset, length);
  return bytesWritten;
};

type Direction = 'upload' | 'download';
type Selection = { kind: 'upload'; paths: string[] } | { kind: 'download'; directory: string };

function detectHeader(data: Buffer): { direction: Direction; offset: number } | undefined {
  for (let offset = 0; offset <= data.length - HEADER_BYTES; offset += 1) {
    if (!data.subarray(offset, offset + HEADER_PREFIX.length).equals(HEADER_PREFIX)) continue;
    try {
      const header = decodeHeader(
        Encoding.ZHEX,
        data.subarray(offset + HEADER_PREFIX.length, offset + HEADER_BYTES),
      );
      if (header.frame === Frame.ZRQINIT) return { direction: 'download', offset };
      if (header.frame === Frame.ZRINIT) return { direction: 'upload', offset };
    } catch {
      // Ordinary terminal bytes may resemble a partial or invalid header.
    }
  }
  return undefined;
}

function suffixName(name: string, count: number): string {
  const extension = extname(name);
  const suffix = `.${count}${Buffer.byteLength(extension, 'utf8') <= 64 ? extension : ''}`;
  const stem = extension && suffix.endsWith(extension) ? name.slice(0, -extension.length) : name;
  return `${safeName(stem, Buffer.byteLength(suffix, 'utf8'))}${suffix}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function stagedCleanupError(action: 'close' | 'remove', error: unknown): Error {
  const safe = new Error(`Unable to ${action} staged transfer file`);
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    Object.assign(safe, { code: error.code });
  }
  return safe;
}

export class ZmodemReceiveFile {
  private handle: FileHandle | undefined;
  private closed = false;
  private readonly temporaryPath: string;
  private recordId: string | undefined;
  bytes = 0;

  constructor(
    readonly finalPath: string,
    readonly name: string,
    readonly size: number,
    private readonly receiveWrite: ZmodemReceiveWrite = writeZmodemReceiveBytes,
    private readonly removeStage: typeof unlink = unlink,
    private readonly journal?: StageOwnershipWriter,
  ) {
    this.temporaryPath = join(dirname(finalPath), `.axterm-zmodem-${randomUUID()}.part`);
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('Transfer destination is closed');
    if (this.bytes + data.length > this.size || this.bytes + data.length > MAX_FILE_BYTES)
      throw new Error('Transfer destination exceeds the declared size');
    await this.ensureOpen();
    const chunk = Buffer.from(data);
    let offset = 0;
    while (offset < chunk.length) {
      const bytesWritten = await this.receiveWrite(
        this.handle!,
        chunk,
        offset,
        chunk.length - offset,
      );
      if (bytesWritten === 0) throw new Error('Transfer destination accepted no bytes');
      offset += bytesWritten;
      if (this.journal && this.recordId) this.journal.seal(this.recordId, this.handle!.fd);
    }
    this.bytes += chunk.length;
  }

  async commit(): Promise<void> {
    if (this.bytes !== this.size) throw new Error('Transfer size differs from the offer');
    await this.close();
    await publishStagedFile(this.temporaryPath, this.finalPath);
    await this.removeStage(this.temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw stagedCleanupError('remove', error);
    });
    this.clearRecordIfAbsent();
  }

  async cleanup(): Promise<void> {
    let closeFailure: Error | undefined;
    try {
      await this.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        closeFailure = stagedCleanupError('close', error);
    }
    let cleanupFailure: Error | undefined;
    try {
      await this.removeStage(this.temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        cleanupFailure = stagedCleanupError('remove', error);
    }
    if (closeFailure) throw closeFailure;
    if (cleanupFailure) throw cleanupFailure;
    this.clearRecordIfAbsent();
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    await this.ensureOpen();
    await this.handle!.close();
    this.handle = undefined;
    this.closed = true;
  }

  private async ensureOpen(): Promise<void> {
    if (this.handle) return;
    if (this.journal) {
      this.recordId = this.journal.prepare(
        dirname(this.temporaryPath),
        basename(this.temporaryPath),
        basename(this.finalPath),
        'zmodem',
      );
    }
    try {
      const handle = await open(
        this.temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      this.handle = handle;
      if (this.journal && this.recordId) this.journal.seal(this.recordId, handle.fd);
    } catch (error) {
      this.clearRecordIfAbsent();
      throw error;
    }
  }

  private clearRecordIfAbsent(): void {
    if (this.journal && this.recordId)
      this.journal.clearIfAbsent(this.recordId, dirname(this.temporaryPath));
  }
}

export class ZmodemSession {
  private direction: Direction | undefined;
  private tail = Buffer.alloc(0);
  private pending: Buffer[] = [];
  private bufferedBytes = 0;
  private sender: Sender | undefined;
  private receiver: Receiver | undefined;
  private source: FileHandle | undefined;
  private sourceSize = 0;
  private destinationRoot: string | undefined;
  private destination: ZmodemReceiveFile | undefined;
  private readonly usedNames = new Set<string>();
  private fileCount = 0;
  private transferred = 0;
  private processing = false;
  private starting = false;
  private ended = false;
  private destroyed = false;
  private reusable = false;
  private finishing: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly terminal: Terminal,
    private readonly socket: Socket,
    private readonly createReceiveFile: ZmodemReceiveFileFactory = (finalPath, name, size) =>
      new ZmodemReceiveFile(finalPath, name, size),
  ) {}

  isActive(): boolean {
    return this.direction !== undefined && !this.ended;
  }

  handleData(data: Uint8Array): boolean {
    if (this.isActive()) {
      this.enqueue(data);
      if (!this.ended) {
        this.armTimer();
        void this.pump();
      }
      return true;
    }
    const chunk = Buffer.from(data);
    const combined = Buffer.concat([this.tail, chunk]);
    const match = detectHeader(combined);
    if (!match) {
      // Copy only the possible cross-frame prefix. A subarray would retain an
      // arbitrarily large ordinary-terminal chunk until more output arrives.
      this.tail = Buffer.from(combined.subarray(Math.max(0, combined.length - HEADER_BYTES + 1)));
      return false;
    }
    if (this.ended) {
      if (!this.reusable || this.destroyed) return false;
      this.ended = false;
      this.reusable = false;
      this.finishing = undefined;
      this.fileCount = 0;
      this.transferred = 0;
      this.sourceSize = 0;
      this.destinationRoot = undefined;
      this.usedNames.clear();
    }
    const visiblePrefixLength = Math.max(0, match.offset - this.tail.length);
    if (visiblePrefixLength > 0) this.socket.send(chunk.subarray(0, visiblePrefixLength));
    this.tail = Buffer.alloc(0);
    this.direction = match.direction;
    this.enqueue(combined.subarray(match.offset));
    if (this.ended) return true;
    this.emit(match.direction === 'download' ? 'receive-start' : 'send-start');
    this.armTimer();
    return true;
  }

  handleMessage(message: Record<string, unknown>): void {
    if (message.event === 'cancel') {
      void this.finish(undefined, true);
      return;
    }
    if (!this.isActive() || this.starting || this.sender || this.receiver) return;
    if (this.direction === 'download' && message.event === 'set-save-path') {
      if (typeof message.path === 'string' && message.path.length > 0)
        void this.begin({ kind: 'download', directory: message.path });
    } else if (this.direction === 'upload' && message.event === 'send-files') {
      const files = message.files;
      if (Array.isArray(files) && files.length === 1) {
        const path = files[0]?.path;
        if (typeof path === 'string' && path.length > 0)
          void this.begin({ kind: 'upload', paths: [path] });
      }
    }
  }

  handleUserInput(data: Uint8Array): void {
    if (this.isActive() && data.includes(0x03)) void this.finish('transfer-error', false);
  }

  destroy(): Promise<void> {
    this.destroyed = true;
    return this.finish(undefined, false).catch(async (error: unknown) => {
      // A live cancellation can fail to close its source or remove its own
      // staged destination before Runtime closes the terminal. Retry both.
      let retryFailure: unknown;
      if (this.source) {
        try {
          await this.source.close();
          this.source = undefined;
        } catch (failure) {
          retryFailure = stagedCleanupError('close', failure);
        }
      }
      if (this.destination) {
        try {
          await this.destination.cleanup();
          this.destination = undefined;
        } catch (failure) {
          retryFailure ??= failure;
        }
      }
      if (retryFailure) throw retryFailure;
      if (this.source || this.destination) throw error;
    });
  }

  private enqueue(data: Uint8Array): void {
    if (this.ended || data.length === 0) return;
    if (
      this.bufferedBytes + data.length > MAX_BUFFERED_BYTES ||
      this.pending.length >= MAX_BUFFERED_CHUNKS
    ) {
      void this.finish('transfer-error', true);
      return;
    }
    this.pending.push(Buffer.from(data));
    this.bufferedBytes += data.length;
  }

  private async begin(selection: Selection): Promise<void> {
    this.starting = true;
    try {
      if (selection.kind === 'download') {
        const root = await realpath(selection.directory);
        if (!(await stat(root)).isDirectory())
          throw new Error('Transfer target is not a directory');
        if (this.ended) return;
        this.destinationRoot = root;
        this.receiver = new Receiver();
      } else {
        if ((await lstat(selection.paths[0]!)).isSymbolicLink())
          throw new Error('Transfer source must not be a symbolic link');
        const handle = await open(
          selection.paths[0]!,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) {
          await handle.close();
          throw new Error('Transfer source is not a bounded regular file');
        }
        if (this.ended) {
          await handle.close();
          return;
        }
        this.source = handle;
        this.sourceSize = metadata.size;
        this.sender = new Sender(false);
        this.sender.startFile(
          safeName(basename(selection.paths[0]!)),
          metadata.size,
          metadata.mtimeMs,
        );
        this.emit('file-count', { count: 1 });
        this.emit('file-start', { name: safeName(basename(selection.paths[0]!)) });
        this.emit('file-size', {
          name: safeName(basename(selection.paths[0]!)),
          size: metadata.size,
        });
      }
      this.armTimer();
      void this.pump();
    } catch (error) {
      await this.finish(
        'transfer-error',
        true,
        destinationDoesNotSupportAtomicPublication(error)
          ? 'TRANSFER_DESTINATION_UNSUPPORTED'
          : undefined,
      );
    } finally {
      this.starting = false;
    }
  }

  private async pump(): Promise<void> {
    if (this.processing || this.ended || (!this.sender && !this.receiver)) return;
    this.processing = true;
    try {
      while (!this.ended) {
        let progressed = false;
        const engine = this.sender ?? this.receiver!;
        const outgoing = engine.drainOutgoing();
        if (outgoing.length > 0) {
          this.terminal.write(outgoing);
          progressed = true;
        }
        if (this.sender) {
          let event: SenderEvent | null;
          while ((event = this.sender.pollEvent())) {
            await this.senderEvent(event);
            progressed = true;
          }
          const request = this.sender.pollFile();
          if (request) {
            const chunk = Buffer.allocUnsafe(request.len);
            const { bytesRead } = await this.source!.read(chunk, 0, request.len, request.offset);
            if (bytesRead === 0) throw new Error('Transfer source ended before its declared size');
            this.sender.feedFile(chunk.subarray(0, bytesRead));
            this.transferred = Math.max(this.transferred, request.offset + bytesRead);
            this.emit('progress', { size: this.sourceSize, transferred: this.transferred });
            progressed = true;
          }
        } else {
          let event: ReceiverEvent | null;
          while ((event = this.receiver!.pollEvent())) {
            await this.receiverEvent(event);
            progressed = true;
          }
          const fileBytes = this.receiver!.drainFile();
          if (fileBytes.length > 0) {
            if (!this.destination) throw new Error('Received bytes before a file offer');
            await this.destination.write(fileBytes);
            this.emit('progress', {
              name: this.destination.name,
              size: this.destination.size,
              transferred: this.destination.bytes,
            });
            progressed = true;
          }
        }
        if (this.ended) break;
        const first = this.pending[0];
        if (first) {
          const consumed = engine.feedIncoming(first);
          // The published state machine returns zero for an incomplete header
          // even after its internal reader has retained the supplied bytes.
          // All outgoing, events and file requests were drained above, so a
          // zero here means the chunk belongs to that internal reader.
          const released = consumed === 0 ? first.length : consumed;
          this.bufferedBytes -= released;
          if (released >= first.length) this.pending.shift();
          else this.pending[0] = first.subarray(released);
          progressed = true;
        }
        if (!progressed) break;
      }
    } catch (error) {
      await this.finish(
        'transfer-error',
        true,
        destinationDoesNotSupportAtomicPublication(error)
          ? 'TRANSFER_DESTINATION_UNSUPPORTED'
          : undefined,
      );
    } finally {
      this.processing = false;
    }
  }

  private async senderEvent(event: SenderEvent): Promise<void> {
    if (event === SenderEvent.FileComplete) {
      await this.source?.close();
      this.source = undefined;
      this.emit('file-complete', { size: this.sourceSize });
      this.sender!.finishSession();
    } else if (event === SenderEvent.SessionComplete) {
      this.emit('session-complete');
      await this.finish();
    }
  }

  private async receiverEvent(event: ReceiverEvent): Promise<void> {
    if (event === ReceiverEvent.FileStart) {
      this.fileCount += 1;
      if (this.fileCount > MAX_FILES) throw new Error('Transfer file count exceeds limit');
      const size = this.receiver!.getFileSize();
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES)
        throw new Error('Transfer file size exceeds limit');
      const name = safeName(this.receiver!.getFileName());
      const root = this.destinationRoot!;
      let candidate = name;
      for (let count = 1; count <= 1_000; count += 1) {
        if (!this.usedNames.has(candidate) && !(await exists(join(root, candidate)))) break;
        candidate = suffixName(name, count);
      }
      if (this.usedNames.has(candidate) || (await exists(join(root, candidate))))
        throw new Error('Transfer filename collision limit exceeded');
      this.usedNames.add(candidate);
      this.destination = this.createReceiveFile(join(root, candidate), name, size);
      this.emit('file-count', { count: this.fileCount });
      this.emit('file-start', { name });
      this.emit('file-size', { name, size });
    } else if (event === ReceiverEvent.FileComplete) {
      const destination = this.destination;
      if (!destination) throw new Error('Transfer completed without a destination');
      await destination.commit();
      this.emit('file-complete', { name: destination.name, size: destination.size });
      this.destination = undefined;
    } else if (event === ReceiverEvent.SessionComplete) {
      if (this.destination) throw new Error('Transfer session closed before its final file');
      this.emit('session-complete');
      await this.finish();
    }
  }

  private finish(
    error?: string,
    sendCancel = false,
    errorCode?: 'TRANSFER_DESTINATION_UNSUPPORTED',
  ): Promise<void> {
    if (this.finishing) return this.finishing;
    if (this.ended) return Promise.resolve();
    this.ended = true;
    this.disarmTimer();
    if (error) this.emit(error, errorCode ? { errorCode } : {});
    if (sendCancel) {
      try {
        this.terminal.write(CANCEL);
      } catch {
        // A closed PTY must not prevent local resource cleanup.
      }
    }
    this.finishing = (async () => {
      let cleanupFailure: unknown;
      try {
        await this.source?.close();
        this.source = undefined;
      } catch (failure) {
        cleanupFailure = stagedCleanupError('close', failure);
      }
      try {
        await this.destination?.cleanup();
        this.destination = undefined;
      } catch (failure) {
        cleanupFailure ??= failure;
      }
      this.pending = [];
      this.bufferedBytes = 0;
      this.sender = undefined;
      this.receiver = undefined;
      this.direction = undefined;
      if (cleanupFailure && !error) this.emit('transfer-error');
      this.emit('session-end');
      this.reusable = !this.destroyed && !cleanupFailure;
      if (cleanupFailure) throw cleanupFailure;
    })();
    // Timer, cancel and input handlers also initiate finish without a caller
    // awaiting it; retain the rejection for destroy/closeAll without an
    // unhandled-rejection race before shutdown reaches the session.
    void this.finishing.catch(() => undefined);
    return this.finishing;
  }

  private emit(event: string, details: Record<string, unknown> = {}): void {
    if (!this.destroyed) this.socket.s({ action: 'zmodem-event', event, ...details });
  }

  private armTimer(): void {
    this.disarmTimer();
    this.timer = setTimeout(() => void this.finish('session-timeout', true), TIMEOUT_MS);
    this.timer.unref();
  }

  private disarmTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export class ZmodemManager {
  private readonly sessions = new Map<string, ZmodemSession>();

  constructor(private readonly journal?: StageOwnershipWriter) {}

  handleData(id: string, data: Uint8Array, terminal: Terminal, socket: Socket): boolean {
    return this.session(id, terminal, socket).handleData(data);
  }

  handleMessage(
    id: string,
    message: Record<string, unknown>,
    terminal: Terminal,
    socket: Socket,
  ): void {
    this.session(id, terminal, socket).handleMessage(message);
  }

  handleUserInput(id: string, data: Uint8Array): void {
    this.sessions.get(id)?.handleUserInput(data);
  }

  destroySession(id: string): Promise<void> | undefined {
    const cleanup = this.sessions.get(id)?.destroy();
    this.sessions.delete(id);
    return cleanup;
  }

  isActive(id: string): boolean {
    return this.sessions.get(id)?.isActive() ?? false;
  }

  private session(id: string, terminal: Terminal, socket: Socket): ZmodemSession {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const created = new ZmodemSession(
      terminal,
      socket,
      (finalPath, name, size) =>
        new ZmodemReceiveFile(finalPath, name, size, undefined, undefined, this.journal),
    );
    this.sessions.set(id, created);
    return created;
  }
}
