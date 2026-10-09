import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { Server as SshServer, utils, type Connection } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TerminalChannel } from '../../ports/terminal-channel';
import { NodePtyAdapter } from '../pty/node-pty-adapter';
import { Ssh2Transport } from '../ssh2/ssh2-transport';
import { TrzszSession } from './trzsz';

const execFileAsync = promisify(execFile);
const enabled = process.env.AXTERM_EXTERNAL_TRZSZ_SSH === '1';
const platform = process.env.AXTERM_EXTERNAL_PEER_PLATFORM ?? 'linux/arm64';
const image = 'debian@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251';
const peers = {
  'linux/arm64': {
    archiveName: 'trzsz_1.2.0_linux_aarch64.tar.gz',
    archiveHash: '9a73c237b6b12af267e878591ff22a01c97ca9d1cd8125f9ff4ffd6df4fea97c',
    peerDirectory: 'trzsz_1.2.0_linux_aarch64',
  },
  'linux/amd64': {
    archiveName: 'trzsz_1.2.0_linux_x86_64.tar.gz',
    archiveHash: '70e3e0847177d4c7b681a8ec19fa00092e422a6c628ef9d8a5db6dfbf4612add',
    peerDirectory: 'trzsz_1.2.0_linux_x86_64',
  },
} as const;
const peer = peers[platform as keyof typeof peers];
if (enabled && !peer)
  throw new Error(
    `Unsupported external trzsz SSH platform: ${platform}; use linux/arm64 or linux/amd64`,
  );
const selectedPeer = peer ?? peers['linux/arm64'];
const skip = !enabled || process.platform === 'win32';

let root = '';

async function command(program: string, args: string[]) {
  return execFileAsync(program, args, { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 });
}

async function provisionPeer(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'axterm-external-trzsz-ssh-'));
  const archive = join(root, selectedPeer.archiveName);
  await command('curl', [
    '--fail',
    '--location',
    '--silent',
    '--show-error',
    '--output',
    archive,
    `https://github.com/trzsz/trzsz-go/releases/download/v1.2.0/${selectedPeer.archiveName}`,
  ]);
  const actual = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  expect(actual).toBe(selectedPeer.archiveHash);
  await command('tar', ['-xzf', archive, '-C', root]);
}

async function assertNoPeerContainer(label: string): Promise<void> {
  // `docker run --rm` removes its container after the PTY process exits.
  // The SSH channel may close a moment before Docker finishes that removal.
  await vi.waitFor(
    async () => {
      const { stdout } = await command('docker', [
        'ps',
        '--all',
        '--quiet',
        '--filter',
        `label=${label}`,
      ]);
      expect(stdout.trim()).toBe('');
    },
    { timeout: 5_000, interval: 50 },
  );
}

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`External trzsz SSH ${label} timed out`)), 20_000),
    ),
  ]);
}

