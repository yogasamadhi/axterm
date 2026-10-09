import { randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, createWriteStream, type Stats } from 'node:fs';
import {
  type FileHandle,
  lstat,
  opendir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  mkdir,
  open,
} from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { EOL } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  LocalFtpServerAdapter,
  LocalFtpServerOptions,
  RunningWidgetServer,
} from '../../ports/widget-server';

// FTP control, passive-data and file operations are implemented here from the
// public protocol specifications (RFC 959, 2428 and 3659). No FTP server
// dependency or process-global signal handler is installed by this adapter.
const MAX_CLIENTS = 16;
const MAX_COMMAND_BYTES = 4_096;
const MAX_QUEUED_COMMANDS = 32;
const MAX_DIRECTORY_ENTRIES = 1_000;
const SOCKET_TIMEOUT_MS = 30_000;
const DATA_TIMEOUT_MS = 15_000;
const HOST_EOL = Buffer.from(EOL);
const LOCAL_FTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const INTERNAL_STAGING_FILE =
  /^\.axterm-ftp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.part$/u;

interface FilesystemIdentity {
  dev: number;
  ino: number;
}

interface NvtAsciiRestartPosition {
  localOffset: number;
  pendingCarriageReturn?: 'network' | 'local';
}

export type FtpStagingWriteStreamFactory = (
  path: string,
  options: { flags: 'a' | 'wx'; mode: number },
) => Writable;
type FtpRestartSourceOpener = (path: string, flags: number) => Promise<FileHandle>;
type FtpReadFileOpener = (path: string, flags: number) => Promise<FileHandle>;

const createNodeFtpStagingWriteStream: FtpStagingWriteStreamFactory = (path, options) =>
  createWriteStream(path, options);

export class NodeLocalFtpServer implements LocalFtpServerAdapter {
  constructor(
    private readonly createStagingWriteStream: FtpStagingWriteStreamFactory = createNodeFtpStagingWriteStream,
    private readonly openRestartSource: FtpRestartSourceOpener = open,
    private readonly openReadFile: FtpReadFileOpener = open,
    private readonly controlTimeoutMs = SOCKET_TIMEOUT_MS,
    private readonly activeDataTimeoutMs = DATA_TIMEOUT_MS,
  ) {}

  async start(options: LocalFtpServerOptions): Promise<RunningWidgetServer> {
    if (!LOCAL_FTP_HOSTS.has(options.host))
      throw new Error('FTP Widget may bind only to a loopback address');
    const root = await realpath(options.rootPath);
    if (!(await stat(root)).isDirectory()) throw new Error('FTP Widget root is not a directory');
    const sessions = new Set<FtpSession>();
    const server = createServer((socket) => {
      if (sessions.size >= MAX_CLIENTS) {
        socket.end('421 Too many connections\r\n');
        return;
      }
      const session = new FtpSession(
        socket,
        root,
        options,
        this.createStagingWriteStream,
        this.openRestartSource,
        this.openReadFile,
        this.controlTimeoutMs,
        this.activeDataTimeoutMs,
        () => sessions.delete(session),
      );
      sessions.add(session);
    });
    server.maxConnections = MAX_CLIENTS;
    try {
      await listen(server, options.port, options.host);
    } catch (error) {
      server.close();
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('FTP Widget server did not bind TCP');
    }
    let closed: Promise<void> | undefined;
    return {
      host: options.host,
      port: address.port,
      url: `ftp://${printableHost(options.host)}:${address.port}`,
      stop: () => {
        closed ??= (async () => {
          const active = [...sessions];
          for (const session of active) session.close();
          await Promise.all([
            new Promise<void>((resolveClose) => server.close(() => resolveClose())),
            ...active.map((session) => session.whenStopped()),
          ]);
        })();
        return closed;
      },
    };
  }
}

class FtpSession {
  private readonly socket: Socket;
  private readonly root: string;
  private readonly options: LocalFtpServerOptions;
  private readonly createStagingWriteStream: FtpStagingWriteStreamFactory;
  private readonly openRestartSource: FtpRestartSourceOpener;
  private readonly openReadFile: FtpReadFileOpener;
  private readonly controlTimeoutMs: number;
  private readonly activeDataTimeoutMs: number;
  private readonly onClose: () => void;
  private commandBuffer = Buffer.alloc(0);
  private pendingCommands = 0;
  private commandQueue: Promise<void> = Promise.resolve();
  private username = '';
  private authenticated = false;
  private failedLogins = 0;
  private cwd = '/';
  private transferType: 'A' | 'I' = 'A';
  private passive: PassiveSocket | undefined;
  private activeEndpoint: { host: string; port: number } | undefined;
  private activeData: Socket | undefined;
  private pendingDataAbort: (() => void) | undefined;
  private abortRequested = false;
  private renameFrom: { file: string; identity: FilesystemIdentity } | undefined;
  private restartOffset = 0;
  private closed = false;

