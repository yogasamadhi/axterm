import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrzszTransfer, type TrzszFileReader, type TrzszFileWriter } from 'trzsz2';
import { StagedTrzszWriter, TrzszSession, type StagedTrzszWriterFactory } from './trzsz';

const roots: string[] = [];
const realNoReplaceDirectory = process.env.AXTERM_REAL_NO_REPLACE_DIRECTORY;
const partialWriteFailures = [
  { code: 'ENOSPC', condition: 'the destination runs out of space' },
  { code: 'EACCES', condition: 'the destination rejects write permission' },
  { code: 'EIO', condition: 'the filesystem reports an I/O failure' },
] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'axterm-trzsz-protocol-'));
  roots.push(path);
  return path;
}

function pair(
  onEvent?: (event: Record<string, unknown>) => void,
  onTerminalWrite?: (data: Buffer, deliver: () => void) => void,
  createWriter?: StagedTrzszWriterFactory,
) {
  const events: Array<Record<string, unknown>> = [];
  const outgoing: Buffer[] = [];
  const remote = new TrzszTransfer((data) => {
    queueMicrotask(() => session.handleData(Buffer.from(data)));
  });
  const session = new TrzszSession(
    {
      write(data) {
        const bytes = Buffer.from(data);
        outgoing.push(bytes);
        const deliver = () => queueMicrotask(() => remote.addReceivedData(bytes));
        if (onTerminalWrite) onTerminalWrite(bytes, deliver);
        else deliver();
      },
    },
    {
      s(message) {
        events.push(message);
        onEvent?.(message);
      },
    },
    createWriter,
  );
  return { session, remote, events, outgoing };
}

class MemoryReader implements TrzszFileReader {
  private offset = 0;
  constructor(
    private readonly name: string,
    private readonly bytes: Buffer,
  ) {}
  getPathId(): number {
    return 0;
  }
  getRelPath(): string[] {
    return [this.name];
  }
  isDir(): boolean {
    return false;
  }
  getSize(): number {
    return this.bytes.length;
  }
  async readFile(buffer: ArrayBuffer): Promise<Uint8Array> {
    const data = this.bytes.subarray(this.offset, this.offset + buffer.byteLength);
    this.offset += data.length;
    return data;
  }
  closeFile(): void {}
}

class MisreportedSizeReader extends MemoryReader {
  override getSize(): number {
    return 1;
  }
}

class MemoryWriter implements TrzszFileWriter {
  readonly chunks: Buffer[] = [];
  getFileName(): string {
    return 'upload.bin';
  }
  getLocalName(): string {
    return 'upload.bin';
  }
  isDir(): boolean {
    return false;
  }
  async writeFile(data: Uint8Array): Promise<void> {
    this.chunks.push(Buffer.from(data));
  }
  closeFile(): void {}
  async deleteFile(): Promise<string> {
    return '';
  }
}

