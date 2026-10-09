import process from 'node:process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NodePtyAdapter } from '../pty/node-pty-adapter';
import { XmodemSession } from './xmodem';

async function realPtyTransfer(direction: 'send' | 'receive') {
  const root = await mkdtemp(join(tmpdir(), `axterm-xmodem-${direction}-`));
  const source = join(root, 'source.bin');
  const target = join(root, 'received.bin');
  const downloadDirectory = join(root, 'downloads');
  const bytes = Buffer.concat([Buffer.from([0, 255, 1, 13, 10]), Buffer.alloc(16_379, 0xa5)]);
  await writeFile(source, bytes);
  await mkdir(downloadDirectory);
  const channel = new NodePtyAdapter().open({
    shell: process.execPath,
    args: [
      resolve('packages/runtime/src/adapters/terminal-transfer/fixtures/xmodem-peer.mjs'),
      direction === 'send' ? source : target,
      direction,
    ],
    cwd: root,
    env: {},
    term: 'xterm-256color',
    loginShell: false,
    cols: 80,
    rows: 24,
  });
  const events: string[] = [];
  const ordinaryOutput: Buffer[] = [];
  const session = new XmodemSession(
    { write: (data) => channel.write(data) },
    { s: (message) => events.push(String(message.event)) },
  );
  const disposeData = channel.onData((data) => {
    if (!session.handleData(data)) ordinaryOutput.push(Buffer.from(data));
  });
  const exited = new Promise<number | null>((resolveExit) => channel.onExit(resolveExit));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await vi.waitFor(() =>
      expect(Buffer.concat(ordinaryOutput).toString('utf8')).toContain(
        `AXTERM_XMODEM_READY_${direction.toUpperCase()}`,
      ),
    );
    if (direction === 'send') {
      channel.write(Buffer.from('!'));
      session.startReceive();
      session.setSavePath(downloadDirectory, 'download.bin');
    } else {
      session.startSend();
      session.setSendFiles([{ path: source, name: 'source.bin', size: bytes.length }]);
      channel.write(Buffer.from('!'));
    }
    const exitCode = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`XMODEM PTY timed out: ${events.join(',')}`)),
          12_000,
        );
      }),
    ]);
    expect(exitCode, events.join(',')).toBe(0);
    expect(events).toContain('file-complete');
    expect(session.isActive()).toBe(false);
    expect(
      await readFile(direction === 'send' ? join(downloadDirectory, 'download.bin') : target),
    ).toEqual(bytes);
  } finally {
    if (deadline) clearTimeout(deadline);
    disposeData();
    session.destroy();
    await channel.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('independent XMODEM adapter through a real local PTY', () => {
  it.skipIf(process.platform === 'win32')('downloads binary bytes', async () => {
    await realPtyTransfer('send');
  });

  it.skipIf(process.platform === 'win32')('uploads binary bytes', async () => {
    await realPtyTransfer('receive');
  });
});
