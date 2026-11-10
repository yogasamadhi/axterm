import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalChannel } from '../../packages/plugins/terminals/src/ports/terminal-channel.ts';
import type {
  TerminalTransferAdapter,
  TerminalTransferAdapterListener,
  TerminalTransferProtocol,
} from '../../packages/plugins/terminals/src/ports/terminal-transfer.ts';
import {
  TerminalService,
  type TerminalSocket,
} from '../../packages/plugins/terminals/src/application/terminal-service.ts';
import { TerminalTransfers } from '../../packages/plugins/terminals/src/application/terminal-transfer.ts';
import type { TerminalTransferStaging } from '../../packages/plugins/terminals/src/ports/terminal-transfer-staging.ts';

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
  async drain(terminalId: string) {
    this.close(terminalId);
  }
  resourceCount() {
    return 0;
  }
  async closeAll() {}
  event(terminalId: string, protocol: TerminalTransferProtocol, event: string) {
    this.listener?.onEvent(terminalId, protocol, { event });
  }
}

describe('retained terminal protocol interception owner', () => {
  it('waits for adapter-wide cleanup before completing shutdown', async () => {
    const terminals = terminalOwner(new FakeChannel());
    const adapter = new FakeTransferAdapter();
    const transfers = transferOwner(terminals, adapter);
    const terminal = await terminals.createLocal({ cols: 80, rows: 24 });
    adapter.event(terminal.id, 'trzsz', 'receive-start');
    let releaseCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    vi.spyOn(adapter, 'closeAll').mockImplementation(() => cleanup);

    let closed = false;
    const closing = transfers.closeAll().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(transfers.resourceCount()).toBe(1);
    releaseCleanup?.();
    await closing;
    expect(transfers.resourceCount()).toBe(0);
    await terminals.closeAll();
  });

  it('surfaces a path-free unsupported-destination error code for the failed transfer', async () => {
    const terminals = terminalOwner(new FakeChannel());
    const adapter = new FakeTransferAdapter();
    const transfers = transferOwner(terminals, adapter);
    const terminal = await terminals.createLocal({ cols: 80, rows: 24 });
    adapter.event(terminal.id, 'trzsz', 'receive-start');
    adapter.listener?.onEvent(terminal.id, 'trzsz', {
      event: 'session-error',
      errorCode: 'TRANSFER_DESTINATION_UNSUPPORTED',
    });
    await vi.waitFor(() =>
      expect(transfers.get(terminal.id)).toMatchObject({
        state: 'failed',
        errorCode: 'TRANSFER_DESTINATION_UNSUPPORTED',
      }),
    );
    await terminals.closeAll();
  });

  it('keeps consumed protocol bytes out of terminal replay and publishes path-free state', async () => {
    const channel = new FakeChannel();
    const terminals = terminalOwner(channel);
    const adapter = new FakeTransferAdapter();
    const transfers = transferOwner(terminals, adapter);
    terminals.setDataInterceptor(transfers);
    const terminal = await terminals.createLocal({ cols: 80, rows: 24 });
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
    await vi.waitFor(() =>
      expect(transfers.get(terminal.id)).toMatchObject({
        state: 'failed',
        errorCode: 'SELECTION_BUFFER_LIMIT',
      }),
    );
    expect(adapter.closedIds).toContain(terminal.id);
    expect(transfers.resourceCount()).toBe(0);
    await terminals.closeAll();
    expect(adapter.closedIds).toContain(terminal.id);
  });

  it('starts XMODEM upload and maps progress, completion, cancellation, and exact grants', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axterm-transfer-'));
    try {
      const source = join(directory, '源文件.bin');
      await writeFile(source, Buffer.alloc(257, 7));
      const channel = new FakeChannel();
      const terminals = terminalOwner(channel);
      const adapter = new FakeTransferAdapter();
      const prepare = vi.fn<TerminalTransferStaging['prepare']>(
        async (grantId, direction, protocol) => {
          expect(protocol).toBe('xmodem');
          expect([
            ['grant', 'upload'],
            ['directory', 'download'],
          ]).toContainEqual([grantId, direction]);
          const path = grantId === 'grant' ? source : directory;
          const metadata = await stat(path);
          return {
            signal: new AbortController().signal,
            path,
            name: grantId === 'grant' ? '源文件.bin' : 'destination',
            kind: grantId === 'grant' ? 'file' : 'directory',
            ...(metadata.isFile() ? { size: metadata.size } : {}),
            publish: async () => {},
            close: async () => {},
          };
        },
      );
      const transfers = transferOwner(terminals, adapter, {
        prepare,
        resourceCount: () => 0,
        close: async () => {},
      });
      terminals.setDataInterceptor(transfers);
      const terminal = await terminals.createLocal({ cols: 80, rows: 24 });

      await transfers.perform(terminal.id, {
        action: 'start',
        protocol: 'xmodem',
        direction: 'upload',
        grantId: 'grant',
      });
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

      let now = 1000;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      adapter.listener?.onEvent(terminal.id, 'xmodem', {
        event: 'file-start',
        name: '源文件.bin',
        size: 257,
      });
      now += 100;
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
      clock.mockRestore();
      adapter.event(terminal.id, 'xmodem', 'file-complete');
      await vi.waitFor(() => expect(transfers.get(terminal.id)?.state).toBe('completed'));

      await transfers.perform(terminal.id, {
        action: 'start',
        protocol: 'xmodem',
        direction: 'download',
        grantId: 'directory',
        fileName: 'received.bin',
      });
      const canceled = await transfers.perform(terminal.id, { action: 'cancel' });
      expect(canceled.state).toBe('canceled');
      expect(adapter.closedIds).toContain(terminal.id);
      expect(transfers.resourceCount()).toBe(0);
      expect(prepare).toHaveBeenCalledTimes(2);
      await terminals.closeAll();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const owners: { terminals: TerminalService; transfers?: TerminalTransfers }[] = [];
function terminalOwner(channel: TerminalChannel) {
  const terminals = new TerminalService(
    { open: async () => channel },
    {
      open: async () => {
        throw Error('No recording selected');
      },
    },
  );
  owners.push({ terminals });
  return terminals;
}
function transferOwner(
  terminals: TerminalService,
  adapter: TerminalTransferAdapter,
  staging: TerminalTransferStaging = {
    prepare: async () => {
      throw Error('No Files authority selected');
    },
    resourceCount: () => 0,
    close: async () => {},
  },
) {
  const transfers = new TerminalTransfers(terminals, adapter, staging);
  owners.find((owner) => owner.terminals === terminals)!.transfers = transfers;
  return transfers;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owner of owners.splice(0).reverse()) {
    await owner.transfers?.closeAll();
    await owner.terminals.dispose();
  }
});
