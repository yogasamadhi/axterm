import { SerialPort } from 'serialport';
import type { SerialPortInfo } from '@workspace/contracts';
import type { TerminalChannel } from '../../ports/terminal-channel';
import type { SerialOpenInput, SerialTransport } from '../../ports/serial-transport';

interface SerialPortLike {
  readonly isOpen: boolean;
  readonly writable: boolean;
  open(callback: (error?: Error | null) => void): void;
  write(data: Uint8Array, callback?: (error?: Error | null) => void): boolean;
  drain(callback: (error?: Error | null) => void): void;
  close(callback: (error?: Error | null) => void): void;
  on(event: 'data', listener: (data: Buffer) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: () => void): this;
  off(event: 'data', listener: (data: Buffer) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'close', listener: () => void): this;
  pause(): this;
  resume(): this;
}

type SerialPortFactory = (input: SerialOpenInput) => SerialPortLike;
type SerialPortLister = () => ReturnType<typeof SerialPort.list>;
const MAX_SERIAL_PORTS = 256;

export class NodeSerialAdapter implements SerialTransport {
  constructor(
    private readonly createPort: SerialPortFactory = (input) =>
      new SerialPort({
        path: input.path,
        baudRate: input.baudRate,
        dataBits: input.dataBits,
        stopBits: input.stopBits,
        parity: input.parity,
        lock: input.lock,
        rtscts: input.rtscts,
        xon: input.xon,
        xoff: input.xoff,
        xany: input.xany,
        autoOpen: false,
      }),
    private readonly listPorts: SerialPortLister = () => SerialPort.list(),
  ) {}

  async list(): Promise<SerialPortInfo[]> {
    const ports = await this.listPorts();
    return ports.slice(0, MAX_SERIAL_PORTS).map((port) => ({
      path: bounded(port.path, 1_024),
      ...(port.manufacturer ? { manufacturer: bounded(port.manufacturer, 512) } : {}),
      ...(port.serialNumber ? { serialNumber: bounded(port.serialNumber, 512) } : {}),
      ...(port.pnpId ? { pnpId: bounded(port.pnpId, 1_024) } : {}),
      ...(port.locationId ? { locationId: bounded(port.locationId, 512) } : {}),
      ...(port.vendorId ? { vendorId: bounded(port.vendorId, 64) } : {}),
      ...(port.productId ? { productId: bounded(port.productId, 64) } : {}),
    }));
  }

  async open(input: SerialOpenInput): Promise<TerminalChannel> {
    input.signal?.throwIfAborted();
    const port = this.createPort(input);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const abort = () => {
          if (settled) return;
          settled = true;
          if (port.isOpen) port.close(() => {});
          reject(new Error('Serial port open canceled'));
        };
        input.signal?.addEventListener('abort', abort, { once: true });
        port.open((error) => {
          input.signal?.removeEventListener('abort', abort);
          if (settled) {
            if (port.isOpen) port.close(() => {});
            return;
          }
          settled = true;
          if (error) reject(error);
          else resolve();
        });
      });
      return new SerialChannel(port, input);
    } catch (error) {
      if (port.isOpen) await closePort(port).catch(() => {});
      throw error;
    }
  }
}

