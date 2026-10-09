import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { Server as SshServer, utils, type Connection } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TerminalChannel } from '../../ports/terminal-channel';
import { NodePtyAdapter } from '../pty/node-pty-adapter';
import { Ssh2Transport } from '../ssh2/ssh2-transport';
import { XmodemSession } from './xmodem';
import { ZmodemSession } from './zmodem';

const execFileAsync = promisify(execFile);
const enabled = process.env.AXTERM_EXTERNAL_LRZSZ_SSH === '1';
const platform = process.env.AXTERM_EXTERNAL_PEER_PLATFORM ?? 'linux/arm64';
const image = 'debian@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251';
const peers = {
  'linux/arm64': {
    packageName: 'lrzsz_0.12.21-10_arm64.deb',
    packageVersion: '0.12.21-10',
    packageHash: 'e2935271e50ca6d53cd6b6daa2a7251aad136e8b2b193aedbf4570eaf3dc5c31',
  },
  'linux/amd64': {
    packageName: 'lrzsz_0.12.21-10+b1_amd64.deb',
    packageVersion: '0.12.21-10+b1',
    packageHash: '60c15258a977b837671f99f60a7876b1dfa7cebd9ed1a7dcd16d922b6e1b9cfe',
  },
} as const;
const peer = peers[platform as keyof typeof peers];
if (enabled && !peer)
  throw new Error(
    `Unsupported external lrzsz SSH platform: ${platform}; use linux/arm64 or linux/amd64`,
  );
const selectedPeer = peer ?? peers['linux/arm64'];
const skip = !enabled || process.platform === 'win32';
const preprovisionedPackage = process.env.AXTERM_EXTERNAL_LRZSZ_DEB?.trim();
const zmodemHeaderPrefix = Buffer.from([0x2a, 0x2a, 0x18, 0x42]);

let root = '';

async function docker(args: string[]) {
  return execFileAsync('docker', args, { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 });
}

async function provisionPeer(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'axterm-external-lrzsz-ssh-'));
  const packagePath = join(root, selectedPeer.packageName);
  if (preprovisionedPackage) {
    // A release operator may supply a separately acquired Debian package when
    // the disposable container cannot fetch the APT index in its bounded
    // network window. The same pinned SHA-256 remains mandatory before this
    // external peer ever reaches the product's SSH transport.
    await copyFile(preprovisionedPackage, packagePath);
  } else {
    await docker([
      'run',
      '--rm',
      '--pull=never',
      '--platform',
      platform,
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=16m',
      '--tmpfs',
      '/var/lib/apt/lists:rw,noexec,nosuid,size=32m',
      '--tmpfs',
      '/var/cache/apt:rw,noexec,nosuid,size=16m',
      '--tmpfs',
      '/var/log:rw,noexec,nosuid,size=4m',
      '--network',
      'bridge',
      '--volume',
      `${root}:/peer`,
      image,
      'sh',
      '-ceu',
      [
        'apt-get update -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 -o Acquire::Retries=0 -o Acquire::Languages=none',
        'cd /peer',
        `apt-get download lrzsz=${selectedPeer.packageVersion}`,
      ].join('\n'),
    ]);
  }
  const actual = createHash('sha256')
    .update(await readFile(packagePath))
    .digest('hex');
  expect(actual).toBe(selectedPeer.packageHash);
}

async function assertNoPeerContainer(label: string): Promise<void> {
  let remaining = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    ({ stdout: remaining } = await docker([
      'ps',
      '--all',
      '--quiet',
      '--filter',
      `label=${label}`,
    ]));
    if (!remaining.trim()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  expect(remaining.trim()).toBe('');
}

async function stopPeerContainer(label: string): Promise<void> {
  const { stdout } = await docker(['ps', '--all', '--quiet', '--filter', `label=${label}`]);
  const identifiers = stdout.split(/\s+/u).filter(Boolean);
  if (identifiers.length === 0) throw new Error(`External peer container ${label} is not running`);
  await docker(['kill', ...identifiers]);
}

async function stopPeerContainerIfRunning(label: string): Promise<void> {
  const { stdout } = await docker(['ps', '--all', '--quiet', '--filter', `label=${label}`]);
  const identifiers = stdout.split(/\s+/u).filter(Boolean);
  if (identifiers.length === 0) return;
  // An `--rm` container may finish between `ps` and `kill`; the subsequent
  // assertion is authoritative and still fails if a peer remains.
  await docker(['kill', ...identifiers]).catch(() => undefined);
}

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`External lrzsz SSH ${label} timed out`)), 20_000),
    ),
  ]);
}

