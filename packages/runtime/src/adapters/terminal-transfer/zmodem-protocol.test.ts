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
import { Receiver, Sender, SenderEvent } from 'zmodem2';
import { ZmodemReceiveFile, ZmodemSession, type ZmodemReceiveFileFactory } from './zmodem';

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

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'axterm-zmodem-protocol-'));
  roots.push(path);
  return path;
}

type RemoteSenderOptions = {
  mutateOutgoing?: (outgoing: Buffer) => Buffer;
  onEvent?: (event: Record<string, unknown>) => void;
  createReceiveFile?: ZmodemReceiveFileFactory;
};

function remoteSender(
  name: string,
  bytes: Buffer,
  directory: string,
  options: RemoteSenderOptions = {},
) {
  const remote = new Sender();
  remote.startFile(name, bytes.length);
  const events: Array<Record<string, unknown>> = [];
  const terminalWrites: Buffer[] = [];
  const advance = () => {
    for (let index = 0; index < 100; index += 1) {
      let progressed = false;
      const outgoing = Buffer.from(remote.drainOutgoing());
      if (outgoing.length > 0) {
        queueMicrotask(() => session.handleData(options.mutateOutgoing?.(outgoing) ?? outgoing));
        progressed = true;
      }
      let event: SenderEvent | null;
      while ((event = remote.pollEvent())) {
        if (event === SenderEvent.FileComplete) remote.finishSession();
        progressed = true;
      }
      const request = remote.pollFile();
      if (request) {
        remote.feedFile(bytes.subarray(request.offset, request.offset + request.len));
        progressed = true;
      }
      if (!progressed) return;
    }
    throw new Error('Remote ZMODEM sender did not yield');
  };
  const session = new ZmodemSession(
    {
      write: (data) => {
        terminalWrites.push(Buffer.from(data));
        queueMicrotask(() => {
          remote.feedIncoming(data);
          advance();
        });
      },
    },
    {
      s: (event) => {
        events.push(event);
        options.onEvent?.(event);
        if (event.event === 'receive-start')
          session.handleMessage({ event: 'set-save-path', path: directory });
      },
      send: () => {},
    },
    options.createReceiveFile,
  );
  return { session, events, terminalWrites, advance };
}

function remoteReceiver(path: string) {
  const remote = new Receiver();
  const received: Buffer[] = [];
  const events: Array<Record<string, unknown>> = [];
  const advance = () => {
    for (let index = 0; index < 100; index += 1) {
      let progressed = false;
      const outgoing = remote.drainOutgoing();
      if (outgoing.length > 0) {
        queueMicrotask(() => session.handleData(outgoing));
        progressed = true;
      }
      while (remote.pollEvent()) progressed = true;
      const fileBytes = remote.drainFile();
      if (fileBytes.length > 0) {
        received.push(Buffer.from(fileBytes));
        progressed = true;
      }
      if (!progressed) return;
    }
    throw new Error('Remote ZMODEM receiver did not yield');
  };
  const session = new ZmodemSession(
    {
      write: (data) =>
        queueMicrotask(() => {
          remote.feedIncoming(data);
          advance();
        }),
    },
    {
      s: (event) => {
        events.push(event);
        if (event.event === 'send-start')
          session.handleMessage({ event: 'send-files', files: [{ path }] });
      },
      send: () => {},
    },
  );
  return { session, events, received, advance };
}

