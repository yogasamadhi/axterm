import process from 'node:process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openSshPtyFixture, type SshPtyFixture } from './fixtures/ssh-pty-fixture';
import { XmodemSession } from './xmodem';

async function remoteSshTransfer(direction: 'send' | 'receive') {
  const root = await mkdtemp(join(tmpdir(), `axterm-xmodem-ssh-${direction}-`));
  const source = join(root, 'source.bin');
  const target = join(root, 'received.bin');
  const downloadDirectory = join(root, 'downloads');
  const bytes = Buffer.concat([Buffer.from([0, 255, 1, 13, 10]), Buffer.alloc(16_379, 0xa5)]);
  await writeFile(source, bytes);
  await mkdir(downloadDirectory);
  let fixture: SshPtyFixture | undefined;
  let session: XmodemSession | undefined;
  let disposeData: (() => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    fixture = await openSshPtyFixture({
      root,
      fixture: resolve('packages/runtime/src/adapters/terminal-transfer/fixtures/xmodem-peer.mjs'),
      file: direction === 'send' ? source : target,
      direction,
    });
    const channel = fixture.channel;
    const terminal = channel;
    const events: string[] = [];
    const ordinaryOutput: Buffer[] = [];
    session = new XmodemSession(
      { write: (data) => terminal.write(data) },
      { s: (message) => events.push(String(message.event)) },
    );
    const transfer = session;
    disposeData = channel.onData((data) => {
      if (!transfer.handleData(data)) ordinaryOutput.push(Buffer.from(data));
    });
    const exited = new Promise<number | null>((resolveExit) => channel.onExit(resolveExit));
    await vi.waitFor(() =>
      expect(Buffer.concat(ordinaryOutput).toString('utf8')).toContain(
        `AXTERM_XMODEM_READY_${direction.toUpperCase()}`,
      ),
    );
    if (direction === 'send') {
      channel.write(Buffer.from('!'));
      transfer.startReceive();
      transfer.setSavePath(downloadDirectory, 'download.bin');
    } else {
      transfer.startSend();
      transfer.setSendFiles([{ path: source, name: 'source.bin', size: bytes.length }]);
      channel.write(Buffer.from('!'));
    }
    const exitCode = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`XMODEM SSH timed out: ${events.join(',')}`)),
          12_000,
        );
      }),
    ]);
    expect(exitCode, events.join(',')).toBe(0);
    expect(events).toContain('file-complete');
    expect(transfer.isActive()).toBe(false);
    expect(
      await readFile(direction === 'send' ? join(downloadDirectory, 'download.bin') : target),
    ).toEqual(bytes);
  } finally {
    if (deadline) clearTimeout(deadline);
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('independent XMODEM through a real SSH PTY channel', () => {
  it.skipIf(process.platform === 'win32')('downloads binary bytes', async () => {
    await remoteSshTransfer('send');
  });

  it.skipIf(process.platform === 'win32')('uploads binary bytes', async () => {
    await remoteSshTransfer('receive');
  });
});
