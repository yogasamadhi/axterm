import { describe, expect, it, vi } from 'vitest';
import { ElectermTerminalTransferAdapter } from './electerm-terminal-transfer-adapter';
import type { TerminalTransferAdapterEvent } from '../../ports/terminal-transfer';

describe('ElectermTerminalTransferAdapter', () => {
  it('reduces vendor events to path-free metadata before publishing them', () => {
    const manager = {
      handleData: vi.fn(() => false),
      handleMessage: vi.fn(
        (
          _id: string,
          _message: Record<string, unknown>,
          _terminal: unknown,
          socket: { s(message: unknown): void },
        ) => {
          socket.s({
            action: 'xmodem-event',
            event: 'progress',
            name: 'C:\\Users\\private\\report.txt',
            path: 'C:\\Users\\private\\report.txt',
            transferred: 128,
          });
        },
      ),
      destroySession: vi.fn(),
      isActive: vi.fn(() => false),
    };
    const adapter = new ElectermTerminalTransferAdapter({ xmodem: manager });
    const events: TerminalTransferAdapterEvent[] = [];
    adapter.setListener({
      writeRaw: vi.fn(),
      publishRawOutput: vi.fn(),
      onEvent(_terminalId, _protocol, event) {
        events.push(event);
      },
    });

    adapter.command('terminal', 'xmodem', { event: 'upload', path: '/host/private/file' });

    expect(events).toEqual([
      {
        event: 'progress',
        name: 'report.txt',
        transferred: 128,
      },
    ]);
    expect(Object.keys(events[0] ?? {})).not.toContain('path');
  });

  it('detects chunked ZMODEM and TRZSZ headers and restores ordinary output after cancel', () => {
    const adapter = new ElectermTerminalTransferAdapter();
    const events: Array<{ protocol: string; event: TerminalTransferAdapterEvent }> = [];
    const writeRaw = vi.fn();
    const publishRawOutput = vi.fn();
    adapter.setListener({
      writeRaw,
      publishRawOutput,
      onEvent(_terminalId, protocol, event) {
        events.push({ protocol, event });
      },
    });

    expect(adapter.receive('z', Buffer.from([0x2a, 0x2a, 0x18]))).toBe(false);
    expect(adapter.receive('z', Buffer.from([0x42, 0x30, 0x30]))).toBe(true);
    expect(events).toContainEqual({
      protocol: 'zmodem',
      event: expect.objectContaining({ event: 'receive-start' }),
    });
    adapter.command('z', 'zmodem', { event: 'cancel' });

    expect(adapter.receive('trz', Buffer.from('::TRZSZ:TRANSFER:S\r\n'))).toBe(true);
    expect(events).toContainEqual({
      protocol: 'trzsz',
      event: expect.objectContaining({ event: 'receive-start' }),
    });
    adapter.command('trz', 'trzsz', { event: 'cancel' });

    adapter.closeAll();
    expect(events.flatMap(({ event }) => Object.keys(event))).not.toContain('path');
  });
});
