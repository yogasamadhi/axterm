import process from 'node:process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NodePtyAdapter } from '../pty/node-pty-adapter';
import { TrzszSession } from './trzsz';

describe('TRZSZ through a real local PTY', () => {
  it.skipIf(process.platform === 'win32')(
    'downloads binary bytes from an external peer through node-pty',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'axterm-trzsz-pty-'));
      const source = join(root, 'source.bin');
      const destination = join(root, 'destination');
      const bytes = Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.alloc(12_345, 0xa5)]);
      await writeFile(source, bytes);
      await mkdir(destination);
      const channel = new NodePtyAdapter().open({
        shell: process.execPath,
        args: [
          resolve('packages/runtime/src/adapters/terminal-transfer/fixtures/trzsz-peer.mjs'),
          source,
        ],
        cwd: root,
        env: {},
        term: 'xterm-256color',
        loginShell: false,
        cols: 80,
        rows: 24,
      });
      const events: Array<Record<string, unknown>> = [];
      const ordinaryOutput: Buffer[] = [];
      const writtenToPeer: Buffer[] = [];
      const receivedFromPeer: Buffer[] = [];
      const session = new TrzszSession(
        {
          write: (data) => {
            writtenToPeer.push(Buffer.from(data));
            channel.write(data);
          },
        },
        {
          s: (message) => {
            events.push(message);
            if (message.event === 'receive-start')
              session.handleMessage({ event: 'set-save-path', path: destination });
          },
        },
      );
      const removeData = channel.onData((data) => {
        receivedFromPeer.push(Buffer.from(data));
        if (!session.handleData(data)) ordinaryOutput.push(Buffer.from(data));
      });
      const exited = new Promise<number | null>((resolveExit) => channel.onExit(resolveExit));
      try {
        await vi.waitFor(() =>
          expect(Buffer.concat(ordinaryOutput).toString('utf8')).toContain(
            'AXTERM_PEER_READY_SEND',
          ),
        );
        channel.write(Buffer.from('!'));
        const exitCode = await Promise.race([
          exited,
          new Promise<never>((_, reject) =>
            setTimeout(
              async () =>
                reject(
                  new Error(
                    `PTY TRZSZ transfer timed out: ${JSON.stringify(events)} ${Buffer.concat(ordinaryOutput).toString('utf8')} sent=${Buffer.concat(writtenToPeer).toString('utf8')} received=${Buffer.concat(receivedFromPeer).toString('utf8')}`,
                  ),
                ),
              12_000,
            ),
          ),
        ]);
        expect(exitCode, Buffer.concat(ordinaryOutput).toString('utf8')).toBe(0);
        expect(await readFile(join(destination, 'source.bin'))).toEqual(bytes);
        expect(await readdir(destination)).toEqual(['source.bin']);
        expect(events).toContainEqual(
          expect.objectContaining({ event: 'file-complete', size: bytes.length }),
        );
        expect(events.map((event) => event.event)).toContain('session-complete');
      } finally {
        removeData();
        session.destroy();
        await channel.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it.skipIf(process.platform === 'win32')(
    'uploads binary bytes and exits the peer',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'axterm-trzsz-upload-pty-'));
      const source = join(root, 'source.bin');
      const target = join(root, 'received.bin');
      const bytes = Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.alloc(12_345, 0xa5)]);
      await writeFile(source, bytes);
      const channel = new NodePtyAdapter().open({
        shell: process.execPath,
        args: [
          resolve('packages/runtime/src/adapters/terminal-transfer/fixtures/trzsz-peer.mjs'),
          target,
          'receive',
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
      const session = new TrzszSession(
        { write: (data) => channel.write(data) },
        {
          s: (message) => {
            events.push(String(message.event));
            if (message.event === 'send-start')
              session.handleMessage({ event: 'send-files', files: [{ path: source }] });
          },
        },
      );
      const removeData = channel.onData((data) => {
        if (!session.handleData(data)) ordinaryOutput.push(Buffer.from(data));
      });
      const exited = new Promise<number | null>((resolveExit) => channel.onExit(resolveExit));
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await vi.waitFor(() =>
          expect(Buffer.concat(ordinaryOutput).toString('utf8')).toContain(
            'AXTERM_PEER_READY_RECEIVE',
          ),
        );
        channel.write(Buffer.from('!'));
        const exitCode = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error(`TRZSZ upload peer timed out: ${events.join(',')}`)),
              12_000,
            );
          }),
        ]);
        expect(exitCode, events.join(',')).toBe(0);
        expect(await readFile(target)).toEqual(bytes);
        expect(events).toContain('session-complete');
      } finally {
        if (deadline) clearTimeout(deadline);
        removeData();
        session.destroy();
        await channel.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