  constructor(
    socket: Socket,
    root: string,
    options: LocalFtpServerOptions,
    createStagingWriteStream: FtpStagingWriteStreamFactory,
    openRestartSource: FtpRestartSourceOpener,
    openReadFile: FtpReadFileOpener,
    controlTimeoutMs: number,
    activeDataTimeoutMs: number,
    onClose: () => void,
  ) {
    this.socket = socket;
    this.root = root;
    this.options = options;
    this.createStagingWriteStream = createStagingWriteStream;
    this.openRestartSource = openRestartSource;
    this.openReadFile = openReadFile;
    this.controlTimeoutMs = controlTimeoutMs;
    this.activeDataTimeoutMs = activeDataTimeoutMs;
    this.onClose = onClose;
    socket.on('timeout', () => socket.destroy());
    socket.setTimeout(controlTimeoutMs);
    socket.on('error', () => undefined);
    socket.on('close', () => this.close());
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    this.reply(220, 'Axterm FTP ready');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.passive?.close();
    this.passive = undefined;
    this.activeEndpoint = undefined;
    this.pendingDataAbort?.();
    this.pendingDataAbort = undefined;
    this.activeData?.destroy();
    this.activeData = undefined;
    this.socket.destroy();
    this.onClose();
  }

  whenStopped(): Promise<void> {
    return this.commandQueue;
  }

  private receive(chunk: Buffer): void {
    if (chunk.length + this.commandBuffer.length > MAX_COMMAND_BYTES * MAX_QUEUED_COMMANDS) {
      this.close();
      return;
    }
    this.commandBuffer = Buffer.concat([this.commandBuffer, chunk]);
    let delimiter = this.commandBuffer.indexOf('\r\n');
    while (delimiter >= 0) {
      if (delimiter > MAX_COMMAND_BYTES || this.pendingCommands >= MAX_QUEUED_COMMANDS) {
        this.close();
        return;
      }
      const line = this.commandBuffer.subarray(0, delimiter).toString('utf8');
      this.commandBuffer = this.commandBuffer.subarray(delimiter + 2);
      if (line.toUpperCase() === 'ABOR') this.abortTransfer();
      this.pendingCommands += 1;
      this.commandQueue = this.commandQueue
        .then(() => this.command(line))
        .catch(() => this.reply(550, 'Requested action failed'))
        .finally(() => {
          this.pendingCommands -= 1;
          if (!this.closed) this.socket.setTimeout(this.controlTimeoutMs);
        });
      delimiter = this.commandBuffer.indexOf('\r\n');
    }
    if (this.commandBuffer.length > MAX_COMMAND_BYTES) this.close();
  }

  private reply(code: number, message: string): void {
    if (!this.closed && !this.socket.destroyed) this.socket.write(`${code} ${message}\r\n`);
  }