class SerialChannel implements TerminalChannel {
  readonly shellIntegrationKind = 'unsupported' as const;
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(exitCode: number | null) => void>();
  private pendingRxCr = false;
  private exited = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly port: SerialPortLike,
    private readonly options: SerialOpenInput,
  ) {
    port.on('data', this.receive);
    port.on('error', this.fail);
    port.once('close', this.exit);
  }

  write(data: Uint8Array): void {
    if (!this.port.isOpen || !this.port.writable) return;
    this.port.write(transformTransmit(Buffer.from(data), this.options.txLineEnding));
  }

  resize(): void {}

  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void {
    if (signal === 'SIGINT' && this.port.isOpen) this.port.write(Uint8Array.of(3));
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
    this.port.pause();
  }

  resume(): void {
    this.port.resume();
  }

  close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private readonly receive = (data: Buffer) => {
    const transformed = this.transformReceive(data);
    if (!transformed.length) return;
    for (const listener of this.dataListeners) listener(transformed);
  };

  private transformReceive(data: Buffer): Buffer {
    if (this.options.rxLineEnding === 'none') return data;
    const output: number[] = [];
    for (const byte of data) {
      if (this.options.rxLineEnding === 'lf_to_crlf') {
        if (byte === 10 && !this.pendingRxCr) output.push(13);
        output.push(byte);
        this.pendingRxCr = byte === 13;
        continue;
      }
      if (this.pendingRxCr) {
        output.push(13, 10);
        this.pendingRxCr = false;
        if (byte === 10) continue;
      }
      if (byte === 13) this.pendingRxCr = true;
      else output.push(byte);
    }
    return Buffer.from(output);
  }

  private async closeOnce(): Promise<void> {
    if (!this.port.isOpen) {
      this.exit();
      return;
    }
    const sequence = expandCloseSequence(this.options.closeSequence);
    if (sequence.length) {
      await writeAndDrain(this.port, sequence).catch(() => {});
      if (this.options.closeSequenceDelayMs)
        await new Promise((resolve) => setTimeout(resolve, this.options.closeSequenceDelayMs));
    }
    if (this.port.isOpen) await closePort(this.port).catch(() => {});
    this.exit();
  }

  private readonly fail = () => {
    if (this.port.isOpen) this.port.close(() => {});
    this.exit();
  };

  private readonly exit = () => {
    if (this.exited) return;
    if (this.pendingRxCr && this.options.rxLineEnding === 'cr_to_crlf') {
      this.pendingRxCr = false;
      const ending = Buffer.from('\r\n');
      for (const listener of this.dataListeners) listener(ending);
    }
    this.exited = true;
    this.port.off('data', this.receive);
    this.port.off('error', this.fail);
    this.port.off('close', this.exit);
    for (const listener of this.exitListeners) listener(null);
    this.dataListeners.clear();
    this.exitListeners.clear();
  };
}

function transformTransmit(input: Buffer, ending: '\r' | '\n' | '\r\n'): Buffer {
  const output: number[] = [];
  const replacement = Buffer.from(ending, 'ascii');
  for (let index = 0; index < input.length; index += 1) {
    const byte = input[index]!;
    if (byte === 13 || byte === 10) {
      if (byte === 13 && input[index + 1] === 10) index += 1;
      output.push(...replacement);
    } else output.push(byte);
  }
  return Buffer.from(output);
}

function expandCloseSequence(value: string): Buffer {
  const output: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char !== '\\') {
      output.push(...Buffer.from(char));
      continue;
    }
    const next = value[index + 1];
    if (next === 'n' || next === 'r' || next === 't' || next === '\\') {
      output.push(next === 'n' ? 10 : next === 'r' ? 13 : next === 't' ? 9 : 92);
      index += 1;
      continue;
    }
    if (next === 'x' && /^[0-9a-f]{2}$/i.test(value.slice(index + 2, index + 4))) {
      output.push(Number.parseInt(value.slice(index + 2, index + 4), 16));
      index += 3;
      continue;
    }
    output.push(92);
  }
  return Buffer.from(output);
}

function writeAndDrain(port: SerialPortLike, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    port.write(data, (writeError) => {
      if (writeError) {
        reject(writeError);
        return;
      }
      port.drain((drainError) => (drainError ? reject(drainError) : resolve()));
    });
  });
}

function closePort(port: SerialPortLike): Promise<void> {
  return new Promise((resolve, reject) => {
    port.close((error) => (error ? reject(error) : resolve()));
  });
}

function bounded(value: string, maximum: number): string {
  return value.slice(0, maximum);
}