describe('independent ZMODEM adapter with real protocol peers', () => {
  it.skipIf(!realNoReplaceDirectory)(
    'reports an unsupported destination and cleans staging on a real no-replace-limited volume',
    async () => {
      const directory = await mkdtemp(join(realNoReplaceDirectory!, 'axterm-zmodem-ir03-'));
      roots.push(directory);
      const { session, events, advance } = remoteSender(
        'unsupported.bin',
        Buffer.from([0, 1, 2, 255]),
        directory,
      );
      advance();
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            event: 'transfer-error',
            errorCode: 'TRANSFER_DESTINATION_UNSUPPORTED',
          }),
        ),
      );
      expect(session.isActive()).toBe(false);
      expect((await readdir(directory)).filter((name) => !name.startsWith('._'))).toEqual([]);
      expect(events.map(({ event }) => event)).not.toContain('file-complete');
    },
  );

  it('downloads a binary file to a staged no-overwrite destination', async () => {
    const directory = await root();
    const destination = join(directory, 'downloads');
    await mkdir(destination);
    const bytes = Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.alloc(12_000, 0xa5)]);
    const { session, events, advance } = remoteSender('payload.bin', bytes, destination);
    advance();
    await vi.waitFor(() =>
      expect(events.map((event) => event.event)).toContain('session-complete'),
    );
    expect(await readFile(join(destination, 'payload.bin'))).toEqual(bytes);
    expect(session.isActive()).toBe(false);
    expect(events.some((event) => 'path' in event)).toBe(false);
  });

  it('confines a remote traversal filename to the selected directory', async () => {
    const directory = await root();
    const destination = join(directory, 'downloads');
    const outside = join(directory, 'outside.bin');
    await mkdir(destination);
    await writeFile(outside, 'existing outside bytes');
    const bytes = Buffer.from([0, 255, 1, 2]);
    const { events, advance } = remoteSender('../outside.bin', bytes, destination);

    advance();
    await vi.waitFor(() =>
      expect(events.map((event) => event.event)).toContain('session-complete'),
    );

    expect(await readFile(outside, 'utf8')).toBe('existing outside bytes');
    expect(await readdir(destination)).toEqual(['.._outside.bin']);
    expect(await readFile(join(destination, '.._outside.bin'))).toEqual(bytes);
    expect(events.some((event) => 'path' in event)).toBe(false);
  });

  it('uploads a selected binary file and completes the peer session', async () => {
    const directory = await root();
    const path = join(directory, 'selected.bin');
    const bytes = Buffer.from([255, 0, 13, 10, 1, 2, 3]);
    await writeFile(path, bytes);
    const { session, events, received, advance } = remoteReceiver(path);
    advance();
    await vi.waitFor(() =>
      expect(events.map((event) => event.event)).toContain('session-complete'),
    );
    expect(Buffer.concat(received)).toEqual(bytes);
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
      const { session, events, received, advance } = remoteReceiver(selected);

      advance();
      await vi.waitFor(() =>
        expect(events.map((event) => event.event)).toEqual(
          expect.arrayContaining(['transfer-error', 'session-end']),
        ),
      );
      expect(Buffer.concat(received)).toHaveLength(0);
      expect(events.map((event) => event.event)).not.toContain('session-complete');
      expect(session.isActive()).toBe(false);
    },
  );

  it('retains an existing destination and publishes the received file under a bounded suffix', async () => {
    const directory = await root();
    await writeFile(join(directory, 'payload.bin'), 'existing');
    const bytes = Buffer.from([0, 255, 1, 2, 3]);
    const { events, advance } = remoteSender('payload.bin', bytes, directory);
    advance();
    await vi.waitFor(() =>
      expect(events.map((event) => event.event)).toContain('session-complete'),
    );
    expect(await readFile(join(directory, 'payload.bin'), 'utf8')).toBe('existing');
    expect(await readFile(join(directory, 'payload.1.bin'))).toEqual(bytes);
  });

  it('keeps a collision suffix within the filesystem name limit', async () => {
    const directory = await root();
    const name = `${'n'.repeat(251)}.txt`;
    await writeFile(join(directory, name), 'existing');
    const bytes = Buffer.from([0, 255, 1]);
    const { events, advance } = remoteSender(name, bytes, directory);
    advance();
    await vi.waitFor(() =>
      expect(events.map((event) => event.event)).toContain('session-complete'),
    );
    const published = (await readdir(directory)).find((entry) => entry !== name);
    expect(published).toBeDefined();
    expect(Buffer.byteLength(published!, 'utf8')).toBeLessThanOrEqual(255);
    expect(await readFile(join(directory, published!))).toEqual(bytes);
    expect(await readFile(join(directory, name), 'utf8')).toBe('existing');
  });

  it('cancels an unfinished session and returns control to terminal output', async () => {
    const output: Buffer[] = [];
    const events: string[] = [];
    const session = new ZmodemSession(
      { write: (data) => output.push(Buffer.from(data)) },
      { s: (event) => events.push(String(event.event)), send: () => {} },
    );
    const header = new Sender().drainOutgoing();
    expect(session.handleData(header.subarray(0, 7))).toBe(false);
    expect(session.handleData(header.subarray(7))).toBe(true);
    expect(events).toContain('receive-start');
    session.handleMessage({ event: 'cancel' });
    await vi.waitFor(() => expect(session.isActive()).toBe(false));
    expect(Buffer.concat(output).subarray(0, 5)).toEqual(Buffer.alloc(5, 0x18));
    expect(session.handleData(Buffer.from('shell prompt\r\n'))).toBe(false);
  });

  it('cancels a selected peer that queues too many tiny frames before a save path is chosen', async () => {
    const events: string[] = [];
    const writes: Buffer[] = [];
    const session = new ZmodemSession(
      { write: (data) => writes.push(Buffer.from(data)) },
      { s: (event) => events.push(String(event.event)), send: () => {} },
    );
    expect(session.handleData(new Sender().drainOutgoing())).toBe(true);
    expect(session.isActive()).toBe(true);

    for (let index = 0; index < 4_095; index += 1) {
      expect(session.handleData(Buffer.from([0x00]))).toBe(true);
    }
    expect(session.isActive()).toBe(true);
    expect(session.handleData(Buffer.from([0x00]))).toBe(true);
    expect(session.isActive()).toBe(false);
    await vi.waitFor(() => expect(events).toContain('session-end'));
    expect(events.filter((event) => event === 'transfer-error')).toHaveLength(1);
    expect(Buffer.concat(writes).subarray(0, 5)).toEqual(Buffer.alloc(5, 0x18));
  });

  it('does not start or leave an idle timer after an oversized initial peer frame', async () => {
    const events: string[] = [];
    const session = new ZmodemSession(
      { write: () => {} },
      { s: (event) => events.push(String(event.event)), send: () => {} },
    );
    const oversized = Buffer.concat([new Sender().drainOutgoing(), Buffer.alloc(4 * 1024 * 1024)]);
    expect(session.handleData(oversized)).toBe(true);
    expect(session.isActive()).toBe(false);
    expect(events).toContain('transfer-error');
    expect(events).not.toContain('receive-start');
    expect((session as unknown as { timer: ReturnType<typeof setTimeout> | undefined }).timer).toBe(
      undefined,
    );
    await session.destroy();
  });

  it('cleans partially staged output when a selected peer frame has an invalid CRC', async () => {
    const directory = await root();
    const bytes = Buffer.alloc(128 * 1024, 0xa5);
    let corruptDataPackets = false;
    let dataPacketCount = 0;
    let corrupted = false;
    const { session, events, advance } = remoteSender('damaged.bin', bytes, directory, {
      onEvent: (event) => {
        if (event.event === 'receive-start') corruptDataPackets = true;
      },
      mutateOutgoing: (outgoing) => {
        if (!corruptDataPackets || corrupted || outgoing.length < 1_024) return outgoing;
        dataPacketCount += 1;
        if (dataPacketCount < 2) return outgoing;
        corrupted = true;
        const damaged = Buffer.from(outgoing);
        damaged[Math.floor(damaged.length / 2)]! ^= 0x01;
        return damaged;
      },
    });

    advance();
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.event === 'progress' && Number(event.transferred) > 0),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(events.map((event) => event.event)).toEqual(
        expect.arrayContaining(['transfer-error', 'session-end']),
      ),
    );
    expect(corrupted).toBe(true);
    expect(session.isActive()).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(partialWriteFailures)(
    'cancels and removes partially written output when $condition',
    async ({ code }) => {
      const directory = await root();
      let writeCalls = 0;
      let stagedBytes = 0;
      const createReceiveFile: ZmodemReceiveFileFactory = (finalPath, name, size) =>
        new ZmodemReceiveFile(finalPath, name, size, async (handle, buffer, offset, length) => {
          writeCalls += 1;
          if (writeCalls > 1)
            throw Object.assign(new Error(`${code} after partial write`), { code });
          const { bytesWritten } = await handle.write(buffer, offset, Math.min(length, 64));
          stagedBytes += bytesWritten;
          return bytesWritten;
        });
      const { session, events, terminalWrites, advance } = remoteSender(
        `${code.toLowerCase()}.bin`,
        Buffer.alloc(128 * 1024, 0xa5),
        directory,
        { createReceiveFile },
      );

      advance();
      await vi.waitFor(() =>
        expect(events.map(({ event }) => event)).toEqual(
          expect.arrayContaining(['transfer-error', 'session-end']),
        ),
      );

      expect(stagedBytes).toBe(64);
      expect(writeCalls).toBe(2);
      expect(session.isActive()).toBe(false);
      expect(await readdir(directory)).toEqual([]);
      expect(events.map(({ event }) => event)).not.toContain('file-complete');
      expect(events.map(({ event }) => event)).not.toContain('session-complete');
      expect(terminalWrites).toContainEqual(
        Buffer.from([0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x42]),
      );
    },
  );

  it.skipIf(process.platform === 'win32')(
    'cancels without publication when selected staging disappears while the peer remains open',
    async () => {
      const directory = await root();
      const bytes = Buffer.alloc(128 * 1024, 0xa5);
      let holdLaterPeerBytes = false;
      let heldPeerBytes: Buffer | undefined;
      const { session, events, advance } = remoteSender('lost-staging.bin', bytes, directory, {
        onEvent: (event) => {
          if (event.event === 'progress' && Number(event.transferred) > 0)
            holdLaterPeerBytes = true;
        },
        mutateOutgoing: (outgoing) => {
          if (holdLaterPeerBytes && !heldPeerBytes) {
            heldPeerBytes = Buffer.from(outgoing);
            return Buffer.alloc(0);
          }
          return outgoing;
        },
      });

      advance();
      await vi.waitFor(() => expect(heldPeerBytes).toBeDefined());
      const staged = (await readdir(directory)).find((entry) => entry.endsWith('.part'));
      expect(staged).toBeDefined();
      await unlink(join(directory, staged!));

      session.handleData(heldPeerBytes!);
      await vi.waitFor(() =>
        expect(events.map(({ event }) => event)).toEqual(
          expect.arrayContaining(['transfer-error', 'session-end']),
        ),
      );
      expect(session.isActive()).toBe(false);
      expect(await readdir(directory)).toEqual([]);
      expect(events.map(({ event }) => event)).not.toContain('file-complete');
      expect(events.map(({ event }) => event)).not.toContain('session-complete');
    },
  );

  it('cleans partially staged output when the Runtime destroys a selected session while its peer remains open', async () => {
    const directory = await root();
    const bytes = Buffer.alloc(128 * 1024, 0xa5);
    let destroyedAfterStaging = false;
    let cleanup: Promise<void> | undefined;
    const { session, events, advance } = remoteSender('interrupted.bin', bytes, directory, {
      onEvent: (event) => {
        if (!destroyedAfterStaging && event.event === 'progress' && Number(event.transferred) > 0) {
          destroyedAfterStaging = true;
          cleanup = session.destroy();
        }
      },
    });

    advance();
    await vi.waitFor(() => expect(destroyedAfterStaging).toBe(true));
    await cleanup;
    await vi.waitFor(() => expect(session.isActive()).toBe(false));
    expect(await readdir(directory)).toEqual([]);
    expect(events.map((event) => event.event)).not.toContain('session-complete');
  });

  it('waits for an already-started cancellation cleanup before destroy resolves', async () => {
    const directory = await root();
    let releaseCleanup: (() => void) | undefined;
    let reportCleanupStarted: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      reportCleanupStarted = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let canceled = false;
    const { session, advance } = remoteSender(
      'delayed.bin',
      Buffer.alloc(128 * 1024, 0xa5),
      directory,
      {
        createReceiveFile: (finalPath, name, size) =>
          new (class extends ZmodemReceiveFile {
            override async cleanup(): Promise<void> {
              reportCleanupStarted?.();
              await cleanupGate;
              await super.cleanup();
            }
          })(finalPath, name, size),
        onEvent: (event) => {
          if (canceled || event.event !== 'progress' || Number(event.transferred) <= 0) return;
          canceled = true;
          session.handleMessage({ event: 'cancel' });
        },
      },
    );

    advance();
    await cleanupStarted;
    let destroyed = false;
    const destruction = session.destroy().then(() => {
      destroyed = true;
    });
    await Promise.resolve();
    expect(destroyed).toBe(false);
    releaseCleanup?.();
    await destruction;
    expect(await readdir(directory)).toEqual([]);
  });

  it('ends a failed cancellation and retries its own staged name on Runtime destruction', async () => {
    const directory = await root();
    let removals = 0;
    let canceled = false;
    const { session, events, advance } = remoteSender(
      'retry.bin',
      Buffer.alloc(128 * 1024, 0xa5),
      directory,
      {
        createReceiveFile: (finalPath, name, size) =>
          new ZmodemReceiveFile(finalPath, name, size, undefined, async (path) => {
            removals += 1;
            if (removals === 1)
              throw Object.assign(new Error(`Stage removal refused at ${path}`), {
                code: 'EACCES',
              });
            await unlink(path);
          }),
        onEvent: (event) => {
          if (canceled || event.event !== 'progress' || Number(event.transferred) <= 0) return;
          canceled = true;
          session.handleMessage({ event: 'cancel' });
        },
      },
    );

    advance();
    await vi.waitFor(() => expect(events.some(({ event }) => event === 'session-end')).toBe(true));
    expect(session.isActive()).toBe(false);
    expect(events.filter(({ event }) => event === 'transfer-error')).toHaveLength(1);
    expect(events.map(({ event }) => event)).not.toContain('session-complete');
    expect(JSON.stringify(events)).not.toContain(directory);
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toHaveLength(1);
    expect(session.handleData(new Sender().drainOutgoing())).toBe(false);

    await session.destroy();
    expect(removals).toBe(2);
    expect(await readdir(directory)).toEqual([]);
  });

  it('propagates a persistent staged-cleanup failure without leaving the UI session active', async () => {
    const directory = await root();
    let removals = 0;
    let canceled = false;
    const { session, events, advance } = remoteSender(
      'denied.bin',
      Buffer.alloc(128 * 1024, 0xa5),
      directory,
      {
        createReceiveFile: (finalPath, name, size) =>
          new ZmodemReceiveFile(finalPath, name, size, undefined, async (path) => {
            removals += 1;
            throw Object.assign(new Error(`Stage removal refused at ${path}`), {
              code: 'EACCES',
            });
          }),
        onEvent: (event) => {
          if (canceled || event.event !== 'progress' || Number(event.transferred) <= 0) return;
          canceled = true;
          session.handleMessage({ event: 'cancel' });
        },
      },
    );

    advance();
    await vi.waitFor(() => expect(events.some(({ event }) => event === 'session-end')).toBe(true));
    expect(session.isActive()).toBe(false);
    const failure = await session.destroy().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'EACCES' });
    expect(String(failure)).not.toContain(directory);
    expect(removals).toBe(2);
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toHaveLength(1);
  });

  it('ends an upload after a source-close failure and retries that handle on destroy', async () => {
    const directory = await root();
    const path = join(directory, 'source.bin');
    await writeFile(path, Buffer.from('DATA'));
    const events: string[] = [];
    const session = new ZmodemSession(
      { write: () => {} },
      {
        s: (event) => {
          events.push(String(event.event));
          if (event.event === 'send-start')
            session.handleMessage({ event: 'send-files', files: [{ path }] });
        },
        send: () => {},
      },
    );
    expect(session.handleData(new Receiver().drainOutgoing())).toBe(true);
    await vi.waitFor(() => expect(events).toContain('file-start'));
    const source = (session as unknown as { source: { close(): Promise<void> } }).source;
    const originalClose = source.close.bind(source);
    let closes = 0;
    source.close = async () => {
      closes += 1;
      if (closes === 1)
        throw Object.assign(new Error(`Synthetic close refusal at ${path}`), { code: 'EIO' });
      await originalClose();
    };

    session.handleMessage({ event: 'cancel' });
    await vi.waitFor(() => expect(events).toContain('session-end'));
    expect(events).toContain('transfer-error');
    expect(session.isActive()).toBe(false);
    await session.destroy();
    expect(closes).toBe(2);
    expect(await readFile(path, 'utf8')).toBe('DATA');
  });

  it('starts a new transfer on the same terminal after a completed or canceled session', async () => {
    const directory = await root();
    const source = join(directory, 'second.bin');
    await writeFile(source, Buffer.from([0, 255, 1]));
    const events: string[] = [];
    const session = new ZmodemSession(
      { write: () => {} },
      { s: (event) => events.push(String(event.event)), send: () => {} },
    );
    expect(session.handleData(new Sender().drainOutgoing())).toBe(true);
    session.handleMessage({ event: 'cancel' });
    await vi.waitFor(() => expect(events).toContain('session-end'));
    expect(session.isActive()).toBe(false);

    expect(session.handleData(new Receiver().drainOutgoing())).toBe(true);
    expect(events).toContain('send-start');
    session.handleMessage({ event: 'send-files', files: [{ path: source }] });
    await vi.waitFor(() => expect(events).toContain('file-start'));
    expect(session.isActive()).toBe(true);
    session.destroy();
  });

  it('times out an idle peer and clears its active state', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const session = new ZmodemSession(
        { write: () => {} },
        { s: (event) => events.push(String(event.event)), send: () => {} },
      );
      expect(session.handleData(new Sender().drainOutgoing())).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events).toContain('session-timeout');
      expect(events).toContain('session-end');
      expect(session.isActive()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not open a transfer for an invalid header CRC', () => {
    const session = new ZmodemSession({ write: () => {} }, { s: () => {}, send: () => {} });
    expect(session.handleData(Buffer.from('**\x18B00000000000001\r\n\x11', 'binary'))).toBe(false);
    expect(session.isActive()).toBe(false);
  });

  it('retains only a bounded header prefix after a large ordinary terminal chunk', () => {
    const session = new ZmodemSession({ write: () => {} }, { s: () => {}, send: () => {} });
    expect(session.handleData(Buffer.alloc(512 * 1024, 0x41))).toBe(false);
    const tail = (session as unknown as { tail: Buffer }).tail;
    expect(tail).toHaveLength(17);
    expect(tail.buffer.byteLength).toBeLessThanOrEqual(64 * 1024);
  });
});