  private async command(line: string): Promise<void> {
    if (this.closed) return;
    const separator = line.indexOf(' ');
    const verb = (separator < 0 ? line : line.slice(0, separator)).toUpperCase();
    const argument = separator < 0 ? '' : line.slice(separator + 1);
    if (verb !== 'REST' && verb !== 'RETR' && verb !== 'STOR') this.restartOffset = 0;
    if (verb !== 'RNTO') this.renameFrom = undefined;
    switch (verb) {
      case 'USER':
        this.username = argument;
        this.authenticated = false;
        this.reply(331, 'Password required');
        return;
      case 'PASS':
        if (this.failedLogins >= 5) {
          this.reply(421, 'Too many login attempts');
          this.socket.end();
          return;
        }
        this.authenticated = this.options.anonymous
          ? this.username === 'anonymous'
          : this.options.password !== undefined &&
            secureEqual(this.username, this.options.username) &&
            secureEqual(argument, this.options.password);
        if (!this.authenticated) this.failedLogins += 1;
        this.reply(
          this.authenticated ? 230 : 530,
          this.authenticated ? 'Logged in' : 'Login failed',
        );
        return;
      case 'QUIT':
        this.reply(221, 'Goodbye');
        this.socket.end();
        return;
      case 'NOOP':
        this.reply(200, 'OK');
        return;
      case 'FEAT':
        this.socket.write(
          '211-Features\r\n UTF8\r\n EPSV\r\n REST STREAM\r\n MDTM\r\n SIZE\r\n MLST type*;size*;modify*;\r\n211 End\r\n',
        );
        return;
      case 'OPTS':
        this.reply(argument.toUpperCase() === 'UTF8 ON' ? 200 : 501, 'UTF8 option');
        return;
      case 'SYST':
        this.reply(215, 'UNIX Type: L8');
        return;
      default:
        break;
    }
    if (!this.authenticated) {
      this.reply(530, 'Please login');
      return;
    }
    switch (verb) {
      case 'TYPE':
        if (argument.trim().toUpperCase() === 'A' || argument.trim().toUpperCase() === 'I') {
          this.transferType = argument.trim().toUpperCase() as 'A' | 'I';
          this.reply(200, 'Type set');
        } else {
          this.reply(504, 'Representation type not supported');
        }
        break;
      case 'MODE':
        this.reply(argument === 'S' ? 200 : 504, 'Stream mode');
        break;
      case 'STRU':
        this.reply(argument === 'F' ? 200 : 504, 'File structure');
        break;
      case 'PWD':
      case 'XPWD':
        this.reply(257, `"${this.cwd.replaceAll('"', '""')}" is current directory`);
        break;
      case 'CWD':
      case 'XCWD':
        await this.changeDirectory(argument);
        break;
      case 'CDUP':
      case 'XCUP':
        await this.changeDirectory('..');
        break;
      case 'PASV':
      case 'EPSV':
        await this.enterPassive(verb);
        break;
      case 'PORT':
      case 'EPRT':
        this.enterActive(argument, verb);
        break;
      case 'LIST':
      case 'NLST':
      case 'MLSD':
        await this.list(argument, verb);
        break;
      case 'MLST':
        await this.machineList(argument);
        break;
      case 'SIZE':
      case 'MDTM':
        await this.fileMetadata(argument, verb);
        break;
      case 'RETR':
        await this.download(argument);
        break;
      case 'STOR':
        await this.upload(argument);
        break;
      case 'REST': {
        const offset = Number(argument);
        if (!/^\d+$/.test(argument) || !Number.isSafeInteger(offset)) {
          this.restartOffset = 0;
          this.reply(501, 'Invalid restart offset');
          return;
        }
        this.restartOffset = offset;
        this.reply(350, 'Restart position accepted');
        break;
      }
      case 'DELE':
        await this.removeFile(argument);
        break;
      case 'MKD':
      case 'XMKD':
        await this.makeDirectory(argument);
        break;
      case 'RMD':
      case 'XRMD':
        await this.removeDirectory(argument);
        break;
      case 'RNFR':
        await this.renameSource(argument);
        break;
      case 'RNTO':
        await this.renameTarget(argument);
        break;
      case 'ABOR':
        this.abortTransfer();
        this.abortRequested = false;
        this.reply(226, 'Abort complete');
        break;
      default:
        this.reply(502, 'Command not implemented');
    }
  }

  private virtualPath(input: string): string {
    if (input.length > MAX_COMMAND_BYTES || /[\0\r\n\\]/.test(input))
      throw new Error('Invalid FTP path');
    const virtual = posix.normalize(input.startsWith('/') ? input : posix.join(this.cwd, input));
    if (virtual.split('/').some(isInternalStagingFile))
      throw new Error('FTP path is reserved for internal staging');
    return virtual.startsWith('/') ? virtual : `/${virtual}`;
  }

  private lexicalPath(input: string): { virtual: string; file: string } {
    const virtual = this.virtualPath(input);
    const file = resolve(this.root, `.${virtual}`);
    if (!isInside(this.root, file)) throw new Error('FTP path escaped root');
    return { virtual, file };
  }

  private async existingPath(input: string): Promise<{ virtual: string; file: string }> {
    const target = this.lexicalPath(input);
    const file = await realpath(target.file);
    if (!isInside(this.root, file)) throw new Error('FTP path escaped root');
    return { virtual: target.virtual, file };
  }

