import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import safeTransferName from './safe-transfer-name.cjs';
import {
  destinationDoesNotSupportAtomicPublication,
  destinationCreatedBeforePublicationFailure,
  publishStagedFile,
} from './staged-file-publication';
import type { StageOwnershipWriter } from './owned-stage-journal';

const safeName = safeTransferName as (value: unknown, reservedBytes?: number) => string;

// XMODEM framing follows Ward Christensen's published protocol and the
// XMODEM-CRC/XMODEM-1K block extensions. This engine is Axterm-owned code.
const SOH = 0x01;
const STX = 0x02;
const EOT = 0x04;
const ACK = 0x06;
const NAK = 0x15;
const CAN = 0x18;
const CRC_REQUEST = 0x43;
const BLOCK_BYTES = 128;
const LONG_BLOCK_BYTES = 1024;
const MAX_RETRIES = 10;
const PEER_TIMEOUT_MS = 10_000;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_TRANSFER_BYTES = 4 * 1024 * 1024 * 1024;

type State = 'idle' | 'receive' | 'publishing' | 'wait-send' | 'send-packet' | 'send-eot';

interface Terminal {
  write(data: Uint8Array): void;
  writeRaw?(data: Uint8Array): void;
}

interface Socket {
  s(message: Record<string, unknown>): void;
}

interface UploadFile {
  path: string;
  name: string;
  size: number;
}

export type XmodemReceiveWrite = (
  file: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
) => number;