async function openSshPeer(
  command: string,
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
                `dpkg --install /peer/${selectedPeer.packageName} >/dev/null\n${command}`,
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
    throw new Error('External lrzsz SSH test server did not bind');
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

async function zmodemTransfer(direction: 'download' | 'upload'): Promise<void> {
  const transferDirectory = `zmodem-${direction}`;
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'incoming'), { recursive: true });
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  const bytes = Buffer.concat([Buffer.from([0, 255, 1, 13, 10]), Buffer.alloc(16_384, 0xa5)]);
  await writeFile(source, bytes);
  const label = `axterm.external-lrzsz-ssh=${randomUUID()}`;
  const command =
    direction === 'download'
      ? `exec sz --binary --quiet /peer/${transferDirectory}/outgoing/source.bin`
      : `cd /peer/${transferDirectory}/incoming\nexec rz --binary --quiet --overwrite`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: ZmodemSession | undefined;
  try {
    fixture = await openSshPeer(command, label);
    const events: string[] = [];
    const ordinary: Buffer[] = [];
    session = new ZmodemSession(
      { write: (data) => fixture?.channel.write(data) },
      {
        s: (message) => {
          events.push(String(message.event));
          if (message.event === 'receive-start')
            session?.handleMessage({ event: 'set-save-path', path: downloads });
          if (message.event === 'send-start')
            session?.handleMessage({ event: 'send-files', files: [{ path: source }] });
        },
        send: (data) => ordinary.push(Buffer.from(data)),
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

async function zmodemReceiveCancel(): Promise<void> {
  const transferDirectory = 'zmodem-cancel';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  await writeFile(source, Buffer.alloc(16_384, 0xa5));
  const label = `axterm.external-lrzsz-ssh=${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: ZmodemSession | undefined;
  try {
    fixture = await openSshPeer(
      `exec sz --binary --quiet /peer/${transferDirectory}/outgoing/source.bin`,
      label,
    );
    const events: string[] = [];
    session = new ZmodemSession(
      { write: (data) => fixture?.channel.write(data) },
      {
        s: (message) => {
          events.push(String(message.event));
          if (message.event === 'receive-start') session?.handleMessage({ event: 'cancel' });
        },
        send: () => undefined,
      },
    );
    const transfer = session;
    disposeData = fixture.channel.onData((data) => transfer.handleData(data));
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    await vi.waitFor(() => expect(events).toContain('receive-start'), { timeout: 8_000 });
    expect(await withDeadline(exited, 'download cancellation')).not.toBe(0);
    expect(events).toContain('session-end');
    expect(transfer.isActive()).toBe(false);
    await expect(readFile(join(downloads, 'source.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function zmodemUploadCancel(): Promise<void> {
  const transferDirectory = 'zmodem-upload-cancel';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const incoming = join(transferRoot, 'incoming');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(incoming);
  await writeFile(source, Buffer.alloc(16_384, 0xa5));
  const label = `axterm.external-lrzsz-ssh=${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: ZmodemSession | undefined;
  try {
    fixture = await openSshPeer(
      `cd /peer/${transferDirectory}/incoming\nexec rz --binary --quiet`,
      label,
    );
    const events: string[] = [];
    session = new ZmodemSession(
      { write: (data) => fixture?.channel.write(data) },
      {
        s: (message) => {
          events.push(String(message.event));
          if (message.event === 'send-start') session?.handleMessage({ event: 'cancel' });
        },
        send: () => undefined,
      },
    );
    const transfer = session;
    disposeData = fixture.channel.onData((data) => transfer.handleData(data));
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    await vi.waitFor(() => expect(events).toContain('send-start'), { timeout: 8_000 });
    expect(await withDeadline(exited, 'upload cancellation')).not.toBe(0);
    expect(events).toContain('session-end');
    expect(transfer.isActive()).toBe(false);
    await expect(readFile(join(incoming, 'source.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function zmodemSelectionTimeout(): Promise<void> {
  const transferDirectory = 'zmodem-selection-timeout';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  await writeFile(source, Buffer.alloc(16_384, 0xa5));
  const label = `axterm.external-lrzsz-ssh=${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let primer: ZmodemSession | undefined;
  let session: ZmodemSession | undefined;
  let fakeTimers = false;
  try {
    fixture = await openSshPeer(
      `exec sz --binary --quiet /peer/${transferDirectory}/outgoing/source.bin`,
      label,
    );
    const chunks: Buffer[] = [];
    const primerEvents: string[] = [];
    primer = new ZmodemSession(
      { write: (data) => fixture?.channel.write(data) },
      { s: (message) => primerEvents.push(String(message.event)), send: () => undefined },
    );
    disposeData = fixture.channel.onData((data) => {
      chunks.push(Buffer.from(data));
      primer?.handleData(data);
    });
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    await vi.waitFor(() => expect(primerEvents).toContain('receive-start'), { timeout: 8_000 });
    primer.destroy();
    primer = undefined;
    disposeData?.();
    disposeData = undefined;
    const received = Buffer.concat(chunks);
    expect(received.indexOf(zmodemHeaderPrefix)).toBeGreaterThanOrEqual(0);
    const events: string[] = [];
    vi.useFakeTimers();
    fakeTimers = true;
    session = new ZmodemSession(
      { write: (data) => fixture?.channel.write(data) },
      { s: (message) => events.push(String(message.event)), send: () => undefined },
    );
    expect(session.handleData(received)).toBe(true);
    expect(events).toContain('receive-start');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toContain('session-timeout');
    expect(events).toContain('session-end');
    expect(session.isActive()).toBe(false);
    expect(await readdir(downloads)).toEqual([]);
    vi.useRealTimers();
    fakeTimers = false;
    expect(await withDeadline(exited, 'selection-timeout cancellation')).not.toBe(0);
  } finally {
    if (fakeTimers) vi.useRealTimers();
    disposeData?.();
    primer?.destroy();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function zmodemSelectedPeerTimeout(): Promise<void> {
  const transferDirectory = 'zmodem-selected-peer-timeout';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  await writeFile(source, Buffer.alloc(16_384, 0xa5));
  const label = `axterm.external-lrzsz-ssh=${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: ZmodemSession | undefined;
  let fakeTimers = false;
  try {
    fixture = await openSshPeer(
      `exec sz --binary --quiet /peer/${transferDirectory}/outgoing/source.bin`,
      label,
    );
    const events: string[] = [];
    let selectionStarted: (() => void) | undefined;
    const selectionStartedPromise = new Promise<void>((resolve) => {
      selectionStarted = resolve;
    });
    session = new ZmodemSession(
      {
        write: (data) => {
          selectionStarted?.();
          selectionStarted = undefined;
          fixture?.channel.write(data);
        },
      },
      { s: (message) => events.push(String(message.event)), send: () => undefined },
    );
    const transfer = session;
    let forwardPeerData = true;
    disposeData = fixture.channel.onData((data) => {
      if (forwardPeerData) transfer.handleData(data);
    });
    await vi.waitFor(() => expect(events).toContain('receive-start'), { timeout: 8_000 });
    forwardPeerData = false;
    transfer.handleMessage({ event: 'set-save-path', path: downloads });
    await withDeadline(selectionStartedPromise, 'selected-peer transfer startup');

    // Keep draining the SSH channel while deliberately withholding later
    // frames from the Axterm protocol engine. A transport that loses incoming
    // transfer frames must not retain an active local transfer or publish a
    // partial destination; fixture shutdown owns the unreachable peer.
    disposeData = fixture.channel.onData(() => undefined);

    // The remote `sz` peer has received the Axterm receiver response, but its
    // subsequent protocol data is deliberately withheld. Advancing the session
    // clock must cancel the now-selected transfer and leave no published file.
    vi.useFakeTimers();
    fakeTimers = true;
    transfer.handleData(Buffer.alloc(0));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toContain('session-timeout');
    expect(events).toContain('session-end');
    expect(transfer.isActive()).toBe(false);
    expect(await readdir(downloads)).toEqual([]);
    vi.useRealTimers();
    fakeTimers = false;
  } finally {
    if (fakeTimers) vi.useRealTimers();
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function zmodemSelectedPeerExit(): Promise<void> {
  const transferDirectory = 'zmodem-selected-peer-exit';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  await writeFile(source, Buffer.alloc(32 * 1024 * 1024, 0xa5));
  const label = `axterm.external-lrzsz-ssh=${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let disposeExit: (() => void) | undefined;
  let session: ZmodemSession | undefined;
  try {
    fixture = await openSshPeer(
      `exec sz --binary --quiet /peer/${transferDirectory}/outgoing/source.bin`,
      label,
    );
    const events: string[] = [];
    let fileStarted: (() => void) | undefined;
    const fileStartedPromise = new Promise<void>((resolve) => {
      fileStarted = resolve;
    });
    session = new ZmodemSession(
      { write: (data) => fixture?.channel.write(data) },
      {
        s: (message) => {
          const event = String(message.event);
          events.push(event);
          if (event === 'file-start') {
            fileStarted?.();
            fileStarted = undefined;
          }
        },
        send: () => undefined,
      },
    );
    const transfer = session;
    disposeData = fixture.channel.onData((data) => transfer.handleData(data));
    disposeExit = fixture.channel.onExit(() => transfer.destroy());
    await vi.waitFor(() => expect(events).toContain('receive-start'), { timeout: 8_000 });
    transfer.handleMessage({ event: 'set-save-path', path: downloads });
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
    // The deliberate SSH/PTY disconnect can kill the local `docker run` CLI
    // before Docker tears down its container. Reclaim only this fixture's
    // unique labelled peer after checking the product's stage cleanup above.
    await stopPeerContainerIfRunning(label);
    await assertNoPeerContainer(label);
  }
}

async function zmodemSelectedMalformedFrame(): Promise<void> {
  const transferDirectory = 'zmodem-selected-malformed-frame';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  // A sufficiently large source prevents a fast native peer from finishing
  // before the test has proved that selected staging is already in progress.
  await writeFile(source, Buffer.alloc(32 * 1024 * 1024, 0xa5));
  const label = `axterm.external-lrzsz-ssh=${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: ZmodemSession | undefined;
  try {
    fixture = await openSshPeer(
      `exec sz --binary --quiet /peer/${transferDirectory}/outgoing/source.bin`,
      label,
    );
    const events: string[] = [];
    let corruptFrames = false;
    let corruptedFrames = 0;
    session = new ZmodemSession(
      { write: (data) => fixture?.channel.write(data) },
      {
        s: (message) => {
          const event = String(message.event);
          events.push(event);
          if (event === 'receive-start')
            session?.handleMessage({ event: 'set-save-path', path: downloads });
        },
        send: () => undefined,
      },
    );
    const transfer = session;
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    disposeData = fixture.channel.onData((data) => {
      const peerFrame = Buffer.from(data);
      if (corruptFrames && peerFrame.length > 0) {
        // Preserve the actual Debian `sz` peer and encrypted SSH/PTY route,
        // but damage later protocol bytes in transit. The product must reject
        // that input, cancel the still-running peer and remove its staging.
        peerFrame[Math.floor(peerFrame.length / 2)]! ^= 0x01;
        corruptedFrames += 1;
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
    // Staging has received real bytes. Only now corrupt subsequent external
    // peer frames, so the assertion covers partial-file cleanup rather than
    // a handshake or destination-selection failure.
    corruptFrames = true;
    await vi.waitFor(
      () => expect(events).toEqual(expect.arrayContaining(['transfer-error', 'session-end'])),
      { timeout: 12_000 },
    );
    expect(corruptedFrames).toBeGreaterThan(0);
    expect(transfer.isActive()).toBe(false);
    expect(await readdir(downloads)).toEqual([]);
    expect(await withDeadline(exited, 'selected ZMODEM malformed-frame cancellation')).not.toBe(0);
  } finally {
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function xmodemTransfer(direction: 'download' | 'upload'): Promise<void> {
  const transferDirectory = `xmodem-${direction}`;
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'incoming'), { recursive: true });
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  const bytes = Buffer.concat([Buffer.from([0, 255, 1, 13, 10]), Buffer.alloc(16_379, 0xa5)]);
  await writeFile(source, bytes);
  const label = `axterm.external-lrzsz-ssh=${randomUUID()}`;
  const command =
    direction === 'download'
      ? `exec sx --binary --quiet --1k /peer/${transferDirectory}/outgoing/source.bin`
      : `cd /peer/${transferDirectory}/incoming\nexec rx --binary --quiet upload.bin`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: XmodemSession | undefined;
  try {
    fixture = await openSshPeer(command, label);
    const events: string[] = [];
    const ordinary: Buffer[] = [];
    session = new XmodemSession(
      { write: (data) => fixture?.channel.write(data) },
      { s: (message) => events.push(String(message.event)) },
    );
    const transfer = session;
    disposeData = fixture.channel.onData((data) => {
      ordinary.push(Buffer.from(data));
      transfer.handleData(data);
    });
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    if (direction === 'download') {
      transfer.startReceive();
      transfer.setSavePath(downloads, 'download.bin');
    } else {
      transfer.startSend();
      transfer.setSendFiles([{ path: source, name: 'source.bin', size: bytes.length }]);
    }
    expect(
      await withDeadline(exited, `XMODEM ${direction} transfer`),
      Buffer.concat(ordinary).toString('utf8'),
    ).toBe(0);
    expect(events).toContain('file-complete');
    expect(transfer.isActive()).toBe(false);
    const result =
      direction === 'download'
        ? await readFile(join(downloads, 'download.bin'))
        : await readFile(join(transferRoot, 'incoming', 'upload.bin'));
    expect(result).toEqual(bytes);
  } finally {
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function xmodemReceiveCancel(): Promise<void> {
  const transferDirectory = 'xmodem-cancel';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  await writeFile(source, Buffer.alloc(16_384, 0xa5));
  const label = `axterm.external-lrzsz-ssh=${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: XmodemSession | undefined;
  try {
    fixture = await openSshPeer(
      `exec sx --binary --quiet --1k /peer/${transferDirectory}/outgoing/source.bin`,
      label,
    );
    const events: string[] = [];
    session = new XmodemSession(
      { write: (data) => fixture?.channel.write(data) },
      {
        s: (message) => {
          events.push(String(message.event));
          if (message.event === 'file-start') session?.cancel();
        },
      },
    );
    const transfer = session;
    disposeData = fixture.channel.onData((data) => transfer.handleData(data));
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    transfer.startReceive();
    transfer.setSavePath(downloads, 'download.bin');
    expect(await withDeadline(exited, 'XMODEM download cancellation')).not.toBe(0);
    expect(events).toContain('file-start');
    expect(events).toContain('session-end');
    expect(transfer.isActive()).toBe(false);
    await expect(readFile(join(downloads, 'download.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function xmodemUploadCancel(): Promise<void> {
  const transferDirectory = 'xmodem-upload-cancel';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const incoming = join(transferRoot, 'incoming');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(incoming);
  await writeFile(source, Buffer.alloc(16_384, 0xa5));
  const label = `axterm.external-lrzsz-ssh=${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: XmodemSession | undefined;
  try {
    fixture = await openSshPeer(
      `cd /peer/${transferDirectory}/incoming\nexec rx --binary --quiet upload.bin`,
      label,
    );
    const events: string[] = [];
    session = new XmodemSession(
      { write: (data) => fixture?.channel.write(data) },
      {
        s: (message) => {
          events.push(String(message.event));
          if (message.event === 'file-start') session?.cancel();
        },
      },
    );
    const transfer = session;
    disposeData = fixture.channel.onData((data) => transfer.handleData(data));
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    transfer.startSend();
    transfer.setSendFiles([{ path: source, name: 'source.bin', size: 16_384 }]);
    expect(await withDeadline(exited, 'XMODEM upload cancellation')).not.toBe(0);
    expect(events).toContain('file-start');
    expect(events).toContain('session-end');
    expect(transfer.isActive()).toBe(false);
    await expect(readFile(join(incoming, 'upload.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function xmodemSelectionTimeout(): Promise<void> {
  const transferDirectory = 'xmodem-selection-timeout';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  await writeFile(source, Buffer.alloc(16_384, 0xa5));
  const label = `axterm.external-lrzsz-ssh=${randomUUID()}`;
  const readyMarker = Buffer.from('axterm-xmodem-peer-ready');
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: XmodemSession | undefined;
  let fakeTimers = false;
  try {
    fixture = await openSshPeer(
      `printf '${readyMarker.toString('utf8')}'\nexec sx --binary --quiet --1k /peer/${transferDirectory}/outgoing/source.bin`,
      label,
    );
    const ready = new Promise<void>((resolve) => {
      const chunks: Buffer[] = [];
      disposeData = fixture?.channel.onData((data) => {
        chunks.push(Buffer.from(data));
        if (Buffer.concat(chunks).indexOf(readyMarker) >= 0) {
          disposeData?.();
          disposeData = undefined;
          resolve();
        }
      });
    });
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    await withDeadline(ready, 'XMODEM selection-timeout peer startup');
    const events: string[] = [];
    vi.useFakeTimers();
    fakeTimers = true;
    session = new XmodemSession(
      { write: (data) => fixture?.channel.write(data) },
      { s: (message) => events.push(String(message.event)) },
    );
    session.startReceive();
    await vi.advanceTimersByTimeAsync(110_000);
    expect(events).toContain('session-error');
    expect(events).toContain('session-end');
    expect(session.isActive()).toBe(false);
    expect(await readdir(downloads)).toEqual([]);
    vi.useRealTimers();
    fakeTimers = false;
    expect(await withDeadline(exited, 'XMODEM selection-timeout cancellation')).not.toBe(0);
  } finally {
    if (fakeTimers) vi.useRealTimers();
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function xmodemSelectedPeerTimeout(): Promise<void> {
  const transferDirectory = 'xmodem-selected-peer-timeout';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  await writeFile(source, Buffer.alloc(16_384, 0xa5));
  const label = `axterm.external-lrzsz-ssh=${randomUUID()}`;
  const readyMarker = Buffer.from('axterm-xmodem-selected-peer-ready');
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: XmodemSession | undefined;
  let fakeTimers = false;
  try {
    fixture = await openSshPeer(
      `printf '${readyMarker.toString('utf8')}'\nexec sx --binary --quiet --1k /peer/${transferDirectory}/outgoing/source.bin`,
      label,
    );
    const ready = new Promise<void>((resolve) => {
      const chunks: Buffer[] = [];
      disposeData = fixture?.channel.onData((data) => {
        chunks.push(Buffer.from(data));
        if (Buffer.concat(chunks).indexOf(readyMarker) >= 0) {
          disposeData?.();
          disposeData = undefined;
          resolve();
        }
      });
    });
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    await withDeadline(ready, 'selected XMODEM peer startup');
    const events: string[] = [];
    let selectedStarted: (() => void) | undefined;
    const selectedStartedPromise = new Promise<void>((resolve) => {
      selectedStarted = resolve;
    });
    const selectedStartedWithinDeadline = withDeadline(
      selectedStartedPromise,
      'selected XMODEM transfer startup',
    );
    let withholdPeerFrames = true;
    vi.useFakeTimers();
    fakeTimers = true;
    session = new XmodemSession(
      {
        write: (data) => {
          if (data.includes(0x43)) {
            selectedStarted?.();
            selectedStarted = undefined;
          }
          fixture?.channel.write(data);
        },
      },
      { s: (message) => events.push(String(message.event)) },
    );
    const transfer = session;
    disposeData = fixture.channel.onData((data) => {
      if (!withholdPeerFrames) transfer.handleData(data);
    });
    transfer.startReceive();
    transfer.setSavePath(downloads, 'download.bin');
    await selectedStartedWithinDeadline;

    // The real peer has received Axterm's CRC request, but subsequent protocol
    // frames are intentionally unavailable to the product engine. This models
    // a stalled selected peer while keeping the SSH channel drained and lets
    // the product's bounded retry/timeout policy own cancellation.
    await vi.advanceTimersByTimeAsync(110_000);
    expect(events).toContain('session-error');
    expect(events).toContain('session-end');
    expect(transfer.isActive()).toBe(false);
    expect(await readdir(downloads)).toEqual([]);
    vi.useRealTimers();
    fakeTimers = false;
    expect(await withDeadline(exited, 'selected XMODEM peer timeout cancellation')).not.toBe(0);
    withholdPeerFrames = false;
  } finally {
    if (fakeTimers) vi.useRealTimers();
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function xmodemSelectedMalformedFrame(): Promise<void> {
  const transferDirectory = 'xmodem-selected-malformed-frame';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  await writeFile(source, Buffer.alloc(32 * 1024 * 1024, 0xa5));
  const label = `axterm.external-lrzsz-ssh=${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let session: XmodemSession | undefined;
  try {
    fixture = await openSshPeer(
      `exec sx --binary --quiet --1k /peer/${transferDirectory}/outgoing/source.bin`,
      label,
    );
    const events: string[] = [];
    let corruptFrames = false;
    let corruptedFrames = 0;
    session = new XmodemSession(
      { write: (data) => fixture?.channel.write(data) },
      { s: (message) => events.push(String(message.event)) },
    );
    const transfer = session;
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    disposeData = fixture.channel.onData((data) => {
      const peerFrame = Buffer.from(data);
      if (corruptFrames) {
        const marker = peerFrame.indexOf(0x02);
        if (marker >= 0 && marker + 3 < peerFrame.length) {
          // Preserve the actual Debian `sx` peer and SSH/PTY transport, but
          // corrupt a later payload byte in transit. The peer remains alive
          // and must observe Axterm's eventual CAN CAN after bounded retries.
          peerFrame[marker + 3] = peerFrame[marker + 3]! ^ 0xff;
          corruptedFrames += 1;
        }
      }
      transfer.handleData(peerFrame);
    });
    transfer.startReceive();
    transfer.setSavePath(downloads, 'download.bin');
    await vi.waitFor(
      async () => {
        expect(events).toContain('file-start');
        const staged = (await readdir(downloads)).filter((entry) => entry.endsWith('.part'));
        expect(staged).toHaveLength(1);
        expect((await stat(join(downloads, staged[0]!))).size).toBeGreaterThan(0);
      },
      { timeout: 8_000 },
    );
    // Do not corrupt the first packet: first prove that the real external peer
    // wrote a selected-destination staging file, then damage later in-transit
    // frames while its SSH channel remains open.
    corruptFrames = true;
    await vi.waitFor(
      () => expect(events).toEqual(expect.arrayContaining(['session-error', 'session-end'])),
      { timeout: 12_000 },
    );
    expect(corruptedFrames).toBeGreaterThan(10);
    expect(transfer.isActive()).toBe(false);
    expect(await readdir(downloads)).toEqual([]);
    expect(await withDeadline(exited, 'selected XMODEM malformed-frame cancellation')).not.toBe(0);
  } finally {
    disposeData?.();
    session?.destroy();
    await fixture?.close();
    await assertNoPeerContainer(label);
  }
}

async function xmodemSelectedPeerExit(): Promise<void> {
  const transferDirectory = 'xmodem-selected-peer-exit';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  await writeFile(source, Buffer.alloc(32 * 1024 * 1024, 0xa5));
  const label = `axterm.external-lrzsz-ssh=${randomUUID()}`;
  let fixture: Awaited<ReturnType<typeof openSshPeer>> | undefined;
  let disposeData: (() => void) | undefined;
  let disposeExit: (() => void) | undefined;
  let session: XmodemSession | undefined;
  try {
    fixture = await openSshPeer(
      `exec sx --binary --quiet --1k /peer/${transferDirectory}/outgoing/source.bin`,
      label,
    );
    const events: string[] = [];
    session = new XmodemSession(
      { write: (data) => fixture?.channel.write(data) },
      { s: (message) => events.push(String(message.event)) },
    );
    const transfer = session;
    disposeData = fixture.channel.onData((data) => transfer.handleData(data));
    disposeExit = fixture.channel.onExit(() => transfer.destroy());
    const exited = new Promise<number | null>((resolveExit) =>
      fixture?.channel.onExit(resolveExit),
    );
    transfer.startReceive();
    transfer.setSavePath(downloads, 'download.bin');
    await vi.waitFor(
      async () => {
        const staged = (await readdir(downloads)).filter((entry) => entry.endsWith('.part'));
        expect(staged).toHaveLength(1);
        expect((await stat(join(downloads, staged[0]!))).size).toBeGreaterThan(0);
      },
      { timeout: 8_000 },
    );
    await stopPeerContainer(label);
    expect(await withDeadline(exited, 'selected XMODEM peer exit')).not.toBe(0);
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

describe.skipIf(skip)(`independent lrzsz peer through ${platform} SSH PTY`, () => {
  beforeAll(provisionPeer, 40_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('downloads ZMODEM binary bytes from the external sz peer through SSH', async () => {
    await zmodemTransfer('download');
  });

  it('uploads ZMODEM binary bytes to the external rz peer through SSH', async () => {
    await zmodemTransfer('upload');
  });

  it('cancels an external sz download through SSH without publishing a file', async () => {
    await zmodemReceiveCancel();
  });

  it('cancels an upload to the external rz peer through SSH without publishing a file', async () => {
    await zmodemUploadCancel();
  });

  it('times out an external sz handshake through SSH without leaving a live session', async () => {
    await zmodemSelectionTimeout();
  });

  it('cleans a selected external sz transfer when later peer data is unavailable', async () => {
    await zmodemSelectedPeerTimeout();
  });

  it('cleans staged data when a selected external sz peer exits through SSH', async () => {
    await zmodemSelectedPeerExit();
  });

  it('cancels a selected external sz transfer after malformed frames while its peer stays open', async () => {
    await zmodemSelectedMalformedFrame();
  });

  it('downloads XMODEM-1K binary bytes from the external sx peer through SSH', async () => {
    await xmodemTransfer('download');
  });

  it('uploads XMODEM-1K binary bytes to the external rx peer through SSH', async () => {
    await xmodemTransfer('upload');
  });

  it('cancels an external sx download through SSH without publishing a file', async () => {
    await xmodemReceiveCancel();
  });

  it('cancels an upload to the external rx peer through SSH without publishing a file', async () => {
    await xmodemUploadCancel();
  });

  it('times out an external sx peer before a destination is selected through SSH', async () => {
    await xmodemSelectionTimeout();
  });

  it('cancels a selected external sx transfer when later peer data is unavailable', async () => {
    await xmodemSelectedPeerTimeout();
  });

  it('cancels a selected external sx transfer after malformed frames while its peer stays open', async () => {
    await xmodemSelectedMalformedFrame();
  });

  it('cleans staged data when a selected external sx peer exits through SSH', async () => {
    await xmodemSelectedPeerExit();
  });
});
