import { unlinkSync, writeSync } from 'node:fs';
import { link, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeTerminalTransferAdapter } from './terminal-transfer-adapter';
import { XmodemManager, XmodemSession } from './xmodem';

const roots: string[] = [];
const realNoReplaceDirectory = process.env.AXTERM_REAL_NO_REPLACE_DIRECTORY;
const partialWriteFailures = [
  { code: 'ENOSPC', condition: 'the destination runs out of space' },
  { code: 'EACCES', condition: 'the destination rejects write permission' },
  { code: 'EIO', condition: 'the filesystem reports an I/O failure' },
] as const;

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function fixture() {
  const writes: Buffer[] = [];
  const events: Array<Record<string, unknown>> = [];
  const session = new XmodemSession(
    {
      write: (data) => writes.push(Buffer.from(data)),
      writeRaw: (data) => writes.push(Buffer.from(data)),
    },
    { s: (event) => events.push(event) },
  );
  return { session, writes, events };
}

function crcFrame(block: number, value: Buffer, size = 128): Buffer {
  const payload = Buffer.alloc(size, 0x1a);
  value.copy(payload);
  let crc = 0;
  for (const byte of payload) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc <<= 1;
      if (crc & 0x1_0000) crc ^= 0x1021;
      crc &= 0xffff;
    }
  }
  const frame = Buffer.alloc(size + 5);
  frame[0] = size === 128 ? 0x01 : 0x02;
  frame[1] = block;
  frame[2] = 0xff ^ block;
  payload.copy(frame, 3);
  frame.writeUInt16BE(crc, size + 3);
  return frame;
}

