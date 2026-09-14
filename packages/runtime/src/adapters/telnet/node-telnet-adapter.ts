import { connect, type Socket } from 'node:net';
import iconv from 'iconv-lite';
import type { TerminalChannel } from '../../ports/terminal-channel';
import type { TelnetTransport } from '../../ports/telnet-transport';

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const ECHO = 1;
const SUPPRESS_GO_AHEAD = 3;
const TERMINAL_TYPE = 24;
const NAWS = 31;
const TERMINAL_TYPE_IS = 0;
const TERMINAL_TYPE_SEND = 1;
const MAX_PROMPT_BYTES = 8 * 1024;

export class NodeTelnetAdapter implements TelnetTransport {
  constructor(
    private readonly socketFactory: (options: { host: string; port: number }) => Socket = (
      options,
    ) => connect(options),
  ) {}

  async connect(input: Parameters<TelnetTransport['connect']>[0]): Promise<TerminalChannel> {
    input.signal?.throwIfAborted();
    if (!iconv.encodingExists(input.encoding)) throw new Error('Unsupported Telnet encoding');
    const socket = this.socketFactory({ host: input.host, port: input.port });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    const abort = () => socket.destroy(new Error('Telnet connection canceled'));
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          socket.destroy();
          reject(new Error('Telnet connection timeout'));
        }, input.timeoutMs);
        timer.unref();
        const cleanup = () => {
          clearTimeout(timer);
          socket.off('connect', connected);
          socket.off('error', failed);
        };
        const connected = () => {
          cleanup();
          resolve();
        };
        const failed = (error: Error) => {
          cleanup();
          reject(error);
        };
        socket.once('connect', connected);
        socket.once('error', failed);
      });
      input.signal?.throwIfAborted();
      return new TelnetChannel(socket, input);
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      input.signal?.removeEventListener('abort', abort);
    }
  }
}

class TelnetChannel implements TerminalChannel {
  readonly shellIntegrationKind = 'unsupported' as const;
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(exitCode: number | null) => void>();
  private parseState: 'data' | 'iac' | 'command' | 'suboption' | 'suboption-iac' = 'data';
  private pendingCommand = 0;
  private suboption: number[] = [];
  private promptBytes = Buffer.alloc(0);
  private usernameSent = false;
  private passwordSent = false;
  private exited = false;
  private cols: number;
  private rows: number;

  constructor(
    private readonly socket: Socket,
    private readonly options: Parameters<TelnetTransport['connect']>[0],
  ) {
    this.cols = options.cols;
    this.rows = options.rows;
    socket.on('data', (data) => this.receive(data));
    socket.once('close', () => this.exit());
    socket.once('error', () => this.exit());
  }

  write(data: Uint8Array): void {
    if (!this.socket.writable || this.socket.destroyed) return;
    this.socket.write(escapeIac(data));
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.sendWindowSize();
  }

  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void {
    if (signal === 'SIGINT') this.write(Uint8Array.of(3));
    else void this.close();
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (exitCode: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.destroy();
        resolve();
      }, 250);
      timer.unref();
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.end();
    });
  }

  private receive(input: Buffer): void {
    const output: number[] = [];
    for (const byte of input) {
      if (this.parseState === 'data') {
        if (byte === IAC) this.parseState = 'iac';
        else output.push(byte);
      } else if (this.parseState === 'iac') {
        if (byte === IAC) {
          output.push(IAC);
          this.parseState = 'data';
        } else if ([DO, DONT, WILL, WONT].includes(byte)) {
          this.pendingCommand = byte;
          this.parseState = 'command';
        } else if (byte === SB) {
          this.suboption = [];
          this.parseState = 'suboption';
        } else this.parseState = 'data';
      } else if (this.parseState === 'command') {
        this.negotiate(this.pendingCommand, byte);
        this.parseState = 'data';
      } else if (this.parseState === 'suboption') {
        if (byte === IAC) this.parseState = 'suboption-iac';
        else this.suboption.push(byte);
      } else if (byte === SE) {
        this.handleSuboption(this.suboption);
        this.suboption = [];
        this.parseState = 'data';
      } else {
        this.suboption.push(IAC, byte);
        this.parseState = 'suboption';
      }
    }
    if (!output.length) return;
    const bytes = Buffer.from(output);
    this.handlePrompts(bytes);
    for (const listener of this.dataListeners) listener(bytes);
  }

  private negotiate(command: number, option: number): void {
    if (command === DO) {
      const accepted = option === TERMINAL_TYPE || option === NAWS;
      this.socket.write(Buffer.from([IAC, accepted ? WILL : WONT, option]));
      if (accepted && option === NAWS) this.sendWindowSize();
      return;
    }
    if (command === WILL) {
      const accepted = option === ECHO || option === SUPPRESS_GO_AHEAD;
      this.socket.write(Buffer.from([IAC, accepted ? DO : DONT, option]));
    }
  }

  private handleSuboption(bytes: number[]): void {
    if (bytes[0] !== TERMINAL_TYPE || bytes[1] !== TERMINAL_TYPE_SEND) return;
    this.socket.write(
      Buffer.concat([
        Buffer.from([IAC, SB, TERMINAL_TYPE, TERMINAL_TYPE_IS]),
        Buffer.from('xterm-256color', 'ascii'),
        Buffer.from([IAC, SE]),
      ]),
    );
  }

  private sendWindowSize(): void {
    if (!this.socket.writable) return;
    this.socket.write(
      Buffer.from([
        IAC,
        SB,
        NAWS,
        (this.cols >> 8) & 0xff,
        this.cols & 0xff,
        (this.rows >> 8) & 0xff,
        this.rows & 0xff,
        IAC,
        SE,
      ]),
    );
  }

  private handlePrompts(bytes: Buffer): void {
    this.promptBytes = Buffer.concat([this.promptBytes, bytes]).subarray(-MAX_PROMPT_BYTES);
    const visible = iconv.decode(this.promptBytes, this.options.encoding);
    if (!this.usernameSent && this.options.username && matches(this.options.loginPrompt, visible)) {
      this.usernameSent = true;
      this.writeCredential(this.options.username);
      this.promptBytes = Buffer.alloc(0);
      return;
    }
    if (
      !this.passwordSent &&
      this.options.password !== undefined &&
      matches(this.options.passwordPrompt, visible)
    ) {
      this.passwordSent = true;
      this.writeCredential(this.options.password);
      this.promptBytes = Buffer.alloc(0);
    }
  }

  private writeCredential(value: string): void {
    const bytes = iconv.encode(`${value}\r\n`, this.options.encoding);
    this.socket.write(escapeIac(bytes));
  }

  private exit(): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(null);
    this.dataListeners.clear();
    this.exitListeners.clear();
  }
}

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

function escapeIac(data: Uint8Array): Buffer {
  const bytes: number[] = [];
  for (const byte of data) {
    bytes.push(byte);
    if (byte === IAC) bytes.push(IAC);
  }
  return Buffer.from(bytes);
}
