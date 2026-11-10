import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  TrzszTransfer,
  type ProgressCallback,
  type TrzszFileReader,
  type TrzszFileWriter,
} from 'trzsz2';
import safeTransferName from './safe-transfer-name.cjs';
import {
  destinationDoesNotSupportAtomicPublication,
  publishStagedFile,
} from './staged-file-publication';
import type { StageOwnershipWriter } from './owned-stage-journal';

// This is Axterm's terminal/Grant adapter around the independently published
// trzsz2 protocol library. It keeps terminal state, filesystem, and UI logic
// outside the protocol adapter.
const safeName = safeTransferName as (value: unknown, reservedBytes?: number) => string;
const MAGIC = [Buffer.from('::TRZSZ:TRANSFER:'), Buffer.from('::TRZSZGO:TRANSFER:')];
const MAX_MAGIC_LINE = 192;
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_FILES = 100;
const MAX_TRZSZ_BUFFERED_BYTES = 64 * 1024 * 1024;
const SELECTION_TIMEOUT_MS = 60_000;
const PEER_TIMEOUT_MS = 60_000;

interface Terminal {
  write(data: Uint8Array): void;
}

interface Socket {
  s(message: Record<string, unknown>): void;
}

export type TrzszReceiveWrite = (
  handle: FileHandle,
  buffer: Uint8Array,
  offset: number,
  length: number,
) => Promise<number>;

export type StagedTrzszWriterFactory = (finalPath: string, fileName: string) => StagedTrzszWriter;

const writeTrzszReceiveBytes: TrzszReceiveWrite = async (handle, buffer, offset, length) => {
  const { bytesWritten } = await handle.write(buffer, offset, length);
  return bytesWritten;
};

interface UploadSelection {
  kind: 'upload';
  paths: string[];
}

interface DownloadSelection {
  kind: 'download';
  directory: string;
}

type Selection = UploadSelection | DownloadSelection;
type Direction = 'upload' | 'download';

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

class UploadReader implements TrzszFileReader {
  private handle: FileHandle | undefined;
  private position = 0;
  private constructor(
    private readonly name: string,
    private readonly size: number,
    handle: FileHandle,
  ) {
    this.handle = handle;
  }

  static async open(path: string): Promise<UploadReader> {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error('Transfer source must not be a symbolic link');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES)
        throw new Error('Transfer source is not a bounded regular file');
      return new UploadReader(safeName(basename(path)), metadata.size, handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  getPathId(): number {
    return 0;
  }

  getRelPath(): string[] {
    return [this.name];
  }

  isDir(): boolean {
    return false;
  }

  getSize(): number {
    return this.size;
  }

  async readFile(buffer: ArrayBuffer): Promise<Uint8Array> {
    if (!this.handle) throw new Error('Transfer source is closed');
    const bytes = Buffer.from(buffer);
    const length = Math.min(bytes.length, this.size - this.position);
    const { bytesRead } = await this.handle.read(bytes, 0, length, this.position);
    if (length > 0 && bytesRead === 0)
      throw new Error('Transfer source changed before all bytes were read');
    this.position += bytesRead;
    return bytes.subarray(0, bytesRead);
  }

  closeFile(): void {
    void this.dispose();
  }

  async dispose(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close();
  }
}

export class StagedTrzszWriter implements TrzszFileWriter {
  private handle: FileHandle | undefined;
  private closing: Promise<void> | undefined;
  private bytes = 0;
  private readonly temporaryPath: string;
  private recordId: string | undefined;

  constructor(
    private readonly finalPath: string,
    private readonly fileName: string,
    private readonly receiveWrite: TrzszReceiveWrite = writeTrzszReceiveBytes,
    private readonly removeStage: typeof unlink = unlink,
    private readonly journal?: StageOwnershipWriter,
  ) {
    this.temporaryPath = join(dirname(finalPath), `.axterm-trzsz-${randomUUID()}.part`);
  }

  getFileName(): string {
    return this.fileName;
  }

  getLocalName(): string {
    return basename(this.finalPath);
  }

  getWrittenSize(): number {
    return this.bytes;
  }

  isDir(): boolean {
    return false;
  }

