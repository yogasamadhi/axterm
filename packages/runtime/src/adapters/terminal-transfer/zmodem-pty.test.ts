import process from 'node:process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NodePtyAdapter } from '../pty/node-pty-adapter';
import { ZmodemSession } from './zmodem';

async function realPtyTransfer(direction: 'send' | 'receive') {
  const root = await mkdtemp(join(tmpdir(), `axterm-zmodem-${direction}-`));
  const source = join(root, 'source.bin');
  const target = join(root, 'received.bin');
  const downloadDirectory = join(root, 'downloads');
  const bytes = Buffer.concat([Buffer.from([0, 255, 1, 13, 10]), Buffer.alloc(16_384, 0xa5)]);
  await writeFile(source, bytes);
  await mkdir(downloadDirectory);
  const channel = new NodePtyAdapter().open({
    shell: process.execPath,
    args: [
      resolve('packages/runtime/src/adapters/terminal-transfer/fixtures/zmodem-peer.mjs'),
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
  const session = new ZmodemSession(
    { write: (data) => channel.write(data) },
    {
      s: (message) => {
        events.push(String(message.event));
        if (message.event === 'receive-start')
          session.handleMessage({ event: 'set-save-path', path: downloadDirectory });
        if (message.event === 'send-start')
          session.handleMessage({ event: 'send-files', files: [{ path: source }] });
      },
      send: (data) => ordinaryOutput.push(Buffer.from(data)),
    },
  );
  const disposeData = channel.onData((data) => {
    if (!session.handleData(data)) ordinaryOutput.push(Buffer.from(data));
  });
  const exited = new Promise<number | null>((resolveExit) => channel.onExit(resolveExit));
  try {
    await vi.waitFor(() =>
      expect(Buffer.concat(ordinaryOutput).toString('utf8')).toContain(
        `AXTERM_ZMODEM_READY_${direction.toUpperCase()}`,
      ),
    );
    channel.write(Buffer.from('!'));
    const exitCode = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`ZMODEM PTY timed out: ${events.join(',')}`)), 12_000),
      ),
    ]);
    expect(exitCode, events.join(',')).toBe(0);
    expect(events).toContain('session-complete');
    expect(session.isActive()).toBe(false);
    expect(
      await readFile(direction === 'send' ? join(downloadDirectory, 'source.bin') : target),
    ).toEqual(bytes);
  } finally {
    disposeData();
    session.destroy();
    await channel.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('independent ZMODEM adapter through a real local PTY', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps the fixture idle until the explicit start byte after unrelated PTY input',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'axterm-zmodem-start-'));
      const source = join(root, 'source.bin');
      await writeFile(source, Buffer.from([0xa5]));
      const channel = new NodePtyAdapter().open({
        shell: process.execPath,
        args: [
          resolve('packages/runtime/src/adapters/terminal-transfer/fixtures/zmodem-peer.mjs'),
          source,
          'send',
        ],
        cwd: root,
        env: {},
        term: 'xterm-256color',
        loginShell: false,
        cols: 80,
        rows: 24,
      });
      const output: Buffer[] = [];
      const disposeData = channel.onData((data) => output.push(Buffer.from(data)));
      const startFrame = Buffer.from('**\x18B');
      try {
        await vi.waitFor(() =>
          expect(Buffer.concat(output).toString('utf8')).toContain('AXTERM_ZMODEM_READY_SEND'),
        );
        channel.write(Buffer.from('x'));
        await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
        expect(Buffer.concat(output).includes(startFrame)).toBe(false);
        channel.write(Buffer.from('!'));
        await vi.waitFor(() => expect(Buffer.concat(output).includes(startFrame)).toBe(true));
      } finally {
        disposeData();
        await channel.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')('downloads binary bytes', async () => {
    await realPtyTransfer('send');
  });

  it.skipIf(process.platform === 'win32')('uploads binary bytes', async () => {
    await realPtyTransfer('receive');
  });
});
