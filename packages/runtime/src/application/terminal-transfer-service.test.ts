import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalChannel } from '../ports/terminal-channel';
import type {
  TerminalTransferAdapter,
  TerminalTransferAdapterListener,
  TerminalTransferProtocol,
} from '../ports/terminal-transfer';
import { TerminalService, type TerminalSocket } from './terminal-service';
import { TerminalTransferService } from './terminal-transfer-service';

class FakeChannel implements TerminalChannel {
  readonly shellIntegrationKind = 'unsupported' as const;
  writes: Buffer[] = [];
  dataListeners = new Set<(data: Uint8Array) => void>();
  write(data: Uint8Array) {
    this.writes.push(Buffer.from(data));
  }
  resize() {}
  signal() {}
  pause() {}
  resume() {}
  onData(listener: (data: Uint8Array) => void) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  onExit() {
    return () => {};
  }
  async close() {}
  emit(data: Uint8Array) {
    for (const listener of this.dataListeners) listener(data);
  }
}

class FakeSocket extends EventEmitter implements TerminalSocket {
  bufferedAmount = 0;
  readyState = 1;
  sent: Array<Uint8Array | string> = [];
  send(data: Uint8Array | string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

class FakeTransferAdapter implements TerminalTransferAdapter {
  listener?: TerminalTransferAdapterListener;
  consumed = false;
  commands: Array<{
    terminalId: string;
    protocol: TerminalTransferProtocol;
    command: Record<string, unknown>;
  }> = [];
  closedIds: string[] = [];
  setListener(listener: TerminalTransferAdapterListener) {
    this.listener = listener;
  }
  receive() {
    return this.consumed;
  }
  observeInput = vi.fn();
  command(
    terminalId: string,
    protocol: TerminalTransferProtocol,
    command: Record<string, unknown>,
  ) {
    this.commands.push({ terminalId, protocol, command });
  }
  close(terminalId: string) {
    this.closedIds.push(terminalId);
  }
  closeAll() {}
  event(terminalId: string, protocol: TerminalTransferProtocol, event: string) {
    this.listener?.onEvent(terminalId, protocol, { event });
  }
}

describe('TerminalTransferService', () => {
  it('keeps consumed protocol bytes out of terminal replay and publishes path-free state', async () => {
    const channel = new FakeChannel();
    const terminals = new TerminalService({ open: () => channel });
    const adapter = new FakeTransferAdapter();
    const transfers = new TerminalTransferService(terminals, adapter);
    terminals.setDataInterceptor(transfers);
    const terminal = terminals.createLocal({ cols: 80, rows: 24 });
    const socket = new FakeSocket();
    terminals.attach(terminal.id, socket);
    socket.sent = [];

    adapter.consumed = true;
    channel.emit(Buffer.from('/private/path/protocol-frame'));
    adapter.event(terminal.id, 'zmodem', 'receive-start');

    expect(terminals.recentOutput(terminal.id)).toBe('');
    expect(transfers.get(terminal.id)).toMatchObject({
      protocol: 'zmodem',
      direction: 'download',
      state: 'waiting-selection',
      selection: 'directory',
    });
    expect(socket.sent.map(String).join('\n')).not.toContain('/private/path');
    expect(transfers.receive(terminal.id, Buffer.alloc(4 * 1024 * 1024 + 1))).toBe(true);
    expect(transfers.get(terminal.id)).toMatchObject({
      state: 'failed',
      errorCode: 'SELECTION_BUFFER_LIMIT',
    });
    expect(adapter.commands.at(-1)?.command).toEqual({ event: 'cancel' });
    await terminals.closeAll();
    expect(adapter.closedIds).toContain(terminal.id);
  });

  it('starts XMODEM upload and maps progress, completion, cancellation, and exact grants', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-transfer-'));
    try {
      const source = join(directory, '源文件.bin');
      await writeFile(source, Buffer.alloc(257, 7));
      const channel = new FakeChannel();
      const terminals = new TerminalService({ open: () => channel });
      const adapter = new FakeTransferAdapter();
      const transfers = new TerminalTransferService(terminals, adapter);
      terminals.setDataInterceptor(transfers);
      const terminal = terminals.createLocal({ cols: 80, rows: 24 });

      await transfers.perform(
        terminal.id,
        {
          action: 'start',
          protocol: 'xmodem',
          direction: 'upload',
          grantId: 'grant',
        },
        { path: source, name: '源文件.bin', kind: 'file', permissions: ['read'] },
      );
      expect(adapter.commands).toEqual([
        expect.objectContaining({ protocol: 'xmodem', command: { event: 'start-send' } }),
        expect.objectContaining({
          protocol: 'xmodem',
          command: {
            event: 'send-files',
            files: [{ path: source, name: '源文件.bin', size: 257 }],
          },
        }),
      ]);

      adapter.listener?.onEvent(terminal.id, 'xmodem', {
        event: 'file-start',
        name: '源文件.bin',
        size: 257,
      });
      adapter.listener?.onEvent(terminal.id, 'xmodem', {
        event: 'progress',
        transferred: 128,
        size: 257,
        speed: 4096,
      });
      expect(transfers.get(terminal.id)).toMatchObject({
        state: 'transferring',
        transferredBytes: 128,
        totalBytes: 257,
        speedBytesPerSecond: 4096,
      });
      adapter.event(terminal.id, 'xmodem', 'file-complete');
      expect(transfers.get(terminal.id)?.state).toBe('completed');

      await transfers.perform(
        terminal.id,
        {
          action: 'start',
          protocol: 'xmodem',
          direction: 'download',
          grantId: 'directory',
          fileName: 'received.bin',
        },
        { path: directory, name: 'destination', kind: 'directory', permissions: ['write'] },
      );
      const canceled = await transfers.perform(terminal.id, { action: 'cancel' });
      expect(canceled.state).toBe('canceled');
      expect(adapter.commands.at(-1)?.command).toEqual({ event: 'cancel' });
      await terminals.closeAll();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