function crc16(data: Uint8Array): number {
  let value = 0;
  for (const byte of data) {
    value ^= byte << 8;
    for (let bit = 0; bit < 8; bit++)
      value = ((value << 1) ^ (value & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return value;
}

function checksum(data: Uint8Array): number {
  let value = 0;
  for (const byte of data) value = (value + byte) & 0xff;
  return value;
}

function packet(block: number, payload: Buffer, crcMode: boolean): Buffer {
  const size = payload.length;
  const result = Buffer.alloc(3 + size + (crcMode ? 2 : 1));
  result[0] = size === LONG_BLOCK_BYTES ? STX : SOH;
  result[1] = block & 0xff;
  result[2] = 0xff ^ result[1]!;
  payload.copy(result, 3);
  if (crcMode) result.writeUInt16BE(crc16(payload), 3 + size);
  else result[3 + size] = checksum(payload);
  return result;
}

function stagedCleanupError(action: 'close' | 'remove', error: unknown): Error {
  const safe = new Error(`Unable to ${action} staged XMODEM file`);
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

export class XmodemSession {
  private state: State = 'idle';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private crcMode = true;
  private input = Buffer.alloc(0);
  private root: string | undefined;
  private receiveName: string | undefined;
  private receiveFile: number | undefined;
  private receiveTemp: string | undefined;
  private receiveRecordId: string | undefined;
  private receiveTarget: string | undefined;
  private receiveBlock = 1;
  private receivedBytes = 0;
  private upload: UploadFile | undefined;
  private uploadFile: number | undefined;
  private peerMode: 'crc' | 'checksum' | undefined;
  private sendBlock = 1;
  private sentBytes = 0;
  private pendingBytes = 0;
  private pendingPacket: Buffer | undefined;
  private startedAt = 0;
  private generation = 0;
  private readonly pendingPublications = new Set<Promise<void>>();

  constructor(
    private readonly terminal: Terminal,
    private readonly socket: Socket,
    private readonly onFinish: () => void = () => {},
    private readonly receiveWrite: XmodemReceiveWrite = writeSync,
    private readonly publishReceiveFile: typeof publishStagedFile = publishStagedFile,
    private readonly removeStage: typeof unlinkSync = unlinkSync,
    private readonly journal?: StageOwnershipWriter,
  ) {}

  isActive(): boolean {
    return this.state !== 'idle';
  }

  startReceive(): void {
    if (this.state === 'publishing') return;
    const cleanupFailure = this.reset();
    if (cleanupFailure) {
      this.emit('session-error', { error: cleanupFailure.message });
      return;
    }
    this.state = 'receive';
    this.startedAt = Date.now();
    this.emit('receive-start');
    this.armTimeout();
  }

  setSavePath(path: string, name?: string): void {
    if (this.state !== 'receive') return;
    if (typeof path !== 'string' || !path) {
      this.fail('Save directory is unavailable');
      return;
    }
    this.root = path;
    this.receiveName = typeof name === 'string' ? name : undefined;
    this.write(Buffer.from([CRC_REQUEST]));
    this.armTimeout();
  }

  startSend(): void {
    if (this.state === 'publishing') return;
    const cleanupFailure = this.reset();
    if (cleanupFailure) {
      this.emit('session-error', { error: cleanupFailure.message });
      return;
    }
    this.state = 'wait-send';
    this.startedAt = Date.now();
    this.emit('send-start');
    this.armTimeout();
  }

  setSendFiles(files: UploadFile[]): void {
    if (this.state !== 'wait-send') return;
    if (
      !Array.isArray(files) ||
      files.length !== 1 ||
      typeof files[0]?.path !== 'string' ||
      typeof files[0]?.name !== 'string' ||
      !Number.isSafeInteger(files[0]?.size) ||
      files[0]!.size < 0 ||
      files[0]!.size > MAX_TRANSFER_BYTES
    ) {
      this.fail('XMODEM requires one readable file');
      return;
    }
    this.upload = files[0];
    if (this.peerMode) this.beginSend();
  }

  handleData(data: Uint8Array): boolean {
    if (this.state === 'idle') return false;
    const bytes = Buffer.from(data);
    if (this.state === 'receive') this.handleReceive(bytes);
    else if (this.state !== 'publishing')
      for (const byte of bytes) {
        if (!this.isActive()) break;
        this.handleSendControl(byte);
      }
    return true;
  }

  cancel(): void {
    if (!this.isActive()) return;
    // EOT has already committed the receive to an uncancellable filesystem
    // operation. Wait for its result so the peer gets an honest ACK or CAN.
    if (this.state === 'publishing') return;
    this.write(Buffer.from([CAN, CAN]));
    this.finish();
  }

  destroy(): Promise<void> {
    const resetFailure = this.reset();
    return Promise.allSettled(this.pendingPublications).then((results) => {
      const failures = [
        ...(resetFailure ? [resetFailure] : []),
        ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
      ];
      if (failures.length > 0) throw new AggregateError(failures, 'XMODEM cleanup failed');
    });
  }

  private handleReceive(bytes: Buffer): void {
    if (this.input.length + bytes.length > MAX_INPUT_BYTES) {
      this.fail('XMODEM input buffer limit exceeded');
      return;
    }
    this.input = Buffer.concat([this.input, bytes]);
    while (this.state === 'receive' && this.input.length) {
      const marker = this.input[0];
      if (marker === CAN) {
        this.fail('Remote canceled XMODEM transfer', false);
        return;
      }
      if (marker === EOT) {
        this.input = this.input.subarray(1);
        this.completeReceive();
        return;
      }
      if (marker !== SOH && marker !== STX) {
        this.input = this.input.subarray(1);
        continue;
      }
      const size = marker === SOH ? BLOCK_BYTES : LONG_BLOCK_BYTES;
      const length = size + (this.crcMode ? 5 : 4);
      if (this.input.length < length) break;
      const frame = this.input.subarray(0, length);
      this.input = this.input.subarray(length);
      if (!this.acceptFrame(frame, size)) return;
    }
    if (this.state === 'receive') this.armTimeout();
  }

  private acceptFrame(frame: Buffer, size: number): boolean {
    const block = frame[1]!;
    const payload = frame.subarray(3, 3 + size);
    const check = this.crcMode ? frame.readUInt16BE(3 + size) : frame[3 + size];
    const actual = this.crcMode ? crc16(payload) : checksum(payload);
    if ((block ^ frame[2]!) !== 0xff || check !== actual) {
      this.retryReceive();
      this.input = Buffer.alloc(0);
      return false;
    }
    if (block === ((this.receiveBlock - 1) & 0xff)) {
      this.write(Buffer.from([ACK]));
      return true;
    }
    if (block !== (this.receiveBlock & 0xff)) {
      this.fail('Unexpected XMODEM block number');
      return false;
    }
    try {
      if (this.receivedBytes + payload.length > MAX_TRANSFER_BYTES)
        throw new Error('XMODEM transfer size limit exceeded');
      this.openReceiveFile();
      let written = 0;
      while (written < payload.length) {
        const count = this.receiveWrite(
          this.receiveFile!,
          payload,
          written,
          payload.length - written,
        );
        if (count === 0) throw new Error('XMODEM write made no progress');
        written += count;
        if (this.journal && this.receiveRecordId)
          this.journal.seal(this.receiveRecordId, this.receiveFile!);
      }
    } catch {
      this.fail('Unable to write received XMODEM file');
      return false;
    }
    this.receiveBlock += 1;
    this.receivedBytes += payload.length;
    this.retries = 0;
    this.progress('download', this.receivedBytes, 0, this.receiveName);
    this.write(Buffer.from([ACK]));
    return true;
  }

  private openReceiveFile(): void {
    if (this.receiveFile !== undefined) return;
    if (!this.root) throw new Error('Save directory is unavailable');
    const name = safeName(this.receiveName || `xmodem-${Date.now()}.bin`);
    const target = join(this.root, name);
    const temp = join(this.root, `.axterm-transfer-${randomBytes(12).toString('hex')}.part`);
    if (this.journal)
      this.receiveRecordId = this.journal.prepare(this.root, basename(temp), name, 'xmodem');
    try {
      this.receiveFile = openSync(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      this.receiveTemp = temp;
      if (this.journal && this.receiveRecordId)
        this.journal.seal(this.receiveRecordId, this.receiveFile);
    } catch (error) {
      if (this.journal && this.receiveRecordId)
        this.journal.clearIfAbsent(this.receiveRecordId, this.root);
      throw error;
    }
    this.receiveTarget = target;
    this.receiveName = basename(target);
    this.emit('file-start', { name: this.receiveName, size: 0 });
  }

  private completeReceive(): void {
    try {
      this.openReceiveFile();
      fsyncSync(this.receiveFile!);
      closeSync(this.receiveFile!);
      this.receiveFile = undefined;
      const source = this.receiveTemp!;
      const base = this.receiveTarget!;
      this.receiveTemp = undefined;
      this.state = 'publishing';
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      const publication = this.publishReceive(source, base, this.generation);
      this.pendingPublications.add(publication);
      void publication.then(
        () => this.pendingPublications.delete(publication),
        () => this.pendingPublications.delete(publication),
      );
    } catch {
      this.fail('Unable to finish received XMODEM file');
    }
  }

  private async publishReceive(source: string, base: string, generation: number): Promise<void> {
    let target: string | undefined;
    let publicationFailure: unknown;
    try {
      target = await this.linkToAvailableTarget(source, base, generation);
    } catch (error) {
      publicationFailure = error;
    }
    // Hard-link publication leaves the private source name behind. Native
    // no-replace rename consumes it. Cleanup must settle before ACK or
    // session-end, and a failed removal must reach Runtime destruction.
    const cleanupFailure = this.removeOwnedStage(source);
    if (generation !== this.generation || this.state !== 'publishing') {
      if (cleanupFailure) throw cleanupFailure;
      return;
    }
    if (cleanupFailure) {
      this.fail(
        target
          ? 'Received XMODEM file may exist, but staged cleanup failed'
          : 'Unable to clean received XMODEM staging file',
      );
      throw cleanupFailure;
    }
    if (publicationFailure) {
      this.fail(
        destinationCreatedBeforePublicationFailure(publicationFailure)
          ? 'Received XMODEM file may exist, but filesystem durability could not be verified'
          : 'Unable to finish received XMODEM file',
        true,
        destinationDoesNotSupportAtomicPublication(publicationFailure)
          ? 'TRANSFER_DESTINATION_UNSUPPORTED'
          : undefined,
      );
      return;
    }
    this.write(Buffer.from([ACK]));
    this.emit('file-complete', { name: basename(target!) });
    this.finish();
  }

  private async linkToAvailableTarget(
    source: string,
    base: string,
    generation: number,
  ): Promise<string> {
    // Hard links make publication atomic and never overwrite. The shared
    // publisher uses native no-replace rename on hard-link-limited filesystems;
    // it fails closed when that native primitive is unavailable.
    for (let attempt = 0; attempt < 8; attempt++) {
      if (generation !== this.generation) throw new Error('XMODEM receive was destroyed');
      const suffix = attempt ? `.${randomBytes(4).toString('hex')}` : '';
      const candidate = suffix
        ? join(
            dirname(base),
            `${safeName(basename(base), Buffer.byteLength(suffix, 'utf8'))}${suffix}`,
          )
        : base;
      try {
        await this.publishReceiveFile(source, candidate);
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new Error('No available destination name');
  }

  private handleSendControl(byte: number): void {
    if (byte === CAN) {
      this.fail('Remote canceled XMODEM transfer', false);
      return;
    }
    if (this.state === 'wait-send') {
      if (byte !== CRC_REQUEST && byte !== NAK) return;
      this.peerMode = byte === CRC_REQUEST ? 'crc' : 'checksum';
      if (this.upload) this.beginSend();
      return;
    }
    if (byte === NAK) {
      this.retrySend();
      return;
    }
    if (byte !== ACK) return;
    this.retries = 0;
    if (this.state === 'send-eot') {
      this.emit('file-complete', { name: this.upload?.name });
      this.finish();
      return;
    }
    if (this.state !== 'send-packet') return;
    this.sentBytes += this.pendingBytes;
    this.sendBlock += 1;
    this.pendingPacket = undefined;
    this.progress('upload', this.sentBytes, this.upload?.size ?? 0, this.upload?.name);
    this.sendNext();
  }

  private beginSend(): void {
    if (!this.upload || !this.peerMode || this.state !== 'wait-send') return;
    this.crcMode = this.peerMode === 'crc';
    try {
      if (lstatSync(this.upload.path).isSymbolicLink())
        throw new Error('XMODEM source must not be a symbolic link');
      this.uploadFile = openSync(
        this.upload.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const metadata = fstatSync(this.uploadFile);
      if (
        !metadata.isFile() ||
        !Number.isSafeInteger(metadata.size) ||
        metadata.size > MAX_TRANSFER_BYTES
      )
        throw new Error('XMODEM source must be a bounded regular file');
      this.upload = { ...this.upload, size: metadata.size };
    } catch {
      this.fail('Unable to open XMODEM upload file');
      return;
    }
    this.retries = 0;
    this.emit('file-start', { name: this.upload.name, size: this.upload.size });
    this.sendNext();
  }

  private sendNext(): void {
    if (!this.upload || this.uploadFile === undefined) return;
    if (this.sentBytes >= this.upload.size) {
      this.state = 'send-eot';
      this.write(Buffer.from([EOT]));
      this.armTimeout();
      return;
    }
    const payload = Buffer.alloc(BLOCK_BYTES, 0x1a);
    try {
      const needed = Math.min(BLOCK_BYTES, this.upload.size - this.sentBytes);
      let read = 0;
      while (read < needed) {
        const count = readSync(
          this.uploadFile,
          payload,
          read,
          needed - read,
          this.sentBytes + read,
        );
        if (count === 0) throw new Error('Upload file changed during transfer');
        read += count;
      }
      this.pendingBytes = needed;
    } catch {
      this.fail('Unable to read XMODEM upload file');
      return;
    }
    this.pendingPacket = packet(this.sendBlock, payload, this.crcMode);
    this.state = 'send-packet';
    this.write(this.pendingPacket);
    this.armTimeout();
  }

  private retrySend(): void {
    if (++this.retries > MAX_RETRIES) {
      this.fail('XMODEM retry limit exceeded');
      return;
    }
    if (this.state === 'send-packet' && this.pendingPacket) this.write(this.pendingPacket);
    else if (this.state === 'send-eot') this.write(Buffer.from([EOT]));
    this.armTimeout();
  }

  private retryReceive(): void {
    if (++this.retries > MAX_RETRIES) {
      this.fail('XMODEM retry limit exceeded');
      return;
    }
    this.write(Buffer.from([NAK]));
    this.armTimeout();
  }

  private armTimeout(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.state === 'receive') {
        if (this.root) {
          if (this.receiveBlock === 1 && this.retries < 3) this.write(Buffer.from([CRC_REQUEST]));
          else {
            if (this.receiveBlock === 1) this.crcMode = false;
            this.write(Buffer.from([NAK]));
          }
        }
        if (++this.retries > MAX_RETRIES) this.fail('XMODEM receive timed out');
        else this.armTimeout();
      } else if (this.state === 'wait-send') {
        if (++this.retries > MAX_RETRIES) this.fail('XMODEM peer did not start');
        else this.armTimeout();
      } else if (this.state === 'send-packet' || this.state === 'send-eot') this.retrySend();
    }, PEER_TIMEOUT_MS);
    this.timer.unref();
  }

  private write(bytes: Buffer): void {
    if (this.terminal.writeRaw) this.terminal.writeRaw(bytes);
    else this.terminal.write(bytes);
  }

  private emit(event: string, detail: Record<string, unknown> = {}): void {
    this.socket.s({ action: 'xmodem-event', event, ...detail });
  }

  private progress(
    type: 'download' | 'upload',
    transferred: number,
    size: number,
    name: string | undefined,
  ): void {
    const elapsed = Math.max((Date.now() - this.startedAt) / 1000, 0.001);
    this.emit('progress', {
      type,
      transferred,
      size,
      name,
      speed: Math.floor(transferred / elapsed),
    });
  }

  private fail(
    message: string,
    signalPeer = true,
    errorCode?: 'TRANSFER_DESTINATION_UNSUPPORTED',
  ): void {
    if (signalPeer) this.write(Buffer.from([CAN, CAN]));
    this.emit('session-error', { error: message, ...(errorCode ? { errorCode } : {}) });
    this.finish();
  }

  private finish(): void {
    const cleanupFailure = this.reset();
    if (cleanupFailure) this.emit('session-error', { error: cleanupFailure.message });
    this.emit('session-end');
    this.onFinish();
  }

  private removeOwnedStage(path: string): Error | undefined {
    let failure: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.removeStage(path);
        if (this.journal && this.receiveRecordId)
          this.journal.clearIfAbsent(this.receiveRecordId, dirname(path));
        return undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (this.journal && this.receiveRecordId)
            this.journal.clearIfAbsent(this.receiveRecordId, dirname(path));
          return undefined;
        }
        failure = stagedCleanupError('remove', error);
      }
    }
    return failure;
  }

  private reset(): Error | undefined {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let cleanupFailure: Error | undefined;
    if (this.receiveFile !== undefined) {
      try {
        closeSync(this.receiveFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EBADF')
          cleanupFailure = stagedCleanupError('close', error);
      }
    }
    if (this.uploadFile !== undefined) {
      try {
        closeSync(this.uploadFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EBADF')
          cleanupFailure ??= stagedCleanupError('close', error);
      }
    }
    if (this.receiveTemp) {
      const removalFailure = this.removeOwnedStage(this.receiveTemp);
      cleanupFailure ??= removalFailure;
    }
    this.state = 'idle';
    this.retries = 0;
    this.crcMode = true;
    this.input = Buffer.alloc(0);
    this.root = undefined;
    this.receiveName = undefined;
    this.receiveFile = undefined;
    this.receiveTemp = undefined;
    this.receiveRecordId = undefined;
    this.receiveTarget = undefined;
    this.receiveBlock = 1;
    this.receivedBytes = 0;
    this.upload = undefined;
    this.uploadFile = undefined;
    this.peerMode = undefined;
    this.sendBlock = 1;
    this.sentBytes = 0;
    this.pendingBytes = 0;
    this.pendingPacket = undefined;
    return cleanupFailure;
  }
}

export class XmodemManager {
  private readonly sessions = new Map<string, XmodemSession>();

  constructor(
    private readonly createSession: (
      terminal: Terminal,
      socket: Socket,
      onFinish: () => void,
    ) => XmodemSession = (terminal, socket, onFinish) =>
      new XmodemSession(terminal, socket, onFinish),
  ) {}

  handleData(id: string, data: Buffer): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    const consumed = session.handleData(data);
    if (!session.isActive()) this.sessions.delete(id);
    return consumed;
  }

  handleMessage(
    id: string,
    message: Record<string, unknown>,
    terminal: Terminal,
    socket: Socket,
  ): void {
    let session = this.sessions.get(id);
    if (!session) {
      session = this.createSession(terminal, socket, () => this.sessions.delete(id));
      this.sessions.set(id, session);
    }
    switch (message.event) {
      case 'start-receive':
        session.startReceive();
        break;
      case 'start-send':
        session.startSend();
        break;
      case 'set-save-path':
        session.setSavePath(message.path as string, message.name as string | undefined);
        break;
      case 'send-files':
        session.setSendFiles(message.files as UploadFile[]);
        break;
      case 'cancel':
        session.cancel();
        break;
    }
    if (!session.isActive()) this.sessions.delete(id);
  }

  destroySession(id: string): Promise<void> | undefined {
    const cleanup = this.sessions.get(id)?.destroy();
    this.sessions.delete(id);
    return cleanup;
  }

  isActive(id: string): boolean {
    return this.sessions.get(id)?.isActive() ?? false;
  }
}