async function openSshPeer(
  commandText: string,
  label: string,
): Promise<{
  channel: TerminalChannel;
  close(): Promise<void>;
}> {
  const peers = new Set<TerminalChannel>();
  const connections = new Set<Connection>();
  const server = new SshServer(
    { hostKeys: [utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
    (connection) => {
      connections.add(connection);
      connection.once('close', () => connections.delete(connection));
      connection.on('authentication', (context) => {
        if (context.method === 'none') context.accept();
        else context.reject(['none']);
      });
      connection.on('ready', () => {
        connection.on('session', (acceptSession) => {
          const session = acceptSession();
          session.on('pty', (acceptPty) => acceptPty?.());
          session.on('shell', (acceptShell) => {
            const stream = acceptShell();
            const peer = new NodePtyAdapter().open({
              shell: 'docker',
              args: [
                'run',
                '--rm',
                '--pull=never',
                '--platform',
                platform,
                '--network',
                'none',
                '--interactive',
                '--tty',
                '--label',
                label,
                '--volume',
                `${root}:/peer`,
                image,
                'sh',
                '-ceu',
                commandText,
              ],
              cwd: root,
              env: {},
              term: 'xterm-256color',
              loginShell: false,
              cols: 80,
              rows: 24,
            });
            peers.add(peer);
            peer.onData((data) => stream.write(Buffer.from(data)));
            peer.onExit((code) => {
              peers.delete(peer);
              if (!stream.destroyed) {
                stream.exit(code ?? 1);
                stream.end();
              }
            });
            stream.on('data', (data: Buffer) => peer.write(data));
            stream.once('close', () => void peer.close());
          });
        });
      });
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error('External trzsz SSH test server did not bind');
  }
  let handle: Awaited<ReturnType<Ssh2Transport['connect']>> | undefined;
  let channel: TerminalChannel | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await channel?.close().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    for (const peer of peers) await peer.close().catch(() => undefined);
    for (const connection of connections) connection.end();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  };
  try {
    handle = await new Ssh2Transport().connect({
      host: '127.0.0.1',
      port: address.port,
      username: 'operator',
      connectionTimeoutMs: 10_000,
      keepaliveIntervalMs: 0,
      keepaliveCountMax: 0,
      compression: false,
      algorithms: { kex: [], cipher: [], serverHostKey: [], hmac: [] },
      verifyHostKey: async () => true,
      keyboardInteractive: async () => [],
    });
    channel = await handle.openShell({ cols: 80, rows: 24, term: 'xterm-256color', env: {} });
    return { channel, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function transfer(direction: 'download' | 'upload'): Promise<void> {
  const transferDirectory = `transfer-${direction}`;
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'incoming'), { recursive: true });
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  const bytes = Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.alloc(16_384, 0xa5)]);
  await writeFile(source, bytes);
  const label = `axterm.external-trzsz-ssh=${randomUUID()}`;
  const peerCommand =
    direction === 'download' ? 'tsz /peer/transfer-download/outgoing/source.bin' : 'trz';
  const commandText =
    direction === 'download'
      ? `exec /peer/${selectedPeer.peerDirectory}/${peerCommand}`
      : `cd /peer/transfer-upload/incoming\nexec /peer/${selectedPeer.peerDirectory}/${peerCommand}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: TrzszSession | undefined;
  try {
    fixture = await openSshPeer(commandText, label);
    const events: string[] = [];
    const ordinary: Buffer[] = [];
    session = new TrzszSession(
      { write: (data) => fixture?.channel.write(data) },
      {
        s: (message) => {
          events.push(String(message.event));
          if (message.event === 'receive-start')
            session?.handleMessage({ event: 'set-save-path', path: downloads });
          if (message.event === 'send-start')
            session?.handleMessage({ event: 'send-files', files: [{ path: source }] });
        },
      },
    );
    const transfer = session;
    disposeData = fixture.channel.onData((data) => {
      if (!transfer.handleData(data)) ordinary.push(Buffer.from(data));
    });
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    await vi.waitFor(
      () => expect(events).toContain(direction === 'download' ? 'receive-start' : 'send-start'),
      { timeout: 8_000 },
    );
    expect(
      await withDeadline(exited, `${direction} transfer`),
      Buffer.concat(ordinary).toString('utf8'),
    ).toBe(0);
    expect(events).toContain('session-complete');
    expect(transfer.isActive()).toBe(false);
    const result =
      direction === 'download'
        ? await readFile(join(downloads, 'source.bin'))
        : await readFile(join(transferRoot, 'incoming', 'source.bin'));
    expect(result).toEqual(bytes);
  } finally {
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function cancelDownload(): Promise<void> {
  const transferDirectory = 'transfer-cancel';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  await writeFile(source, Buffer.alloc(16_384, 0xa5));
  const label = `axterm.external-trzsz-ssh=${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: TrzszSession | undefined;
  try {
    fixture = await openSshPeer(
      `exec /peer/${selectedPeer.peerDirectory}/tsz /peer/${transferDirectory}/outgoing/source.bin`,
      label,
    );
    const events: string[] = [];
    session = new TrzszSession(
      { write: (data) => fixture?.channel.write(data) },
      {
        s: (message) => {
          events.push(String(message.event));
          if (message.event === 'receive-start') session?.handleMessage({ event: 'cancel' });
        },
      },
    );
    const transfer = session;
    disposeData = fixture.channel.onData((data) => transfer.handleData(data));
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    await vi.waitFor(() => expect(events).toContain('receive-start'), { timeout: 8_000 });
    expect(await withDeadline(exited, 'download cancellation')).toBe(0);
    await vi.waitFor(() => expect(events).toContain('session-end'), { timeout: 8_000 });
    expect(transfer.isActive()).toBe(false);
    await expect(readFile(join(downloads, 'source.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function cancelUpload(): Promise<void> {
  const transferDirectory = 'transfer-upload-cancel';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const incoming = join(transferRoot, 'incoming');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(incoming);
  await writeFile(source, Buffer.alloc(16_384, 0xa5));
  const label = `axterm.external-trzsz-ssh=${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: TrzszSession | undefined;
  try {
    fixture = await openSshPeer(
      `cd /peer/${transferDirectory}/incoming\nexec /peer/${selectedPeer.peerDirectory}/trz`,
      label,
    );
    const events: string[] = [];
    session = new TrzszSession(
      { write: (data) => fixture?.channel.write(data) },
      {
        s: (message) => {
          events.push(String(message.event));
          if (message.event === 'send-start') session?.handleMessage({ event: 'cancel' });
        },
      },
    );
    const transfer = session;
    disposeData = fixture.channel.onData((data) => transfer.handleData(data));
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    await vi.waitFor(() => expect(events).toContain('send-start'), { timeout: 8_000 });
    expect(await withDeadline(exited, 'upload cancellation')).toBe(0);
    await vi.waitFor(() => expect(events).toContain('session-end'), { timeout: 8_000 });
    expect(transfer.isActive()).toBe(false);
    await expect(readFile(join(incoming, 'source.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function selectionTimeout(): Promise<void> {
  const transferDirectory = 'transfer-selection-timeout';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  await writeFile(source, Buffer.alloc(16_384, 0xa5));
  const label = `axterm.external-trzsz-ssh=${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: TrzszSession | undefined;
  let fakeTimers = false;
  try {
    fixture = await openSshPeer(
      `exec /peer/${selectedPeer.peerDirectory}/tsz /peer/${transferDirectory}/outgoing/source.bin`,
      label,
    );
    const handshake = new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      disposeData = fixture?.channel.onData((data) => {
        chunks.push(Buffer.from(data));
        const received = Buffer.concat(chunks);
        if (received.includes(Buffer.from('::TRZSZ:TRANSFER:'))) {
          disposeData?.();
          disposeData = undefined;
          resolve(received);
        }
      });
    });
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    const received = await withDeadline(handshake, 'selection-timeout handshake');
    const events: string[] = [];
    vi.useFakeTimers();
    fakeTimers = true;
    session = new TrzszSession(
      { write: (data) => fixture?.channel.write(data) },
      { s: (message) => events.push(String(message.event)) },
    );
    expect(session.handleData(received)).toBe(true);
    expect(events).toContain('receive-start');
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();
    fakeTimers = false;
    await vi.waitFor(() => expect(events).toContain('session-timeout'), { timeout: 8_000 });
    await vi.waitFor(() => expect(events).toContain('session-end'), { timeout: 8_000 });
    expect(session.isActive()).toBe(false);
    expect(await readdir(downloads)).toEqual([]);
    expect(await withDeadline(exited, 'selection-timeout cancellation')).toBe(0);
  } finally {
    if (fakeTimers) vi.useRealTimers();
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function selectedPeerExit(): Promise<void> {
  const transferDirectory = 'transfer-selected-peer-exit';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  await writeFile(source, Buffer.alloc(32 * 1024 * 1024, 0xa5));
  const label = `axterm.external-trzsz-ssh=${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let disposeExit: (() => void) | undefined;
  let session: TrzszSession | undefined;
  try {
    fixture = await openSshPeer(
      `exec /peer/${selectedPeer.peerDirectory}/tsz /peer/${transferDirectory}/outgoing/source.bin`,
      label,
    );
    const events: string[] = [];
    let fileStarted: (() => void) | undefined;
    const fileStartedPromise = new Promise<void>((resolve) => {
      fileStarted = resolve;
    });
    session = new TrzszSession(
      { write: (data) => fixture?.channel.write(data) },
      {
        s: (message) => {
          const event = String(message.event);
          events.push(event);
          if (event === 'receive-start')
            session?.handleMessage({ event: 'set-save-path', path: downloads });
          if (event === 'file-start') {
            fileStarted?.();
            fileStarted = undefined;
          }
        },
      },
    );
    const transfer = session;
    disposeData = fixture.channel.onData((data) => transfer.handleData(data));
    disposeExit = fixture.channel.onExit(() => transfer.destroy());
    await withDeadline(fileStartedPromise, 'selected-peer file start');
    await vi.waitFor(
      async () => {
        const staged = (await readdir(downloads)).filter((entry) => entry.endsWith('.part'));
        expect(staged).toHaveLength(1);
        expect((await stat(join(downloads, staged[0]!))).size).toBeGreaterThan(0);
      },
      { timeout: 8_000 },
    );
    await fixture.close();
    await vi.waitFor(() => expect(transfer.isActive()).toBe(false), { timeout: 8_000 });
    await vi.waitFor(async () => expect(await readdir(downloads)).toEqual([]), { timeout: 8_000 });
    expect(events).toContain('file-start');
  } finally {
    disposeData?.();
    disposeExit?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function selectedMalformedFrame(): Promise<void> {
  const transferDirectory = 'transfer-selected-malformed-frame';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  // Keep a real external transfer in flight long enough to establish a
  // selected nonempty staging file before the transport fault is injected.
  await writeFile(source, Buffer.alloc(32 * 1024 * 1024, 0xa5));
  const label = `axterm.external-trzsz-ssh=${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: TrzszSession | undefined;
  try {
    fixture = await openSshPeer(
      `exec /peer/${selectedPeer.peerDirectory}/tsz /peer/${transferDirectory}/outgoing/source.bin`,
      label,
    );
    const events: string[] = [];
    let corruptFrames = false;
    let corruptedFrames = 0;
    session = new TrzszSession(
      { write: (data) => fixture?.channel.write(data) },
      {
        s: (message) => {
          const event = String(message.event);
          events.push(event);
          if (event === 'receive-start')
            session?.handleMessage({ event: 'set-save-path', path: downloads });
        },
      },
    );
    const transfer = session;
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    disposeData = fixture.channel.onData((data) => {
      const peerFrame = Buffer.from(data);
      if (corruptFrames) {
        const dataMarker = peerFrame.indexOf(Buffer.from('#DATA:'));
        const payloadOffset = dataMarker + Buffer.byteLength('#DATA:');
        if (dataMarker >= 0 && payloadOffset < peerFrame.length) {
          // Alter one encoded payload character but leave the real trzsz-go
          // peer, SSH channel and PTY open. The Runtime must reject this
          // controlled in-transit frame, send cancellation and clear staging.
          peerFrame[payloadOffset] = peerFrame[payloadOffset] === 0x41 ? 0x42 : 0x41;
          corruptedFrames += 1;
        }
      }
      transfer.handleData(peerFrame);
    });
    await vi.waitFor(
      async () => {
        expect(events).toContain('file-start');
        const staged = (await readdir(downloads)).filter((entry) => entry.endsWith('.part'));
        expect(staged).toHaveLength(1);
        expect((await stat(join(downloads, staged[0]!))).size).toBeGreaterThan(0);
      },
      { timeout: 8_000 },
    );
    corruptFrames = true;
    await vi.waitFor(
      () => expect(events).toEqual(expect.arrayContaining(['session-error', 'session-end'])),
      { timeout: 12_000 },
    );
    expect(corruptedFrames).toBeGreaterThan(0);
    expect(transfer.isActive()).toBe(false);
    expect(await readdir(downloads)).toEqual([]);
    expect(await withDeadline(exited, 'selected malformed-frame cancellation')).toBe(0);
  } finally {
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

describe.skipIf(skip)(`independent trzsz-go peer through ${platform} SSH PTY`, () => {
  beforeAll(provisionPeer, 45_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('downloads TRZSZ binary bytes from the external tsz peer through SSH', async () => {
    await transfer('download');
  });

  it('uploads TRZSZ binary bytes to the external trz peer through SSH', async () => {
    await transfer('upload');
  });

  it('cancels an external tsz download through SSH without publishing a file', async () => {
    await cancelDownload();
  });

  it('cancels an upload to the external trz peer through SSH without publishing a file', async () => {
    await cancelUpload();
  });

  it('times out an external tsz handshake through SSH without leaving a live session', async () => {
    await selectionTimeout();
  });

  it('cleans a partially staged selected tsz download when the SSH peer exits', async () => {
    await selectedPeerExit();
  });

  it('cancels a selected external tsz transfer after malformed frames while its peer stays open', async () => {
    await selectedMalformedFrame();
  });
});