  private async targetPath(input: string): Promise<{ virtual: string; file: string }> {
    const target = this.lexicalPath(input);
    const parent = await realpath(dirname(target.file));
    if (!isInside(this.root, parent)) throw new Error('FTP path escaped root');
    const file = join(parent, basename(target.file));
    try {
      const existing = await realpath(file);
      if (!isInside(this.root, existing)) throw new Error('FTP path escaped root');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return { virtual: target.virtual, file };
  }

  private async mutableExistingPath(input: string): Promise<{ virtual: string; file: string }> {
    const target = await this.targetPath(input);
    if ((await lstat(target.file)).isSymbolicLink())
      throw new Error('FTP symbolic link mutation denied');
    return target;
  }

  private async changeDirectory(argument: string): Promise<void> {
    const target = await this.existingPath(argument || '/');
    if (!(await stat(target.file)).isDirectory()) throw new Error('Not a directory');
    this.cwd = target.virtual;
    this.reply(250, 'Directory changed');
  }

  private async enterPassive(verb: 'PASV' | 'EPSV'): Promise<void> {
    this.passive?.close();
    this.passive = undefined;
    this.activeEndpoint = undefined;
    const localAddress = this.socket.localAddress;
    if (!localAddress) throw new Error('FTP control socket has no local address');
    if (verb === 'PASV' && !ipv4Address(localAddress)) {
      this.reply(522, 'Use EPSV for IPv6');
      return;
    }
    const passive = await PassiveSocket.open(
      localAddress,
      this.socket.remoteAddress ?? '',
      this.options.passivePortStart,
      this.options.passivePortEnd,
    );
    this.passive = passive;
    if (verb === 'EPSV') {
      this.reply(229, `Entering Extended Passive Mode (|||${passive.port}|)`);
      return;
    }
    const octets = ipv4Address(localAddress)!.split('.').join(',');
    this.reply(227, `Entering Passive Mode (${octets},${passive.port >> 8},${passive.port & 255})`);
  }

  private enterActive(argument: string, verb: 'PORT' | 'EPRT'): void {
    const endpoint = verb === 'PORT' ? parsePort(argument) : parseEprt(argument);
    if (
      !endpoint ||
      !sameAddress(this.socket.remoteAddress ?? '', endpoint.host) ||
      endpoint.port < 1_024
    ) {
      this.reply(501, 'Invalid active data address');
      return;
    }
    this.passive?.close();
    this.passive = undefined;
    this.activeEndpoint = endpoint;
    this.reply(200, 'Active data address accepted');
  }

  private async dataSocket(): Promise<Socket | undefined> {
    const passive = this.passive;
    const activeEndpoint = this.activeEndpoint;
    this.passive = undefined;
    this.activeEndpoint = undefined;
    if (!passive && !activeEndpoint) {
      this.reply(425, 'Use PASV, EPSV, PORT or EPRT first');
      return undefined;
    }
    let connecting: Socket | undefined;
    this.pendingDataAbort = passive
      ? () => passive.close()
      : () => connecting?.destroy(new Error('FTP data transfer aborted'));
    this.reply(150, 'Opening data connection');
    try {
      const data = passive
        ? await passive.take()
        : await connectActive(
            activeEndpoint!.host,
            activeEndpoint!.port,
            (socket) => {
              connecting = socket;
              if (this.abortRequested) socket.destroy(new Error('FTP data transfer aborted'));
            },
            this.activeDataTimeoutMs,
          );
      if (this.abortRequested) {
        data.destroy();
        throw new Error('FTP data transfer aborted');
      }
      this.activeData = data;
      // A healthy data transfer may legitimately keep the control channel
      // quiet longer than its idle limit. The queued command restores that
      // limit only after data, publication and the final reply have settled.
      this.socket.setTimeout(0);
      data.once('close', () => {
        if (this.activeData === data) this.activeData = undefined;
      });
      return data;
    } catch {
      this.reply(
        this.abortRequested ? 426 : 425,
        this.abortRequested ? 'Transfer aborted' : 'Data connection failed',
      );
      return undefined;
    } finally {
      this.pendingDataAbort = undefined;
    }
  }

  private abortTransfer(): void {
    this.abortRequested = true;
    this.pendingDataAbort?.();
    this.passive?.close();
    this.passive = undefined;
    this.activeEndpoint = undefined;
    this.activeData?.destroy();
  }

  private async list(argument: string, verb: 'LIST' | 'NLST' | 'MLSD'): Promise<void> {
    const target = await this.existingPath(argument || this.cwd);
    const fileStat = await stat(target.file);
    const entries: string[] = [];
    if (fileStat.isDirectory()) {
      for await (const entry of await opendir(target.file, { bufferSize: 32 })) {
        if (entries.length >= MAX_DIRECTORY_ENTRIES)
          throw new Error('Directory listing limit exceeded');
        entries.push(entry.name);
      }
    } else {
      entries.push(basename(target.file));
    }
    const lines: string[] = [];
    for (const name of entries) {
      if (/[\r\n\0]/.test(name) || isInternalStagingFile(name)) continue;
      const path = fileStat.isDirectory() ? join(target.file, name) : target.file;
      const entryStat = await lstat(path);
      if (entryStat.isSymbolicLink()) continue;
      if (verb === 'NLST') lines.push(`${name}\r\n`);
      else if (verb === 'MLSD') lines.push(mlsdEntry(name, entryStat));
      else lines.push(listEntry(name, entryStat));
    }
    const data = await this.dataSocket();
    if (!data) return;
    try {
      await pipeline([Buffer.from(lines.join(''))], data);
      this.reply(226, 'Transfer complete');
    } catch {
      data.destroy();
      this.reply(426, 'Transfer failed');
    }
  }

  private async openConfinedReadFile(
    argument: string,
  ): Promise<{ file: FileHandle; fileStat: Stats }> {
    const target = await this.existingPath(argument);
    const before = await lstat(target.file);
    const file = await this.openReadFile(target.file, constants.O_RDONLY | noFollowFlag());
    try {
      const fileStat = await file.stat();
      const current = await this.existingPath(argument);
      const after = await lstat(target.file);
      if (
        !fileStat.isFile() ||
        current.file !== target.file ||
        !sameFilesystemIdentity(filesystemIdentity(before), filesystemIdentity(fileStat)) ||
        !sameFilesystemIdentity(filesystemIdentity(fileStat), filesystemIdentity(after))
      )
        throw new Error('FTP read target changed while opening');
      return { file, fileStat };
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error;
    }
  }

  private async fileMetadata(argument: string, verb: 'SIZE' | 'MDTM'): Promise<void> {
    const { file, fileStat } = await this.openConfinedReadFile(argument);
    try {
      const size =
        verb === 'SIZE' && this.transferType === 'A'
          ? await nvtAsciiTransferSize(file)
          : fileStat.size;
      this.reply(213, verb === 'SIZE' ? `${size}` : utcTimestamp(fileStat.mtime));
    } finally {
      await file.close().catch(() => undefined);
    }
  }

  private async machineList(argument: string): Promise<void> {
    const target = await this.existingPath(argument || this.cwd);
    const fileStat = await stat(target.file);
    const name = target.virtual === '/' ? '/' : basename(target.virtual);
    this.socket.write(`250-Listing\r\n ${mlsdEntry(name, fileStat)}250 End\r\n`);
  }

  private async download(argument: string): Promise<void> {
    const start = this.restartOffset;
    this.restartOffset = 0;
    const { file, fileStat } = await this.openConfinedReadFile(argument);
    try {
      const transferSize =
        this.transferType === 'A' ? await nvtAsciiTransferSize(file) : fileStat.size;
      if (start > transferSize) throw new Error('Not a readable regular file');
      const data = await this.dataSocket();
      if (!data) return;
      try {
        const source = file.createReadStream({ start: this.transferType === 'A' ? 0 : start });
        if (this.transferType === 'A') {
          await pipeline(source, nvtAsciiEncoder(), skipOctets(start), data);
        } else {
          await pipeline(source, data);
        }
        this.reply(226, 'Transfer complete');
      } catch {
        data.destroy();
        this.reply(426, 'Transfer failed');
      }
    } finally {
      await file.close().catch(() => undefined);
    }
  }

  private async upload(argument: string): Promise<void> {
    const restartOffset = this.restartOffset;
    this.restartOffset = 0;
    const target = await this.targetPath(argument);
    if (target.file === this.root) throw new Error('Cannot replace FTP root');
    const targetParentIdentity = filesystemIdentity(await lstat(dirname(target.file)));
    let restartSource: FileHandle | undefined;
    let restartSourceIdentity: FilesystemIdentity | undefined;
    let restartSourceOffset = restartOffset;
    let restartAsciiPendingCarriageReturn: 'network' | 'local' | undefined;
    if (restartOffset > 0) {
      const existing = await this.existingPath(argument);
      if (existing.file !== target.file)
        throw new Error('FTP restart target is not a regular path');
      restartSource = await this.openRestartSource(
        target.file,
        constants.O_RDONLY | noFollowFlag(),
      );
      try {
        const sourceStat = await restartSource.stat();
        if (!sourceStat.isFile()) throw new Error('Invalid FTP upload restart offset');
        if (this.transferType === 'A') {
          const restartPosition = await nvtAsciiRestartPosition(restartSource, restartOffset);
          restartSourceOffset = restartPosition?.localOffset ?? -1;
          restartAsciiPendingCarriageReturn = restartPosition?.pendingCarriageReturn;
        }
        if (restartSourceOffset < 0 || restartSourceOffset > sourceStat.size)
          throw new Error('Invalid FTP upload restart offset');
        restartSourceIdentity = filesystemIdentity(sourceStat);
      } catch (error) {
        await restartSource.close().catch(() => undefined);
        throw error;
      }
    }
    // Keep the staging pathname anchored to the grant root. If the destination
    // directory is exchanged while bytes are still arriving, cleanup must not
    // follow that new directory or lose the only pathname for the partial file.
    const temp = join(this.root, `.axterm-ftp-${randomUUID()}.part`);
    const data = await this.dataSocket();
    if (!data) {
      await restartSource?.close().catch(() => undefined);
      return;
    }
    try {
      if (restartSource) {
        if (restartSourceOffset > 0) {
          await pipeline(
            restartSource.createReadStream({
              start: 0,
              end: restartSourceOffset - 1,
              autoClose: false,
            }),
            this.createStagingWriteStream(temp, { flags: 'wx', mode: 0o600 }),
          );
        }
        const stagingFlags = restartSourceOffset > 0 ? 'a' : 'wx';
        if (this.transferType === 'A') {
          await pipeline(
            data,
            nvtAsciiDecoder(restartAsciiPendingCarriageReturn),
            this.createStagingWriteStream(temp, { flags: stagingFlags, mode: 0o600 }),
          );
        } else {
          await pipeline(
            data,
            this.createStagingWriteStream(temp, { flags: stagingFlags, mode: 0o600 }),
          );
        }
        await restartSource.close();
        restartSource = undefined;
      } else {
        if (this.transferType === 'A') {
          await pipeline(
            data,
            nvtAsciiDecoder(),
            this.createStagingWriteStream(temp, { flags: 'wx', mode: 0o600 }),
          );
        } else {
          await pipeline(data, this.createStagingWriteStream(temp, { flags: 'wx', mode: 0o600 }));
        }
      }
      const currentTarget = await this.targetPath(argument);
      const currentParentIdentity = filesystemIdentity(await lstat(dirname(currentTarget.file)));
      if (
        currentTarget.file !== target.file ||
        !sameFilesystemIdentity(targetParentIdentity, currentParentIdentity)
      )
        throw new Error('FTP upload target changed during transfer');
      if (restartSourceIdentity) {
        const currentSource = await realpath(currentTarget.file);
        if (
          currentSource !== currentTarget.file ||
          !sameFilesystemIdentity(
            restartSourceIdentity,
            filesystemIdentity(await lstat(currentSource)),
          )
        )
          throw new Error('FTP upload restart source changed during transfer');
      }
      await rename(temp, currentTarget.file);
      this.reply(226, 'Transfer complete');
    } catch {
      data.destroy();
      await restartSource?.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      this.reply(426, 'Transfer failed');
    }
  }

  private async removeFile(argument: string): Promise<void> {
    const target = await this.mutableExistingPath(argument);
    if (!(await stat(target.file)).isFile()) throw new Error('Not a file');
    await unlink(target.file);
    this.reply(250, 'File deleted');
  }

  private async makeDirectory(argument: string): Promise<void> {
    const target = await this.targetPath(argument);
    await mkdir(target.file);
    this.reply(257, `"${target.virtual.replaceAll('"', '""')}" created`);
  }

  private async removeDirectory(argument: string): Promise<void> {
    const target = await this.mutableExistingPath(argument);
    if (target.file === this.root) throw new Error('Cannot remove FTP root');
    await rmdir(target.file);
    this.reply(250, 'Directory removed');
  }

  private async renameSource(argument: string): Promise<void> {
    const source = await this.mutableExistingPath(argument);
    if (source.file === this.root) throw new Error('Cannot rename FTP root');
    this.renameFrom = {
      file: source.file,
      identity: filesystemIdentity(await lstat(source.file)),
    };
    this.reply(350, 'Ready for RNTO');
  }

  private async renameTarget(argument: string): Promise<void> {
    const source = this.renameFrom;
    this.renameFrom = undefined;
    if (!source) {
      this.reply(503, 'Use RNFR first');
      return;
    }
    const target = await this.targetPath(argument);
    const targetParentIdentity = filesystemIdentity(await lstat(dirname(target.file)));
    let targetIdentity: FilesystemIdentity | undefined;
    try {
      const targetStat = await lstat(target.file);
      if (!targetStat.isFile()) throw new Error('Rename target is not a regular file');
      targetIdentity = filesystemIdentity(targetStat);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const currentSource = await realpath(source.file);
    if (currentSource !== source.file || !isInside(this.root, currentSource))
      throw new Error('FTP rename source changed');
    const sourceStat = await lstat(currentSource);
    if (!sameFilesystemIdentity(source.identity, filesystemIdentity(sourceStat)))
      throw new Error('FTP rename source changed');
    if (targetIdentity) {
      if (!sourceStat.isFile()) throw new Error('Cannot replace a file with a directory');
      if (!sameFilesystemIdentity(targetIdentity, filesystemIdentity(await lstat(target.file))))
        throw new Error('FTP rename target changed');
    } else {
      try {
        await lstat(target.file);
        throw new Error('FTP rename target appeared');
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    if (
      !sameFilesystemIdentity(
        targetParentIdentity,
        filesystemIdentity(await lstat(dirname(target.file))),
      )
    )
      throw new Error('FTP rename target parent changed');
    await rename(currentSource, target.file);
    this.reply(250, 'Rename complete');
  }
}

function nvtAsciiEncoder(): Transform {
  let pendingCarriageReturn = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const output = Buffer.allocUnsafe(bytes.length * 2 + 2);
      let length = 0;
      for (const byte of bytes) {
        if (pendingCarriageReturn) {
          output[length++] = 0x0d;
          if (byte === 0x0a) {
            output[length++] = 0x0a;
            pendingCarriageReturn = false;
            continue;
          }
          output[length++] = 0x00;
          pendingCarriageReturn = false;
        }
        if (byte === 0x0d) pendingCarriageReturn = true;
        else if (byte === 0x0a) {
          output[length++] = 0x0d;
          output[length++] = 0x0a;
        } else output[length++] = byte;
      }
      callback(null, output.subarray(0, length));
    },
    flush(callback) {
      callback(null, pendingCarriageReturn ? Buffer.from([0x0d, 0x00]) : undefined);
    },
  });
}

function nvtAsciiDecoder(initialPendingCarriageReturn?: 'network' | 'local'): Transform {
  let pendingCarriageReturn = initialPendingCarriageReturn;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const output = Buffer.allocUnsafe(bytes.length + HOST_EOL.length);
      let length = 0;
      for (const byte of bytes) {
        if (pendingCarriageReturn) {
          if (byte === 0x0a) {
            if (pendingCarriageReturn === 'network') {
              HOST_EOL.copy(output, length);
              length += HOST_EOL.length;
            } else output[length++] = 0x0a;
            pendingCarriageReturn = undefined;
            continue;
          }
          if (pendingCarriageReturn === 'network' && byte === 0x00) {
            output[length++] = 0x0d;
            pendingCarriageReturn = undefined;
            continue;
          }
          if (pendingCarriageReturn === 'network') output[length++] = 0x0d;
          pendingCarriageReturn = undefined;
        }
        if (byte === 0x0d) pendingCarriageReturn = 'network';
        else output[length++] = byte;
      }
      callback(null, output.subarray(0, length));
    },
    flush(callback) {
      callback(null, pendingCarriageReturn === 'network' ? Buffer.from([0x0d]) : undefined);
    },
  });
}