  async writeFile(data: Uint8Array): Promise<void> {
    if (this.closing) throw new Error('Transfer destination is closed');
    if (this.bytes + data.byteLength > MAX_FILE_BYTES)
      throw new Error('Transfer destination exceeds the file-size limit');
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

  closeFile(): void {
    this.closing ??= this.closeStream();
  }

  async commit(): Promise<void> {
    this.closeFile();
    await this.closing;
    await publishStagedFile(this.temporaryPath, this.finalPath);
    await this.removeStage(this.temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw stagedCleanupError('remove', error);
    });
    this.clearRecordIfAbsent();
  }

  async deleteFile(): Promise<string> {
    this.closeFile();
    let closeFailure: Error | undefined;
    try {
      await this.closing;
    } catch (error) {
      // A stage that was never created (or was removed by another actor) has
      // nothing left to clean. Other close failures must reach Runtime shutdown.
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
    return this.finalPath;
  }

  private async closeStream(): Promise<void> {
    await this.ensureOpen();
    const handle = this.handle;
    this.handle = undefined;
    await handle!.close();
  }

  private async ensureOpen(): Promise<void> {
    if (this.handle) return;
    if (this.journal) {
      this.recordId = this.journal.prepare(
        dirname(this.temporaryPath),
        basename(this.temporaryPath),
        basename(this.finalPath),
        'trzsz',
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

function findMagic(data: Buffer): { direction: Direction; end: number } | undefined {
  for (const marker of MAGIC) {
    const start = data.indexOf(marker);
    if (start < 0) continue;
    const directionByte = data[start + marker.length];
    if (directionByte !== 0x52 && directionByte !== 0x53) continue;
    const newline = data.indexOf(0x0a, start + marker.length);
    if (newline < 0 || newline - start > MAX_MAGIC_LINE) continue;
    return { direction: directionByte === 0x52 ? 'upload' : 'download', end: newline + 1 };
  }
  return undefined;
}

export class TrzszSession {
  private direction: Direction | undefined;
  private transfer: TrzszTransfer | undefined;
  private selection: Selection | undefined;
  private selectionResolve: ((selection: Selection | undefined) => void) | undefined;
  private tail = Buffer.alloc(0);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cancelled = false;
  private destroyed = false;
  private running: Promise<void> | undefined;
  private cancellation: Promise<void> | undefined;
  private destruction: Promise<void> | undefined;
  private readonly readers: UploadReader[] = [];
  private readonly writers: StagedTrzszWriter[] = [];
  private readonly usedNames = new Set<string>();

  constructor(
    private readonly terminal: Terminal,
    private readonly socket: Socket,
    private readonly createWriter: StagedTrzszWriterFactory = (finalPath, fileName) =>
      new StagedTrzszWriter(finalPath, fileName),
  ) {}

  isActive(): boolean {
    return this.direction !== undefined;
  }

  handleData(data: Uint8Array): boolean {
    // RuntimeTerminalTransferAdapter deletes destroyed sessions, but this
    // guard also makes a direct shutdown race harmless: a closing protocol
    // must not consume a later terminal's ordinary output.
    if (this.destroyed) return false;
    if (this.transfer && this.cancelled) return true;
    if (this.transfer && data.byteLength > MAX_TRZSZ_BUFFERED_BYTES) {
      this.failOverloadedPeer();
      return true;
    }
    const chunk = Buffer.from(data);
    if (this.transfer) {
      this.acceptPeerData(chunk);
      return true;
    }
    const combined = Buffer.concat([this.tail, chunk]);
    const match = findMagic(combined);
    this.tail = combined.subarray(Math.max(0, combined.length - MAX_MAGIC_LINE));
    if (!match) return false;
    this.prepareSession();
    this.direction = match.direction;
    this.transfer = new TrzszTransfer((output) =>
      this.terminal.write(typeof output === 'string' ? Buffer.from(output) : output),
    );
    this.emit(match.direction === 'upload' ? 'send-start' : 'receive-start');
    this.armTimer(SELECTION_TIMEOUT_MS);
    this.running = this.run();
    void this.running.catch(() => undefined);
    if (match.end < combined.length) this.acceptPeerData(combined.subarray(match.end));
    return true;
  }

  private acceptPeerData(chunk: Buffer): void {
    try {
      this.transfer!.addReceivedData(chunk);
      this.armTimer(PEER_TIMEOUT_MS);
    } catch {
      this.failOverloadedPeer();
    }
  }

  private failOverloadedPeer(): void {
    this.emit('session-error');
    void this.cancel().catch(() => undefined);
  }

  handleMessage(message: Record<string, unknown>): void {
    if (message.event === 'cancel') {
      void this.cancel();
      return;
    }
    if (this.direction === 'download' && message.event === 'set-save-path') {
      if (typeof message.path === 'string' && message.path.length > 0)
        this.choose({ kind: 'download', directory: message.path });
    } else if (this.direction === 'upload' && message.event === 'send-files') {
      const files = message.files;
      if (Array.isArray(files) && files.length > 0 && files.length <= MAX_FILES) {
        const paths = files.map((file) =>
          file && typeof file === 'object' && 'path' in file ? file.path : undefined,
        );
        if (paths.every((path): path is string => typeof path === 'string' && path.length > 0))
          this.choose({ kind: 'upload', paths });
      }
    }
  }

  cancel(): Promise<void> {
    if (this.cancellation) return this.cancellation;
    if (!this.transfer) return Promise.resolve();
    this.cancelled = true;
    this.selectionResolve?.(undefined);
    this.selectionResolve = undefined;
    const transfer = this.transfer;
    this.cancellation = (async () => {
      await transfer.stopTransferring();
      if (!this.destroyed) this.terminal.write(Buffer.from([0x03]));
    })();
    void this.cancellation.catch(() => undefined);
    return this.cancellation;
  }

  destroy(): Promise<void> {
    this.destroyed = true;
    this.disarmTimer();
    this.destruction ??= (async () => {
      try {
        await this.cancel();
      } finally {
        await this.running;
      }
    })();
    void this.destruction.catch(() => undefined);
    return this.destruction;
  }

  private choose(selection: Selection): void {
    if (this.selection) return;
    this.selection = selection;
    this.selectionResolve?.(selection);
    this.selectionResolve = undefined;
  }

  private waitSelection(): Promise<Selection | undefined> {
    if (this.selection) return Promise.resolve(this.selection);
    if (this.cancelled) return Promise.resolve(undefined);
    return new Promise((resolveSelection) => {
      this.selectionResolve = resolveSelection;
    });
  }

  private async run(): Promise<void> {
    const transfer = this.transfer!;
    let reportedFailure = false;
    let cleanupFailure: PromiseRejectedResult | undefined;
    try {
      await transfer.sendAction(true, false);
      await transfer.recvConfig();
      const selection = await this.waitSelection();
      if (selection && !this.cancelled) {
        this.armTimer(PEER_TIMEOUT_MS);
        if (selection.kind === 'upload') await this.upload(selection.paths);
        else await this.download(selection.directory);
        if (!this.cancelled) {
          await transfer.clientExit('Success');
          this.emit('session-complete');
        }
      }
    } catch (error) {
      if (!this.cancelled) {
        reportedFailure = true;
        // A locally detected protocol or filesystem failure must also reach a
        // live peer. Stop accepting additional protocol bytes and use the
        // same terminal cancellation byte as an explicit user cancellation,
        // so a peer cannot wait for input after Axterm removes its staging.
        await transfer.stopTransferring().catch(() => undefined);
        try {
          this.terminal.write(Buffer.from([0x03]));
        } catch {
          // A closed PTY must not prevent local cleanup and state release.
        }
        this.emit(
          'session-error',
          destinationDoesNotSupportAtomicPublication(error)
            ? { errorCode: 'TRANSFER_DESTINATION_UNSUPPORTED' }
            : {},
        );
      }
    } finally {
      this.disarmTimer();
      const cleanupResults = await Promise.allSettled([
        ...this.readers.map((reader) => reader.dispose()),
        ...this.writers.map((writer) => writer.deleteFile()),
      ]);
      cleanupFailure = cleanupResults.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      transfer.cleanup();
      this.transfer = undefined;
      this.direction = undefined;
      this.selection = undefined;
      this.selectionResolve = undefined;
      this.tail = Buffer.alloc(0);
      // Managers retain a completed session until the terminal itself closes.
      // Do not carry handles or an already-published staged writer into the
      // next marker on that terminal: committing such a writer again would
      // target a temp path which was deliberately unlinked on first success.
      this.readers.length = 0;
      this.writers.length = 0;
      this.usedNames.clear();
      if (cleanupFailure && !reportedFailure) this.emit('session-error', {});
      this.emit('session-end');
    }
    if (cleanupFailure) throw cleanupFailure.reason;
  }

  private prepareSession(): void {
    this.cancelled = false;
    this.cancellation = undefined;
    this.selection = undefined;
    this.selectionResolve = undefined;
    this.tail = Buffer.alloc(0);
    this.readers.length = 0;
    this.writers.length = 0;
    this.usedNames.clear();
  }

  private async upload(paths: string[]): Promise<void> {
    for (const path of paths) this.readers.push(await UploadReader.open(path));
    const callback = this.progress('upload');
    await this.transfer!.sendFiles(this.readers, callback);
  }

  private async download(directory: string): Promise<void> {
    const root = await realpath(directory);
    if (!(await stat(root)).isDirectory()) throw new Error('Save target is not a directory');
    const callback = this.progress('download');
    await this.transfer!.recvFiles(
      root,
      async (_save, receivedName, directoryMode) => {
        if (directoryMode)
          throw new Error('Directory transfer requires a separate safe destination');
        const name = safeName(receivedName);
        let candidate = name;
        for (let count = 1; count <= 1_000; count += 1) {
          if (!this.usedNames.has(candidate) && !(await exists(join(root, candidate)))) break;
          candidate = suffixName(name, count);
        }
        if (this.usedNames.has(candidate) || (await exists(join(root, candidate))))
          throw new Error('Transfer filename collision limit exceeded');
        this.usedNames.add(candidate);
        const writer = this.createWriter(join(root, candidate), name);
        this.writers.push(writer);
        return writer;
      },
      callback,
    );
    for (const writer of this.writers) {
      await writer.commit();
      this.emit('file-complete', {
        name: writer.getFileName(),
        size: writer.getWrittenSize(),
      });
    }
  }

  private progress(direction: Direction): ProgressCallback {
    let name = '';
    let size = 0;
    let lastUpdate = 0;
    return {
      onNum: (count) => {
        if (!Number.isSafeInteger(count) || count < 0 || count > MAX_FILES)
          throw new Error('Transfer file count exceeds limit');
        this.emit('file-count', { count });
      },
      onName: (value) => {
        name = safeName(value);
        size = 0;
        this.emit('file-start', { name });
      },
      onSize: (value) => {
        if (!Number.isSafeInteger(value) || value < 0 || value > MAX_FILE_BYTES)
          throw new Error('Transfer file size exceeds limit');
        size = value;
        this.emit('file-size', { name, size });
      },
      onStep: (transferred) => {
        if (!Number.isSafeInteger(transferred) || transferred < 0 || transferred > size)
          throw new Error('Transfer progress exceeds announced file size');
        this.armTimer(PEER_TIMEOUT_MS);
        if (Date.now() - lastUpdate >= 250 || transferred === size) {
          lastUpdate = Date.now();
          this.emit('progress', { name, size, transferred });
        }
      },
      onDone: () => {
        if (direction === 'upload') this.emit('file-complete', { name, size });
      },
    };
  }

  private emit(event: string, details: Record<string, unknown> = {}): void {
    if (!this.destroyed) this.socket.s({ action: 'trzsz-event', event, ...details });
  }

  private armTimer(duration: number): void {
    this.disarmTimer();
    this.timer = setTimeout(() => {
      this.emit('session-timeout');
      void this.cancel();
    }, duration);
    this.timer.unref();
  }

  private disarmTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export class TrzszManager {
  private readonly sessions = new Map<string, TrzszSession>();

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

  destroySession(id: string): Promise<void> | undefined {
    const cleanup = this.sessions.get(id)?.destroy();
    this.sessions.delete(id);
    return cleanup;
  }

  isActive(id: string): boolean {
    return this.sessions.get(id)?.isActive() ?? false;
  }

  private session(id: string, terminal: Terminal, socket: Socket): TrzszSession {
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const created = new TrzszSession(
      terminal,
      socket,
      (finalPath, name) =>
        new StagedTrzszWriter(finalPath, name, undefined, undefined, this.journal),
    );
    this.sessions.set(id, created);
    return created;
  }
}
