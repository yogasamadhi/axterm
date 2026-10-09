import process from 'node:process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openSshPtyFixture, type SshPtyFixture } from './fixtures/ssh-pty-fixture';
import { TrzszSession } from './trzsz';
import { ZmodemSession } from './zmodem';

type Protocol = 'zmodem' | 'trzsz';
type Direction = 'send' | 'receive';

async function remoteTransfer(protocol: Protocol, direction: Direction) {
  const root = await mkdtemp(join(tmpdir(), `axterm-${protocol}-ssh-${direction}-`));
  const source = join(root, 'source.bin');
  const target = join(root, 'received.bin');
  const downloadDirectory = join(root, 'downloads');
  const bytes = Buffer.concat([Buffer.from([0, 255, 1, 13, 10]), Buffer.alloc(16_384, 0xa5)]);
  await writeFile(source, bytes);
  await mkdir(downloadDirectory);
  let fixture: SshPtyFixture | undefined;
  let session: ZmodemSession | TrzszSession | undefined;
  let disposeData: (() => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    fixture = await openSshPtyFixture({
      root,
      fixture: resolve(
        `packages/runtime/src/adapters/terminal-transfer/fixtures/${protocol}-peer.mjs`,
      ),
      file: direction === 'send' ? source : target,
      direction,
    });
    const channel = fixture.channel;
    const events: string[] = [];
    const ordinaryOutput: Buffer[] = [];
    const terminal = { write: (data: Uint8Array) => channel.write(data) };
    const socket = {
      s: (message: Record<string, unknown>) => {
        events.push(String(message.event));
        if (message.event === 'receive-start')
          session?.handleMessage({ event: 'set-save-path', path: downloadDirectory });
        if (message.event === 'send-start')
          session?.handleMessage({ event: 'send-files', files: [{ path: source }] });
      },
      send: (data: Uint8Array) => ordinaryOutput.push(Buffer.from(data)),
    };
    session =
      protocol === 'zmodem'
        ? new ZmodemSession(terminal, socket)
        : new TrzszSession(terminal, socket);
    const transfer = session;
    disposeData = channel.onData((data) => {
      if (!transfer.handleData(data)) ordinaryOutput.push(Buffer.from(data));
    });
    const exited = new Promise<number | null>((resolveExit) => channel.onExit(resolveExit));
    const marker =
      protocol === 'zmodem'
        ? `AXTERM_ZMODEM_READY_${direction.toUpperCase()}`
        : `AXTERM_PEER_READY_${direction.toUpperCase()}`;
    await vi.waitFor(() =>
      expect(Buffer.concat(ordinaryOutput).toString('utf8')).toContain(marker),
    );
    channel.write(Buffer.from('!'));
    const exitCode = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`${protocol} SSH timed out: ${events.join(',')}`)),
          12_000,
        );
      }),
    ]);
    expect(exitCode, events.join(',')).toBe(0);
    await vi.waitFor(() => expect(events).toContain('session-complete'));
    await vi.waitFor(() => expect(transfer.isActive()).toBe(false));
    expect(
      await readFile(direction === 'send' ? join(downloadDirectory, 'source.bin') : target),
    ).toEqual(bytes);
  } finally {
    if (deadline) clearTimeout(deadline);
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('independent ZMODEM and TRZSZ through real SSH PTY channels', () => {
  for (const protocol of ['zmodem', 'trzsz'] as const) {
    it.skipIf(process.platform === 'win32')(
      `${protocol} downloads binary bytes`,
      async () => {
        await remoteTransfer(protocol, 'send');
      },
      15_000,
    );

    it.skipIf(process.platform === 'win32')(
      `${protocol} uploads binary bytes`,
      async () => {
        await remoteTransfer(protocol, 'receive');
      },
      15_000,
    );
  }
});
