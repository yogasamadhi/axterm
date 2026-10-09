import { describe, expect, it, vi } from 'vitest';
import { Sender } from 'zmodem2';
import { RuntimeTerminalTransferAdapter } from './terminal-transfer-adapter';
import type { TerminalTransferAdapterEvent } from '../../ports/terminal-transfer';

describe('RuntimeTerminalTransferAdapter', () => {
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
    const adapter = new RuntimeTerminalTransferAdapter({ xmodem: manager });
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

  it('allows only the fixed destination-filesystem failure code across the adapter boundary', () => {
    const events: TerminalTransferAdapterEvent[] = [];
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
            action: 'trzsz-event',
            event: 'session-error',
            errorCode: 'TRANSFER_DESTINATION_UNSUPPORTED',
            error: '/private/transfer/location',
          });
          socket.s({ action: 'trzsz-event', event: 'session-error', errorCode: '/private/path' });
        },
      ),
      destroySession: vi.fn(),
      isActive: vi.fn(() => false),
    };
    const adapter = new RuntimeTerminalTransferAdapter({ trzsz: manager });
    adapter.setListener({
      writeRaw: vi.fn(),
      publishRawOutput: vi.fn(),
      onEvent(_terminalId, _protocol, event) {
        events.push(event);
      },
    });
    adapter.command('terminal', 'trzsz', { event: 'test' });
    expect(events).toEqual([
      { event: 'session-error', errorCode: 'TRANSFER_DESTINATION_UNSUPPORTED' },
      { event: 'session-error' },
    ]);
  });

  it('detects chunked ZMODEM and TRZSZ headers and restores ordinary output after cancel', async () => {
    const adapter = new RuntimeTerminalTransferAdapter();
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

    const zmodemHeader = new Sender().drainOutgoing();
    expect(adapter.receive('z', zmodemHeader.subarray(0, 7))).toBe(false);
    expect(adapter.receive('z', zmodemHeader.subarray(7))).toBe(true);
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

    await adapter.closeAll();
    expect(events.flatMap(({ event }) => Object.keys(event))).not.toContain('path');
  });

  it('waits for a previously closed session before completing Runtime-wide cleanup', async () => {
    let releaseCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolveCleanup) => {
      releaseCleanup = resolveCleanup;
    });
    const manager = {
      handleData: vi.fn(() => false),
      handleMessage: vi.fn(),
      destroySession: vi.fn(() => cleanup),
      isActive: vi.fn(() => false),
    };
    const adapter = new RuntimeTerminalTransferAdapter({ zmodem: manager });
    adapter.command('terminal', 'zmodem', { event: 'start' });
    adapter.close('terminal');

    let completed = false;
    const closing = adapter.closeAll().then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(manager.destroySession).toHaveBeenCalledTimes(1);

    releaseCleanup?.();
    await closing;
    expect(completed).toBe(true);
  });
});
