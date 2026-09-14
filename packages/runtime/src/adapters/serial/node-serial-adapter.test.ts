import { EventEmitter } from 'node:events';
import { SerialPortMock } from 'serialport';
import { describe, expect, it, vi } from 'vitest';
import type { SerialOpenInput } from '../../ports/serial-transport';
import { NodeSerialAdapter } from './node-serial-adapter';

class MockSerialPort extends EventEmitter {
  isOpen = false;
  writable = true;
  readonly writes: Buffer[] = [];
  readonly pause = vi.fn(() => this);
  readonly resume = vi.fn(() => this);

  open(callback: (error?: Error | null) => void): void {
    this.isOpen = true;
    callback();
  }

  write(data: Uint8Array, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(Buffer.from(data));
    callback?.();
    return true;
  }

  drain(callback: (error?: Error | null) => void): void {
    callback();
  }

  close(callback: (error?: Error | null) => void): void {
    this.isOpen = false;
    callback();
    this.emit('close');
  }

  emitData(data: Buffer): void {
    this.emit('data', data);
  }
}

const inputFixture = (): SerialOpenInput => ({
  path: '/dev/mock-serial',
  baudRate: 115_200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  lock: true,
  rtscts: true,
  xon: false,
  xoff: false,
  xany: false,
  txLineEnding: '\n',
  rxLineEnding: 'cr_to_crlf',
  closeSequence: '\\x01ky',
  closeSequenceDelayMs: 0,
});

describe('NodeSerialAdapter', () => {
  it('exchanges bytes through the maintained SerialPort mock binding', async () => {
    SerialPortMock.binding.reset();
    SerialPortMock.binding.createPort('/dev/AXTERM-MOCK', {
      echo: true,
      record: true,
      manufacturer: 'Axterm',
    });
    const adapter = new NodeSerialAdapter(
      (input) =>
        new SerialPortMock({
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
      () => SerialPortMock.list(),
    );
    try {
      expect(await adapter.list()).toMatchObject([
        { path: '/dev/AXTERM-MOCK', manufacturer: 'Axterm' },
      ]);
      const channel = await adapter.open({
        ...inputFixture(),
        path: '/dev/AXTERM-MOCK',
        txLineEnding: '\r\n',
        rxLineEnding: 'none',
        closeSequence: '',
      });
      const received: Buffer[] = [];
      channel.onData((data) => received.push(Buffer.from(data)));
      channel.write(Buffer.from('status\n'));
      await waitFor(() => Buffer.concat(received).toString() === 'status\r\n');
      await channel.close();
    } finally {
      SerialPortMock.binding.reset();
    }
  });

  it('lists bounded device metadata', async () => {
    const adapter = new NodeSerialAdapter(
      () => new MockSerialPort(),
      async () => [
        {
          path: '/dev/tty.usbserial-1',
          manufacturer: 'Axterm fixture',
          serialNumber: 'fixture-01',
          vendorId: '1234',
          productId: '5678',
        },
      ],
    );
    await expect(adapter.list()).resolves.toEqual([
      {
        path: '/dev/tty.usbserial-1',
        manufacturer: 'Axterm fixture',
        serialNumber: 'fixture-01',
        vendorId: '1234',
        productId: '5678',
      },
    ]);
  });

  it('opens with line settings, transforms stream boundaries and closes gracefully', async () => {
    const port = new MockSerialPort();
    let opened: SerialOpenInput | undefined;
    const channel = await new NodeSerialAdapter((input) => {
      opened = input;
      return port;
    }).open(inputFixture());
    expect(opened).toMatchObject({
      path: '/dev/mock-serial',
      baudRate: 115_200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: true,
    });

    const received: Buffer[] = [];
    const exited = vi.fn();
    channel.onData((data) => received.push(Buffer.from(data)));
    channel.onExit(exited);
    port.emitData(Buffer.from('one\r'));
    port.emitData(Buffer.from('\ntwo\r'));
    channel.write(Buffer.from('first\r\nsecond\r'));
    expect(port.writes[0]?.toString()).toBe('first\nsecond\n');

    channel.pause();
    channel.resume();
    expect(port.pause).toHaveBeenCalledOnce();
    expect(port.resume).toHaveBeenCalledOnce();
    await channel.close();
    expect(Buffer.concat(received).toString()).toBe('one\r\ntwo\r\n');
    expect(port.writes.at(-1)).toEqual(Buffer.from([1, 107, 121]));
    expect(exited).toHaveBeenCalledOnce();
    expect(port.listenerCount('data')).toBe(0);
    expect(port.listenerCount('error')).toBe(0);
    expect(port.listenerCount('close')).toBe(0);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for SerialPort mock binding');
}