function skipOctets(offset: number): Transform {
  let remaining = offset;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const skipped = Math.min(remaining, bytes.length);
      remaining -= skipped;
      callback(null, skipped === bytes.length ? undefined : bytes.subarray(skipped));
    },
    flush(callback) {
      callback(remaining === 0 ? undefined : new Error('FTP restart offset exceeds transfer size'));
    },
  });
}

async function nvtAsciiTransferSize(file: FileHandle): Promise<number> {
  let size = 0;
  let pendingCarriageReturn = false;
  for await (const bytes of readFileChunks(file)) {
    for (const byte of bytes) {
      if (pendingCarriageReturn) {
        size += 2;
        pendingCarriageReturn = false;
        if (byte === 0x0a) continue;
      }
      if (byte === 0x0d) pendingCarriageReturn = true;
      else size += byte === 0x0a ? 2 : 1;
    }
  }
  if (pendingCarriageReturn) size += 2;
  return size;
}

async function nvtAsciiRestartPosition(
  file: FileHandle,
  transferOffset: number,
): Promise<NvtAsciiRestartPosition | undefined> {
  if (transferOffset === 0) return { localOffset: 0 };
  let size = 0;
  let localOffset = 0;
  let pendingCarriageReturn = false;
  for await (const bytes of readFileChunks(file)) {
    for (const byte of bytes) {
      if (pendingCarriageReturn) {
        if (byte === 0x0a) {
          if (size + 1 === transferOffset) return { localOffset, pendingCarriageReturn: 'local' };
          localOffset += 1;
          size += 2;
          pendingCarriageReturn = false;
          if (size === transferOffset) return { localOffset };
          if (size > transferOffset) return undefined;
          continue;
        }
        if (size + 1 === transferOffset)
          return { localOffset: localOffset - 1, pendingCarriageReturn: 'network' };
        size += 2;
        pendingCarriageReturn = false;
        if (size === transferOffset) return { localOffset };
        if (size > transferOffset) return undefined;
      }
      if (byte === 0x0d) {
        localOffset += 1;
        pendingCarriageReturn = true;
      } else if (byte === 0x0a) {
        if (size + 1 === transferOffset) return { localOffset, pendingCarriageReturn: 'network' };
        localOffset += 1;
        size += 2;
        if (size === transferOffset) return { localOffset };
        if (size > transferOffset) return undefined;
      } else {
        localOffset += 1;
        size += 1;
        if (size === transferOffset) return { localOffset };
        if (size > transferOffset) return undefined;
      }
    }
  }
  if (pendingCarriageReturn) {
    if (size + 1 === transferOffset)
      return { localOffset: localOffset - 1, pendingCarriageReturn: 'network' };
    size += 2;
    if (size === transferOffset) return { localOffset };
  }
  return undefined;
}