describe('independent TRZSZ adapter with real protocol peers', () => {
  it.skipIf(!realNoReplaceDirectory)(
    'reports an unsupported destination and cleans staging on a real no-replace-limited volume',
    async () => {
      const directory = await mkdtemp(join(realNoReplaceDirectory!, 'axterm-trzsz-ir03-'));
      roots.push(directory);
      const { session, remote, events } = pair();
      const peer = (async () => {
        await remote.recvAction();
        await remote.sendConfig({}, [], 0, 0);
        await remote.sendFiles(
          [new MemoryReader('unsupported.bin', Buffer.from([0, 1, 2, 255]))],
          null,
        );
      })().catch(() => undefined);
      expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:S:fixture\r\n'))).toBe(true);
      session.handleMessage({ event: 'set-save-path', path: directory });
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            event: 'session-error',
            errorCode: 'TRANSFER_DESTINATION_UNSUPPORTED',
          }),
        ),
      );
      await remote.stopTransferring().catch(() => undefined);
      await peer;
      expect(session.isActive()).toBe(false);
      expect((await readdir(directory)).filter((name) => !name.startsWith('._'))).toEqual([]);
      expect(events.map(({ event }) => event)).not.toContain('file-complete');
    },
  );

  it('downloads a binary file through an actual TRZSZ handshake and publishes only verified bytes', async () => {
    const directory = await root();
    const { session, remote, events } = pair();
    const bytes = Buffer.from([0, 1, 2, 255, 3, 4, 5]);
    const peer = (async () => {
      const action = await remote.recvAction();
      expect(action.confirm).toBe(true);
      await remote.sendConfig({}, [], 0, 0);
      await remote.sendFiles([new MemoryReader('download.bin', bytes)], null);
      expect(await remote.recvExit()).toBe('Success');
    })();

    expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:S:fixture\r\n'))).toBe(true);
    session.handleMessage({ event: 'set-save-path', path: directory });
    await peer;
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ event: 'session-end' })),
    );
    expect(await readFile(join(directory, 'download.bin'))).toEqual(bytes);
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toEqual([]);
    expect(session.isActive()).toBe(false);
    expect(events.map(({ event }) => event)).toContain('session-complete');
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'file-complete', name: 'download.bin', size: bytes.length }),
    );
    expect(events.some((event) => 'path' in event)).toBe(false);
  });

  it('rejects a peer that sends more bytes than its announced file size', async () => {
    const directory = await root();
    const { session, remote, events } = pair();
    const peer = (async () => {
      await remote.recvAction();
      await remote.sendConfig({}, [], 0, 0);
      await remote.sendFiles(
        [new MisreportedSizeReader('oversized.bin', Buffer.from([0, 1, 2, 3]))],
        null,
      );
      await remote.recvExit();
    })().catch(() => undefined);

    expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:S:fixture\r\n'))).toBe(true);
    session.handleMessage({ event: 'set-save-path', path: directory });
    await vi.waitFor(() => expect(events.map(({ event }) => event)).toContain('session-end'));
    await remote.stopTransferring().catch(() => undefined);
    await peer;

    expect(events.map(({ event }) => event)).toContain('session-error');
    expect(events.map(({ event }) => event)).not.toContain('session-complete');
    expect(events.some((event) => 'path' in event)).toBe(false);
    expect(await readdir(directory)).toEqual([]);
    expect(session.isActive()).toBe(false);
  });

  it('cancels an overloaded peer without throwing into the terminal output callback', async () => {
    const { session, events } = pair();
    expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:S:fixture\r\n'))).toBe(true);
    const chunk = Buffer.alloc(32 * 1024 * 1024, 0x41);
    expect(session.handleData(chunk)).toBe(true);
    expect(session.handleData(chunk)).toBe(true);
    expect(() => session.handleData(Buffer.from([0x42]))).not.toThrow();
    await vi.waitFor(() => expect(events.map(({ event }) => event)).toContain('session-end'));
    expect(events.filter(({ event }) => event === 'session-error')).toHaveLength(1);
    expect(events.map(({ event }) => event)).not.toContain('session-complete');
    expect(events.some((event) => 'path' in event)).toBe(false);
    expect(session.isActive()).toBe(false);
  });

  it('confines a remote traversal filename to the selected directory', async () => {
    const directory = await root();
    const destination = join(directory, 'downloads');
    const outside = join(directory, 'outside.bin');
    await mkdir(destination);
    await writeFile(outside, 'existing outside bytes');
    const { session, remote, events } = pair();
    const bytes = Buffer.from([0, 255, 1, 2]);
    const peer = (async () => {
      const action = await remote.recvAction();
      expect(action.confirm).toBe(true);
      await remote.sendConfig({}, [], 0, 0);
      await remote.sendFiles([new MemoryReader('../outside.bin', bytes)], null);
      expect(await remote.recvExit()).toBe('Success');
    })();

    expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:S:fixture\r\n'))).toBe(true);
    session.handleMessage({ event: 'set-save-path', path: destination });
    await peer;
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ event: 'session-end' })),
    );

    expect(await readFile(outside, 'utf8')).toBe('existing outside bytes');
    expect(await readdir(destination)).toEqual(['.._outside.bin']);
    expect(await readFile(join(destination, '.._outside.bin'))).toEqual(bytes);
    expect(events.map(({ event }) => event)).toContain('session-complete');
    expect(events.some((event) => 'path' in event)).toBe(false);
  });

  it('uploads a selected file through an actual TRZSZ handshake', async () => {
    const directory = await root();
    const path = join(directory, 'upload.bin');
    const bytes = Buffer.from([9, 8, 0, 255, 7]);
    await writeFile(path, bytes);
    const { session, remote, events } = pair();
    const received = new MemoryWriter();
    const peer = (async () => {
      const action = await remote.recvAction();
      expect(action.confirm).toBe(true);
      await remote.sendConfig({}, [], 0, 0);
      await remote.recvFiles(null, async () => received, null);
      expect(await remote.recvExit()).toBe('Success');
    })();

    expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:'))).toBe(false);
    expect(session.handleData(Buffer.from('R:fixture\r\n'))).toBe(true);
    session.handleMessage({ event: 'send-files', files: [{ path }] });
    await peer;
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ event: 'session-end' })),
    );
    expect(Buffer.concat(received.chunks)).toEqual(bytes);
    expect(events.map(({ event }) => event)).toContain('session-complete');
    expect(session.isActive()).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a selected upload source replaced by a symbolic link',
    async () => {
      const directory = await root();
      const secret = join(directory, 'secret.bin');
      const selected = join(directory, 'selected.bin');
      await writeFile(secret, 'secret bytes');
      await writeFile(selected, 'selected bytes');
      await unlink(selected);
      await symlink(secret, selected);
      const { session, remote, events } = pair();
      const received = new MemoryWriter();
      const peer = (async () => {
        await remote.recvAction();
        await remote.sendConfig({}, [], 0, 0);
        await remote.recvFiles(null, async () => received, null);
      })().catch(() => undefined);

      expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:R:fixture\r\n'))).toBe(true);
      session.handleMessage({ event: 'send-files', files: [{ path: selected }] });
      await vi.waitFor(() =>
        expect(events.map(({ event }) => event)).toEqual(
          expect.arrayContaining(['session-error', 'session-end']),
        ),
      );
      expect(Buffer.concat(received.chunks)).toHaveLength(0);
      expect(events.map(({ event }) => event)).not.toContain('session-complete');
      expect(session.isActive()).toBe(false);
      await remote.stopTransferring().catch(() => undefined);
      await peer;
    },
  );

  it('reuses a completed terminal session for a second download without revisiting old staging', async () => {
    const directory = await root();
    const events: Array<Record<string, unknown>> = [];
    let activePeer: TrzszTransfer | undefined;
    const session = new TrzszSession(
      {
        write(data) {
          const peer = activePeer;
          if (peer) queueMicrotask(() => peer.addReceivedData(Buffer.from(data)));
        },
      },
      {
        s(message) {
          events.push(message);
        },
      },
    );

    async function download(name: string, bytes: Buffer, expectedEnds: number): Promise<void> {
      const peer = new TrzszTransfer((data) => {
        queueMicrotask(() => session.handleData(Buffer.from(data)));
      });
      activePeer = peer;
      const complete = (async () => {
        const action = await peer.recvAction();
        expect(action.confirm).toBe(true);
        await peer.sendConfig({}, [], 0, 0);
        await peer.sendFiles([new MemoryReader(name, bytes)], null);
        expect(await peer.recvExit()).toBe('Success');
      })();

      expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:S:fixture\r\n'))).toBe(true);
      session.handleMessage({ event: 'set-save-path', path: directory });
      await complete;
      await vi.waitFor(() =>
        expect(events.filter(({ event }) => event === 'session-end')).toHaveLength(expectedEnds),
      );
      expect(session.isActive()).toBe(false);
    }

    const first = Buffer.from([0, 1, 255]);
    const second = Buffer.from([9, 8, 7, 6]);
    await download('first.bin', first, 1);
    await download('second.bin', second, 2);

    expect(await readFile(join(directory, 'first.bin'))).toEqual(first);
    expect(await readFile(join(directory, 'second.bin'))).toEqual(second);
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toEqual([]);
    expect(events.filter(({ event }) => event === 'file-complete')).toHaveLength(2);
    expect(events.filter(({ event }) => event === 'session-complete')).toHaveLength(2);

    session.destroy();
    expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:S:later\r\n'))).toBe(false);
    expect(session.handleData(Buffer.from('ordinary terminal output\r\n'))).toBe(false);
  });

  it('reuses a completed terminal session for a second upload without revisiting closed readers', async () => {
    const directory = await root();
    const firstPath = join(directory, 'first-upload.bin');
    const secondPath = join(directory, 'second-upload.bin');
    const first = Buffer.from([1, 2, 3]);
    const second = Buffer.from([255, 0, 254, 4]);
    await writeFile(firstPath, first);
    await writeFile(secondPath, second);

    const events: Array<Record<string, unknown>> = [];
    let activePeer: TrzszTransfer | undefined;
    const session = new TrzszSession(
      {
        write(data) {
          const peer = activePeer;
          if (peer) queueMicrotask(() => peer.addReceivedData(Buffer.from(data)));
        },
      },
      {
        s(message) {
          events.push(message);
        },
      },
    );

    async function upload(
      path: string,
      received: MemoryWriter,
      expectedEnds: number,
    ): Promise<void> {
      const peer = new TrzszTransfer((data) => {
        queueMicrotask(() => session.handleData(Buffer.from(data)));
      });
      activePeer = peer;
      const complete = (async () => {
        const action = await peer.recvAction();
        expect(action.confirm).toBe(true);
        await peer.sendConfig({}, [], 0, 0);
        await peer.recvFiles(null, async () => received, null);
        expect(await peer.recvExit()).toBe('Success');
      })();

      expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:R:fixture\r\n'))).toBe(true);
      session.handleMessage({ event: 'send-files', files: [{ path }] });
      await complete;
      await vi.waitFor(() =>
        expect(events.filter(({ event }) => event === 'session-end')).toHaveLength(expectedEnds),
      );
      expect(session.isActive()).toBe(false);
    }

    const firstReceived = new MemoryWriter();
    const secondReceived = new MemoryWriter();
    await upload(firstPath, firstReceived, 1);
    await upload(secondPath, secondReceived, 2);

    expect(Buffer.concat(firstReceived.chunks)).toEqual(first);
    expect(Buffer.concat(secondReceived.chunks)).toEqual(second);
    expect(events.filter(({ event }) => event === 'file-complete')).toHaveLength(2);
    expect(events.filter(({ event }) => event === 'session-complete')).toHaveLength(2);
  });

  it('cancels while waiting for peer configuration and restores ordinary output', async () => {
    const { session, events } = pair();
    expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:S:fixture\r\n'))).toBe(true);
    await session.cancel();
    await vi.waitFor(() => expect(session.isActive()).toBe(false));
    expect(session.handleData(Buffer.from('shell prompt\r\n'))).toBe(false);
    expect(events.map(({ event }) => event)).not.toContain('session-complete');
  });

  it('cleans partially staged output when the Runtime destroys a selected receive while its peer remains open', async () => {
    const directory = await root();
    let destroyedAfterStaging = false;
    let cleanup: Promise<void> | undefined;
    const sessionRef: { current?: TrzszSession } = {};
    const fixture = pair((event) => {
      if (!destroyedAfterStaging && event.event === 'progress' && Number(event.transferred) > 0) {
        destroyedAfterStaging = true;
        cleanup = sessionRef.current!.destroy();
      }
    });
    const session = fixture.session;
    sessionRef.current = session;
    const { remote, events } = fixture;
    const peer = (async () => {
      const action = await remote.recvAction();
      expect(action.confirm).toBe(true);
      await remote.sendConfig({}, [], 0, 0);
      await remote.sendFiles(
        [new MemoryReader('interrupted.bin', Buffer.alloc(128 * 1024, 0xa5))],
        null,
      );
    })().catch(() => undefined);

    expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:S:fixture\r\n'))).toBe(true);
    session.handleMessage({ event: 'set-save-path', path: directory });
    await vi.waitFor(() => expect(destroyedAfterStaging).toBe(true));
    await cleanup;
    await vi.waitFor(() => expect(session.isActive()).toBe(false));
    await remote.stopTransferring().catch(() => undefined);
    await peer;

    expect(await readdir(directory)).toEqual([]);
    expect(events.map(({ event }) => event)).not.toContain('file-complete');
    expect(events.map(({ event }) => event)).not.toContain('session-complete');
  });

  it('does not report destroy complete before staged receive cleanup finishes', async () => {
    const directory = await root();
    let releaseCleanup: (() => void) | undefined;
    let reportCleanupStarted: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      reportCleanupStarted = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let destruction: Promise<void> | undefined;
    const sessionRef: { current?: TrzszSession } = {};
    const fixture = pair(
      (event) => {
        if (destruction || event.event !== 'progress' || Number(event.transferred) <= 0) return;
        destruction = sessionRef.current!.destroy();
      },
      undefined,
      (finalPath, fileName) =>
        new (class extends StagedTrzszWriter {
          override async deleteFile(): Promise<string> {
            reportCleanupStarted?.();
            await cleanupGate;
            return super.deleteFile();
          }
        })(finalPath, fileName),
    );
    const { session, remote } = fixture;
    sessionRef.current = session;
    const peer = (async () => {
      const action = await remote.recvAction();
      expect(action.confirm).toBe(true);
      await remote.sendConfig({}, [], 0, 0);
      await remote.sendFiles(
        [new MemoryReader('delayed.bin', Buffer.alloc(128 * 1024, 0xa5))],
        null,
      );
    })().catch(() => undefined);

    expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:S:fixture\r\n'))).toBe(true);
    session.handleMessage({ event: 'set-save-path', path: directory });
    await cleanupStarted;
    let destroyed = false;
    const waiting = destruction!.then(() => {
      destroyed = true;
    });
    await Promise.resolve();
    expect(destroyed).toBe(false);
    releaseCleanup?.();
    await waiting;
    await remote.stopTransferring().catch(() => undefined);
    await peer;
    expect(await readdir(directory)).toEqual([]);
  });

  it('reports a failed staged cleanup instead of treating Runtime destruction as complete', async () => {
    const directory = await root();
    let destruction: Promise<void> | undefined;
    const sessionRef: { current?: TrzszSession } = {};
    const fixture = pair(
      (event) => {
        if (destruction || event.event !== 'progress' || Number(event.transferred) <= 0) return;
        destruction = sessionRef.current!.destroy();
      },
      undefined,
      (finalPath, fileName) =>
        new (class extends StagedTrzszWriter {
          override async deleteFile(): Promise<string> {
            throw Object.assign(new Error('Stage removal refused'), { code: 'EACCES' });
          }
        })(finalPath, fileName),
    );
    const { session, remote, events } = fixture;
    sessionRef.current = session;
    const peer = (async () => {
      const action = await remote.recvAction();
      expect(action.confirm).toBe(true);
      await remote.sendConfig({}, [], 0, 0);
      await remote.sendFiles(
        [new MemoryReader('cleanup-failure.bin', Buffer.alloc(128 * 1024, 0xa5))],
        null,
      );
    })().catch(() => undefined);

    expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:S:fixture\r\n'))).toBe(true);
    session.handleMessage({ event: 'set-save-path', path: directory });
    await vi.waitFor(() => expect(destruction).toBeDefined());
    await expect(destruction).rejects.toMatchObject({ code: 'EACCES' });
    await remote.stopTransferring().catch(() => undefined);
    await peer;
    expect(session.isActive()).toBe(false);
    expect(events.map(({ event }) => event)).not.toContain('session-complete');
    expect((await readdir(directory)).some((entry) => entry.endsWith('.part'))).toBe(true);
  });

  it.each(partialWriteFailures)(
    'cancels and removes partially written output when $condition',
    async ({ code }) => {
      const directory = await root();
      let writeCalls = 0;
      let stagedBytes = 0;
      const createWriter: StagedTrzszWriterFactory = (finalPath, fileName) =>
        new StagedTrzszWriter(finalPath, fileName, async (handle, buffer, offset, length) => {
          writeCalls += 1;
          if (writeCalls > 1)
            throw Object.assign(new Error(`${code} after partial write`), { code });
          const { bytesWritten } = await handle.write(buffer, offset, Math.min(length, 64));
          stagedBytes += bytesWritten;
          return bytesWritten;
        });
      const { session, remote, events, outgoing } = pair(undefined, undefined, createWriter);
      const peer = (async () => {
        const action = await remote.recvAction();
        expect(action.confirm).toBe(true);
        await remote.sendConfig({}, [], 0, 0);
        await remote.sendFiles(
          [new MemoryReader(`${code.toLowerCase()}.bin`, Buffer.alloc(128 * 1024, 0xa5))],
          null,
        );
      })().catch(() => undefined);

      expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:S:fixture\r\n'))).toBe(true);
      session.handleMessage({ event: 'set-save-path', path: directory });
      await vi.waitFor(() =>
        expect(events.map(({ event }) => event)).toEqual(
          expect.arrayContaining(['session-error', 'session-end']),
        ),
      );
      await remote.stopTransferring().catch(() => undefined);
      await peer;

      expect(stagedBytes).toBe(64);
      expect(writeCalls).toBe(2);
      expect(session.isActive()).toBe(false);
      expect(await readdir(directory)).toEqual([]);
      expect(events.map(({ event }) => event)).not.toContain('file-complete');
      expect(events.map(({ event }) => event)).not.toContain('session-complete');
      expect(outgoing).toContainEqual(Buffer.from([0x03]));
    },
  );

  it.skipIf(process.platform === 'win32')(
    'cancels without publication when selected staging disappears while the peer remains open',
    async () => {
      const directory = await root();
      let stagedBytesObserved = false;
      let releaseHeldPeerAck: (() => void) | undefined;
      const fixture = pair(
        (event) => {
          if (event.event === 'progress' && Number(event.transferred) > 0)
            stagedBytesObserved = true;
        },
        (_data, deliver) => {
          if (stagedBytesObserved && !releaseHeldPeerAck) releaseHeldPeerAck = deliver;
          else deliver();
        },
      );
      const { session, remote, events } = fixture;
      const peer = (async () => {
        const action = await remote.recvAction();
        expect(action.confirm).toBe(true);
        await remote.sendConfig({}, [], 0, 0);
        await remote.sendFiles(
          [new MemoryReader('lost-staging.bin', Buffer.alloc(128 * 1024, 0xa5))],
          null,
        );
      })().catch(() => undefined);

      expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:S:fixture\r\n'))).toBe(true);
      session.handleMessage({ event: 'set-save-path', path: directory });
      await vi.waitFor(() => expect(releaseHeldPeerAck).toBeDefined());
      const staged = (await readdir(directory)).find((entry) => entry.endsWith('.part'));
      expect(staged).toBeDefined();
      await unlink(join(directory, staged!));

      releaseHeldPeerAck!();
      await vi.waitFor(() =>
        expect(events.map(({ event }) => event)).toEqual(
          expect.arrayContaining(['session-error', 'session-end']),
        ),
      );
      await remote.stopTransferring().catch(() => undefined);
      await peer;
      expect(session.isActive()).toBe(false);
      expect(await readdir(directory)).toEqual([]);
      expect(events.map(({ event }) => event)).not.toContain('file-complete');
      expect(events.map(({ event }) => event)).not.toContain('session-complete');
    },
  );

  it('times out an inactive peer and releases the protocol session', async () => {
    vi.useFakeTimers();
    try {
      const { session, events } = pair();
      expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:S:fixture\r\n'))).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events.map(({ event }) => event)).toContain('session-timeout');
      expect(events.map(({ event }) => event)).toContain('session-end');
      expect(session.isActive()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an advertised file larger than the configured transfer bound', async () => {
    const directory = await root();
    const { session, remote, events, outgoing } = pair();
    const peer = (async () => {
      await remote.recvAction();
      await remote.sendConfig({}, [], 0, 0);
      await remote.sendFiles(
        [
          {
            ...new MemoryReader('oversize.bin', Buffer.alloc(0)),
            getPathId: () => 0,
            getRelPath: () => ['oversize.bin'],
            isDir: () => false,
            getSize: () => 4 * 1024 * 1024 * 1024 + 1,
            readFile: async () => Buffer.alloc(0),
            closeFile: () => {},
          },
        ],
        null,
      );
    })().catch(() => undefined);
    expect(session.handleData(Buffer.from('::TRZSZ:TRANSFER:S:fixture\r\n'))).toBe(true);
    session.handleMessage({ event: 'set-save-path', path: directory });
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ event: 'session-end' })),
    );
    expect(events.map(({ event }) => event)).toContain('session-error');
    expect(await readdir(directory)).toEqual([]);
    expect(Buffer.concat(outgoing)).toContain(0x03);
    await remote.stopTransferring();
    await peer;
  });
});