describe('independent XMODEM protocol', () => {
  it.skipIf(!realNoReplaceDirectory)(
    'reports an unsupported destination and cleans staging on a real no-replace-limited volume',
    async () => {
      const root = await mkdtemp(join(realNoReplaceDirectory!, 'axterm-xmodem-ir03-'));
      roots.push(root);
      const { session, writes, events } = fixture();
      session.startReceive();
      session.setSavePath(root, 'unsupported.bin');
      session.handleData(crcFrame(1, Buffer.from([0, 1, 2, 255])));
      session.handleData(Buffer.from([0x04]));
      await vi.waitFor(() =>
        expect(events).toContainEqual(
          expect.objectContaining({
            event: 'session-error',
            errorCode: 'TRANSFER_DESTINATION_UNSUPPORTED',
          }),
        ),
      );
      expect(session.isActive()).toBe(false);
      expect((await readdir(root)).filter((name) => !name.startsWith('._'))).toEqual([]);
      expect(writes.at(-1)).toEqual(Buffer.from([0x18, 0x18]));
      expect(events.map(({ event }) => event)).not.toContain('file-complete');
    },
  );

  it('retries the identical CRC packet and completes only after EOT is acknowledged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-send-'));
    roots.push(root);
    const source = join(root, 'secret.bin');
    await writeFile(source, Buffer.from('DATA'));
    const { session, writes, events } = fixture();
    session.startSend();
    session.setSendFiles([{ path: source, name: 'secret.bin', size: 4 }]);
    session.handleData(Buffer.from([0x43]));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toHaveLength(133);
    expect([...writes[0]!.subarray(0, 3)]).toEqual([0x01, 1, 0xfe]);
    expect(writes[0]!.subarray(3, 7).toString()).toBe('DATA');

    session.handleData(Buffer.from([0x15]));
    expect(writes[1]).toEqual(writes[0]);
    session.handleData(Buffer.from([0x06]));
    expect(writes[2]).toEqual(Buffer.from([0x04]));
    expect(events.some(({ event }) => event === 'file-complete')).toBe(false);
    session.handleData(Buffer.from([0x06]));
    expect(events.some(({ event }) => event === 'file-complete')).toBe(true);
    expect(session.isActive()).toBe(false);
    expect(JSON.stringify(events)).not.toContain(source);
  });

  it('accepts split 1K CRC frames, ignores duplicate blocks, and keeps a hostile name inside the grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-receive-'));
    roots.push(root);
    const { session, writes, events } = fixture();
    const frame = crcFrame(1, Buffer.from('payload'), 1024);
    session.startReceive();
    session.setSavePath(root, '../outside.txt');
    session.handleData(frame.subarray(0, 1));
    session.handleData(frame.subarray(1, 250));
    expect(writes.filter((part) => part[0] === 0x06)).toHaveLength(0);
    session.handleData(frame.subarray(250));
    session.handleData(frame);
    expect(writes.filter((part) => part[0] === 0x06)).toHaveLength(2);
    session.handleData(Buffer.from([0x04]));
    await vi.waitFor(() => expect(session.isActive()).toBe(false));
    expect(await readFile(join(root, '.._outside.txt'))).toHaveLength(1024);
    expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toEqual([]);
    expect(events.some(({ event }) => event === 'file-complete')).toBe(true);
    expect(session.isActive()).toBe(false);
  });

  it('holds the EOT ACK and completion event until asynchronous publication settles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-publishing-'));
    roots.push(root);
    const writes: Buffer[] = [];
    const events: Array<Record<string, unknown>> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = new XmodemSession(
      { writeRaw: (data) => writes.push(Buffer.from(data)), write() {} },
      { s: (event) => events.push(event) },
      () => {},
      writeSync,
      async (source, destination) => {
        await gate;
        await link(source, destination);
      },
    );

    session.startReceive();
    session.setSavePath(root, 'pending.bin');
    session.handleData(crcFrame(1, Buffer.from('pending bytes')));
    session.handleData(Buffer.from([0x04]));

    expect(session.isActive()).toBe(true);
    expect(writes.filter((part) => part[0] === 0x06)).toHaveLength(1);
    expect(events.some(({ event }) => event === 'file-complete')).toBe(false);
    session.cancel();
    session.startReceive();
    session.handleData(Buffer.from([0x04]));
    expect(events.filter(({ event }) => event === 'receive-start')).toHaveLength(1);
    expect(writes.at(-1)).not.toEqual(Buffer.from([0x18, 0x18]));

    release();
    await vi.waitFor(() => expect(session.isActive()).toBe(false));
    expect(await readFile(join(root, 'pending.bin'))).toHaveLength(128);
    expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toEqual([]);
    expect(writes.filter((part) => part[0] === 0x06)).toHaveLength(2);
    expect(events.filter(({ event }) => event === 'file-complete')).toHaveLength(1);
  });

  it('holds Runtime destruction until an already-started publication has cleaned its stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-publishing-shutdown-'));
    roots.push(root);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: Array<Record<string, unknown>> = [];
    const session = new XmodemSession(
      { write: () => {} },
      { s: (event) => events.push(event) },
      () => {},
      writeSync,
      async (source, destination) => {
        await gate;
        await link(source, destination);
      },
    );
    session.startReceive();
    session.setSavePath(root, 'pending.bin');
    session.handleData(crcFrame(1, Buffer.from('pending bytes')));
    session.handleData(Buffer.from([0x04]));
    expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toHaveLength(1);

    let closed = false;
    const closing = session.destroy().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
    expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toEqual([]);
    expect(events.some(({ event }) => event === 'file-complete')).toBe(false);
  });

  it('returns the in-flight publication promise through the manager cleanup boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-manager-shutdown-'));
    roots.push(root);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const terminal = { write: () => {} };
    const socket = { s: () => {} };
    const manager = new XmodemManager(
      (managedTerminal, managedSocket, onFinish) =>
        new XmodemSession(
          managedTerminal,
          managedSocket,
          onFinish,
          writeSync,
          async (source, destination) => {
            await gate;
            await link(source, destination);
          },
        ),
    );
    manager.handleMessage('terminal', { event: 'start-receive' }, terminal, socket);
    manager.handleMessage(
      'terminal',
      { event: 'set-save-path', path: root, name: 'pending.bin' },
      terminal,
      socket,
    );
    manager.handleData('terminal', crcFrame(1, Buffer.from('pending bytes')));
    manager.handleData('terminal', Buffer.from([0x04]));

    let closed = false;
    const cleanup = manager.destroySession('terminal')?.then(() => {
      closed = true;
    });
    expect(cleanup).toBeDefined();
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await cleanup;
    expect(closed).toBe(true);
    expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('reports a denied cancellation cleanup without leaking the staged path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-cancel-denied-'));
    roots.push(root);
    const events: Array<Record<string, unknown>> = [];
    let removals = 0;
    const session = new XmodemSession(
      { write: () => {} },
      { s: (event) => events.push(event) },
      () => {},
      writeSync,
      undefined,
      (path) => {
        removals += 1;
        throw Object.assign(new Error(`Stage removal refused at ${path}`), { code: 'EACCES' });
      },
    );
    session.startReceive();
    session.setSavePath(root, 'denied.bin');
    session.handleData(crcFrame(1, Buffer.from('partial bytes')));
    session.cancel();

    expect(removals).toBe(2);
    expect(events.map(({ event }) => event)).toContain('session-error');
    expect(events.map(({ event }) => event)).toContain('session-end');
    expect(JSON.stringify(events)).not.toContain(root);
    expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toHaveLength(1);
  });

  it('propagates a denied stage cleanup to Runtime destruction with a path-free error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-destroy-denied-'));
    roots.push(root);
    const session = new XmodemSession(
      { write: () => {} },
      { s: () => {} },
      () => {},
      writeSync,
      undefined,
      (path) => {
        throw Object.assign(new Error(`Stage removal refused at ${path}`), { code: 'EACCES' });
      },
    );
    session.startReceive();
    session.setSavePath(root, 'denied.bin');
    session.handleData(crcFrame(1, Buffer.from('partial bytes')));

    const failure = (await session.destroy().catch((error: unknown) => error)) as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors[0]).toMatchObject({ code: 'EACCES' });
    expect(String(failure.errors[0])).not.toContain(root);
    expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toHaveLength(1);
  });

  it('reports XMODEM stage-removal failure through Runtime-wide transfer cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-runtime-denied-'));
    roots.push(root);
    const manager = new XmodemManager(
      (terminal, socket, onFinish) =>
        new XmodemSession(terminal, socket, onFinish, writeSync, undefined, (path) => {
          throw Object.assign(new Error(`Stage removal refused at ${path}`), {
            code: 'EACCES',
          });
        }),
    );
    const adapter = new RuntimeTerminalTransferAdapter({ xmodem: manager });
    adapter.setListener({ writeRaw: () => {}, publishRawOutput: () => {}, onEvent: () => {} });
    adapter.command('terminal', 'xmodem', { event: 'start-receive' });
    adapter.command('terminal', 'xmodem', {
      event: 'set-save-path',
      path: root,
      name: 'denied.bin',
    });
    adapter.receive('terminal', crcFrame(1, Buffer.from('partial bytes')));
    adapter.close('terminal');

    const failure = (await adapter.closeAll().catch((error: unknown) => error)) as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toHaveLength(1);
    expect(String(failure)).not.toContain(root);
    expect(String((failure.errors[0] as AggregateError).errors[0])).not.toContain(root);
    expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toHaveLength(1);
  });

  it('does not acknowledge publication when its private stage cannot be removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-publish-denied-'));
    roots.push(root);
    const events: Array<Record<string, unknown>> = [];
    const writes: Buffer[] = [];
    const session = new XmodemSession(
      { write: (data) => writes.push(Buffer.from(data)) },
      { s: (event) => events.push(event) },
      () => {},
      writeSync,
      async (source, destination) => link(source, destination),
      (path) => {
        throw Object.assign(new Error(`Stage removal refused at ${path}`), { code: 'EACCES' });
      },
    );
    session.startReceive();
    session.setSavePath(root, 'published.bin');
    session.handleData(crcFrame(1, Buffer.from('complete bytes')));
    session.handleData(Buffer.from([0x04]));

    await vi.waitFor(() => expect(session.isActive()).toBe(false));
    expect(await readFile(join(root, 'published.bin'))).toHaveLength(128);
    expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toHaveLength(1);
    expect(writes.filter((part) => part.equals(Buffer.from([0x06])))).toHaveLength(1);
    expect(events.map(({ event }) => event)).toContain('session-error');
    expect(events.map(({ event }) => event)).not.toContain('file-complete');
    expect(JSON.stringify(events)).not.toContain(root);
  });

  it('retries only its own staged name before acknowledging a published file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-remove-retry-'));
    roots.push(root);
    const events: Array<Record<string, unknown>> = [];
    let removals = 0;
    const session = new XmodemSession(
      { write: () => {} },
      { s: (event) => events.push(event) },
      () => {},
      writeSync,
      async (source, destination) => link(source, destination),
      (path) => {
        removals += 1;
        if (removals === 1)
          throw Object.assign(new Error(`Transient stage removal at ${path}`), {
            code: 'EACCES',
          });
        unlinkSync(path);
      },
    );
    session.startReceive();
    session.setSavePath(root, 'published.bin');
    session.handleData(crcFrame(1, Buffer.from('complete bytes')));
    session.handleData(Buffer.from([0x04]));

    await vi.waitFor(() => expect(session.isActive()).toBe(false));
    expect(removals).toBe(2);
    expect(await readdir(root)).toEqual(['published.bin']);
    expect(events.map(({ event }) => event)).toContain('file-complete');
    expect(events.map(({ event }) => event)).not.toContain('session-error');
  });

  it.each([
    { code: 'EIO', expectedCode: undefined },
    { code: 'ENOTSUP', expectedCode: 'TRANSFER_DESTINATION_UNSUPPORTED' },
  ])(
    'reports $code publication failure and removes its private staging file',
    async ({ code, expectedCode }) => {
      const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-publishing-error-'));
      roots.push(root);
      const writes: Buffer[] = [];
      const events: Array<Record<string, unknown>> = [];
      let rejectPublish!: (error: Error) => void;
      const gate = new Promise<void>((_resolve, reject) => {
        rejectPublish = reject;
      });
      const session = new XmodemSession(
        { writeRaw: (data) => writes.push(Buffer.from(data)), write() {} },
        { s: (event) => events.push(event) },
        () => {},
        writeSync,
        async () => gate,
      );

      session.startReceive();
      session.setSavePath(root, 'failed.bin');
      session.handleData(crcFrame(1, Buffer.from('staged bytes')));
      session.handleData(Buffer.from([0x04]));
      expect(session.isActive()).toBe(true);

      rejectPublish(Object.assign(new Error('synthetic filesystem failure'), { code }));
      await vi.waitFor(() => expect(session.isActive()).toBe(false));
      expect(await readdir(root)).toEqual([]);
      expect(writes.at(-1)).toEqual(Buffer.from([0x18, 0x18]));
      expect(events.find(({ event }) => event === 'session-error')?.errorCode).toBe(expectedCode);
      expect(events.some(({ event }) => event === 'file-complete')).toBe(false);
    },
  );

  it('does not emit late completion or clear a restarted receive after destroy during publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-publishing-destroy-'));
    roots.push(root);
    const writes: Buffer[] = [];
    const events: Array<Record<string, unknown>> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let published = false;
    const session = new XmodemSession(
      { writeRaw: (data) => writes.push(Buffer.from(data)), write() {} },
      { s: (event) => events.push(event) },
      () => {},
      writeSync,
      async (source, destination) => {
        await gate;
        await link(source, destination);
        published = true;
      },
    );

    session.startReceive();
    session.setSavePath(root, 'committing.bin');
    session.handleData(crcFrame(1, Buffer.from('old bytes')));
    session.handleData(Buffer.from([0x04]));
    const oldStaging = (await readdir(root)).find((name) => name.endsWith('.part'));
    expect(oldStaging).toBeDefined();
    session.destroy();
    session.startReceive();
    session.setSavePath(root, 'new.bin');
    session.handleData(crcFrame(1, Buffer.from('new bytes')));
    const newStaging = (await readdir(root)).find(
      (name) => name.endsWith('.part') && name !== oldStaging,
    );
    expect(newStaging).toBeDefined();

    release();
    await vi.waitFor(() => expect(published).toBe(true));
    await vi.waitFor(async () =>
      expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toEqual([newStaging]),
    );
    expect(session.isActive()).toBe(true);
    expect(events.some(({ event }) => event === 'file-complete')).toBe(false);
    expect(writes.filter((part) => part[0] === 0x06)).toHaveLength(2);
    expect(await readFile(join(root, 'committing.bin'))).toHaveLength(128);

    session.cancel();
    expect(await readdir(root)).toEqual(['committing.bin']);
  });

  it('requests retransmission for a bad CRC and discards a canceled partial file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-retry-'));
    roots.push(root);
    const { session, writes } = fixture();
    const frame = crcFrame(1, Buffer.from('recover'));
    const broken = Buffer.from(frame);
    broken[4] = broken[4]! ^ 0xff;
    session.startReceive();
    session.setSavePath(root, 'recover.bin');
    session.handleData(broken);
    expect(writes.at(-1)).toEqual(Buffer.from([0x15]));
    expect(await readdir(root)).toEqual([]);
    session.handleData(frame);
    expect((await readdir(root)).some((name) => name.endsWith('.part'))).toBe(true);
    session.cancel();
    expect(await readdir(root)).toEqual([]);
    expect(session.isActive()).toBe(false);
    expect(writes.at(-1)).toEqual(Buffer.from([0x18, 0x18]));
  });

  it('cancels a selected partial receive after the retry limit of malformed frames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-malformed-selected-'));
    roots.push(root);
    const { session, writes, events } = fixture();
    const first = crcFrame(1, Buffer.from('first packet'));
    const broken = Buffer.from(crcFrame(2, Buffer.from('corrupt packet')));
    broken[4] = broken[4]! ^ 0xff;
    session.startReceive();
    session.setSavePath(root, 'damaged.bin');
    session.handleData(first);
    expect((await readdir(root)).some((entry) => entry.endsWith('.part'))).toBe(true);
    for (let attempt = 0; attempt <= 10; attempt += 1) session.handleData(broken);
    expect(events.some(({ event }) => event === 'session-error')).toBe(true);
    expect(events.some(({ event }) => event === 'session-end')).toBe(true);
    expect(events.some(({ event }) => event === 'file-complete')).toBe(false);
    expect(session.isActive()).toBe(false);
    expect(await readdir(root)).toEqual([]);
    expect(writes.at(-1)).toEqual(Buffer.from([0x18, 0x18]));
  });

  it.each(partialWriteFailures)(
    'cancels and removes partially written output when $condition',
    async ({ code }) => {
      const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-write-failure-'));
      roots.push(root);
      const writes: Buffer[] = [];
      const events: Array<Record<string, unknown>> = [];
      let writeCalls = 0;
      let stagedBytes = 0;
      const session = new XmodemSession(
        {
          write: (data) => writes.push(Buffer.from(data)),
          writeRaw: (data) => writes.push(Buffer.from(data)),
        },
        { s: (event) => events.push(event) },
        () => {},
        (file, buffer, offset, length) => {
          writeCalls += 1;
          if (writeCalls > 1)
            throw Object.assign(new Error(`${code} after partial write`), { code });
          const written = writeSync(file, buffer, offset, Math.min(length, 64));
          stagedBytes += written;
          return written;
        },
      );

      session.startReceive();
      session.setSavePath(root, `${code.toLowerCase()}.bin`);
      session.handleData(crcFrame(1, Buffer.from('partially persisted bytes')));

      expect(stagedBytes).toBe(64);
      expect(writeCalls).toBe(2);
      expect(session.isActive()).toBe(false);
      expect(await readdir(root)).toEqual([]);
      expect(events.map(({ event }) => event)).toEqual(
        expect.arrayContaining(['session-error', 'session-end']),
      );
      expect(events.map(({ event }) => event)).not.toContain('file-complete');
      expect(writes.at(-1)).toEqual(Buffer.from([0x18, 0x18]));
    },
  );

  it.skipIf(process.platform === 'win32')(
    'cancels without publication when selected staging disappears while the peer remains open',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-staging-loss-'));
      roots.push(root);
      const { session, writes, events } = fixture();
      session.startReceive();
      session.setSavePath(root, 'lost-staging.bin');
      session.handleData(crcFrame(1, Buffer.from('first packet')));

      const staged = (await readdir(root)).find((entry) => entry.endsWith('.part'));
      expect(staged).toBeDefined();
      await unlink(join(root, staged!));

      session.handleData(crcFrame(2, Buffer.from('second packet')));
      expect(session.isActive()).toBe(true);
      session.handleData(Buffer.from([0x04]));

      await vi.waitFor(() => expect(session.isActive()).toBe(false));
      expect(session.isActive()).toBe(false);
      expect(await readdir(root)).toEqual([]);
      expect(events.map(({ event }) => event)).toEqual(
        expect.arrayContaining(['session-error', 'session-end']),
      );
      expect(events.map(({ event }) => event)).not.toContain('file-complete');
      expect(writes.at(-1)).toEqual(Buffer.from([0x18, 0x18]));
    },
  );

  it('cleans partially staged output when the Runtime destroys a selected receive while its peer remains open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-runtime-destroy-'));
    roots.push(root);
    const { session, events } = fixture();
    session.startReceive();
    session.setSavePath(root, 'interrupted.bin');
    session.handleData(crcFrame(1, Buffer.from('partially received bytes')));

    expect(events).toContainEqual(
      expect.objectContaining({ event: 'progress', type: 'download', transferred: 128 }),
    );
    expect((await readdir(root)).some((entry) => entry.endsWith('.part'))).toBe(true);

    session.destroy();

    expect(session.isActive()).toBe(false);
    expect(await readdir(root)).toEqual([]);
    expect(events.map(({ event }) => event)).not.toContain('file-complete');
    expect(events.map(({ event }) => event)).not.toContain('session-end');
  });

  it('never replaces an existing destination file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-collision-'));
    roots.push(root);
    await writeFile(join(root, 'report.bin'), 'original');
    const { session, events } = fixture();
    session.startReceive();
    session.setSavePath(root, 'report.bin');
    session.handleData(crcFrame(1, Buffer.from('incoming')));
    session.handleData(Buffer.from([0x04]));
    await vi.waitFor(() => expect(session.isActive()).toBe(false));
    expect(await readFile(join(root, 'report.bin'), 'utf8')).toBe('original');
    const saved = (await readdir(root)).find((name) => name.startsWith('report.bin.'));
    expect(saved).toBeDefined();
    expect((await readFile(join(root, saved!))).subarray(0, 8).toString()).toBe('incoming');
    expect(events.some(({ event }) => event === 'file-complete')).toBe(true);
  });

  it('reserves filesystem leaf-name bytes before adding a collision suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-long-collision-'));
    roots.push(root);
    const offeredName = `${'a'.repeat(251)}.bin`;
    await writeFile(join(root, offeredName), 'original');
    const { session, events } = fixture();
    session.startReceive();
    session.setSavePath(root, offeredName);
    session.handleData(crcFrame(1, Buffer.from('incoming')));
    session.handleData(Buffer.from([0x04]));
    await vi.waitFor(() => expect(session.isActive()).toBe(false));

    expect(await readFile(join(root, offeredName), 'utf8')).toBe('original');
    const entries = await readdir(root);
    const saved = entries.find((name) => name !== offeredName && !name.endsWith('.part'));
    expect(saved).toBeDefined();
    expect(Buffer.byteLength(saved!, 'utf8')).toBeLessThanOrEqual(255);
    expect(saved).toMatch(/\.bin\.[0-9a-f]{8}$/u);
    expect((await readFile(join(root, saved!))).subarray(0, 8).toString()).toBe('incoming');
    expect(events.some(({ event }) => event === 'file-complete')).toBe(true);
    expect(events.some(({ event }) => event === 'session-error')).toBe(false);
  });

  it('supports checksum peers and releases idle sessions after timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-checksum-'));
    roots.push(root);
    const source = join(root, 'value.bin');
    await writeFile(source, 'x');
    const { session, writes } = fixture();
    session.startSend();
    session.setSendFiles([{ path: source, name: 'value.bin', size: 1 }]);
    session.handleData(Buffer.from([0x15]));
    expect(writes[0]).toHaveLength(132);
    expect(writes[0]![131]).toBe(
      writes[0]!.subarray(3, 131).reduce((sum, value) => (sum + value) & 0xff, 0),
    );
    session.destroy();

    vi.useFakeTimers();
    const manager = new XmodemManager();
    const events: Array<Record<string, unknown>> = [];
    manager.handleMessage(
      'terminal',
      { event: 'start-send' },
      { write() {} },
      { s: (value) => events.push(value) },
    );
    expect(manager.isActive('terminal')).toBe(true);
    await vi.advanceTimersByTimeAsync(110_000);
    expect(manager.isActive('terminal')).toBe(false);
    expect(events.some(({ event }) => event === 'session-error')).toBe(true);
  });

  it('cancels a selected receive when the peer goes silent without publishing a file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-selected-timeout-'));
    roots.push(root);
    const { session, writes, events } = fixture();
    vi.useFakeTimers();
    session.startReceive();
    session.setSavePath(root, 'stalled.bin');
    await vi.advanceTimersByTimeAsync(110_000);
    expect(events.some(({ event }) => event === 'session-error')).toBe(true);
    expect(events.some(({ event }) => event === 'session-end')).toBe(true);
    expect(session.isActive()).toBe(false);
    expect(await readdir(root)).toEqual([]);
    expect(writes.at(-1)).toEqual(Buffer.from([0x18, 0x18]));
  });

  it('keeps an early peer handshake until the granted upload file is ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-early-peer-'));
    roots.push(root);
    const source = join(root, 'early.bin');
    await writeFile(source, 'ready');
    const { session, writes } = fixture();
    session.startSend();
    session.handleData(Buffer.from([0x43]));
    expect(writes).toHaveLength(0);
    session.setSendFiles([{ path: source, name: 'early.bin', size: 5 }]);
    expect(writes[0]).toHaveLength(133);
    session.destroy();
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symbolic-link upload source after selection',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'axterm-xmodem-symlink-'));
      roots.push(root);
      const source = join(root, 'secret.bin');
      const alias = join(root, 'selected.bin');
      await writeFile(source, 'secret');
      await writeFile(alias, 'public');
      const { session, writes, events } = fixture();
      session.startSend();
      session.setSendFiles([{ path: alias, name: 'selected.bin', size: 6 }]);
      await unlink(alias);
      await symlink(source, alias);
      session.handleData(Buffer.from([0x43]));
      expect(events.some(({ event }) => event === 'session-error')).toBe(true);
      expect(session.isActive()).toBe(false);
      expect(writes).toEqual([Buffer.from([0x18, 0x18])]);
    },
  );
});