async function* readFileChunks(file: FileHandle): AsyncGenerator<Buffer> {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

class PassiveSocket {
  readonly port: number;
  private readonly server: Server;
  private readonly connected: Promise<Socket>;
  private resolveConnection!: (socket: Socket) => void;
  private rejectConnection!: (error: Error) => void;
  private socket: Socket | undefined;
  private timer: NodeJS.Timeout;
  private closed = false;

  private constructor(server: Server, port: number, peerAddress: string) {
    this.server = server;
    this.port = port;
    this.connected = new Promise<Socket>((resolveConnection, rejectConnection) => {
      this.resolveConnection = resolveConnection;
      this.rejectConnection = rejectConnection;
    });
    void this.connected.catch(() => undefined);
    server.on('connection', (socket) => {
      if (this.closed || this.socket || !sameAddress(peerAddress, socket.remoteAddress ?? '')) {
        socket.destroy();
        return;
      }
      this.socket = socket;
      socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
      socket.on('error', () => undefined);
      server.close();
      this.resolveConnection(socket);
    });
    this.timer = setTimeout(() => this.close(), DATA_TIMEOUT_MS);
  }

  static async open(host: string, peerAddress: string, start: number, end: number) {
    for (let port = start; port <= end; port += 1) {
      const server = createServer({ pauseOnConnect: false });
      try {
        await listen(server, port, host);
        return new PassiveSocket(server, port, peerAddress);
      } catch (error) {
        server.close();
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE')
          throw error;
      }
    }
    throw new Error('No FTP passive port available');
  }

  async take(): Promise<Socket> {
    try {
      return await this.connected;
    } finally {
      clearTimeout(this.timer);
      this.server.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
    this.server.close();
    this.rejectConnection(new Error('Passive data connection closed'));
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolveListen, rejectListen) => {
    const fail = (error: Error) => rejectListen(error);
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      resolveListen();
    });
  });
}

function listEntry(name: string, entry: Stats): string {
  const mode = entry.isDirectory() ? 'drwxr-xr-x' : '-rw-r--r--';
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][entry.mtime.getUTCMonth()];
  const timestamp = `${month} ${String(entry.mtime.getUTCDate()).padStart(2, ' ')} ${entry.mtime.getUTCFullYear()}`;
  return `${mode} 1 owner group ${entry.size} ${timestamp} ${name}\r\n`;
}

function mlsdEntry(name: string, entry: Stats): string {
  return `type=${entry.isDirectory() ? 'dir' : 'file'};size=${entry.size};modify=${utcTimestamp(entry.mtime)}; ${name}\r\n`;
}

function utcTimestamp(value: Date): string {
  return value.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function noFollowFlag(): number {
  return constants.O_NOFOLLOW ?? 0;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isInternalStagingFile(name: string): boolean {
  return INTERNAL_STAGING_FILE.test(name);
}

function filesystemIdentity(entry: Stats): FilesystemIdentity {
  return { dev: entry.dev, ino: entry.ino };
}

function sameFilesystemIdentity(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ipv4Address(address: string): string | undefined {
  const value = address.startsWith('::ffff:') ? address.slice(7) : address;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) ? value : undefined;
}

function sameAddress(left: string, right: string): boolean {
  return (ipv4Address(left) ?? left) === (ipv4Address(right) ?? right);
}

function parsePort(argument: string): { host: string; port: number } | undefined {
  const parts = argument.split(',').map(Number);
  if (parts.length !== 6 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return undefined;
  const port = parts[4]! * 256 + parts[5]!;
  return port > 0 ? { host: parts.slice(0, 4).join('.'), port } : undefined;
}

function parseEprt(argument: string): { host: string; port: number } | undefined {
  const delimiter = argument[0];
  if (!delimiter || /[\r\n\0]/.test(delimiter)) return undefined;
  const parts = argument.split(delimiter);
  if (parts.length !== 5 || parts[0] !== '' || parts[4] !== '') return undefined;
  const addressFamily = parts[1];
  const host = parts[2];
  const port = Number(parts[3]);
  if (
    (addressFamily !== '1' && addressFamily !== '2') ||
    !host ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    (addressFamily === '1' && !ipv4Address(host))
  )
    return undefined;
  return { host, port };
}

function connectActive(
  host: string,
  port: number,
  onSocket: (socket: Socket) => void,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise<Socket>((resolveConnect, rejectConnect) => {
    const socket = createConnection({ host, port });
    onSocket(socket);
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('FTP data timeout')));
    socket.once('connect', () => {
      socket.off('error', rejectConnect);
      socket.on('error', () => undefined);
      resolveConnect(socket);
    });
    socket.once('error', rejectConnect);
  });
}

function printableHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
