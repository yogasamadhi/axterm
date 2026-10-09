import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NodePtyAdapter } from '../pty/node-pty-adapter';
import { XmodemSession } from './xmodem';
import { ZmodemSession } from './zmodem';

const execFileAsync = promisify(execFile);
const enabled = process.env.AXTERM_EXTERNAL_LRZSZ === '1';
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
    `Unsupported external lrzsz platform: ${platform}; use linux/arm64 or linux/amd64`,
  );
const selectedPeer = peer ?? peers['linux/arm64'];
const skip = !enabled || process.platform === 'win32';
const preprovisionedPackage = process.env.AXTERM_EXTERNAL_LRZSZ_DEB?.trim();

let root = '';

async function docker(args: string[]) {
  return execFileAsync('docker', args, { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 });
}

async function provisionPeer(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'axterm-external-lrzsz-'));
  await mkdir(join(root, 'incoming'));
  await mkdir(join(root, 'outgoing'));
  const packagePath = join(root, selectedPeer.packageName);
  if (preprovisionedPackage) {
    // This is an opt-in test-only input for runners whose Docker network cannot
    // fetch a full Debian APT index within the bounded provision step. It is
    // copied into the disposable fixture and must still match the fixed peer
    // package SHA-256 below.
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
  const { stdout } = await docker(['ps', '--all', '--quiet', '--filter', `label=${label}`]);
  expect(stdout.trim()).toBe('');
}

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`External lrzsz ${label} timed out`)), 20_000),
    ),
  ]);
}

function openPeer(command: string, label: string) {
  return new NodePtyAdapter().open({
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
}

async function zmodemTransfer(direction: 'download' | 'upload'): Promise<void> {
  const bytes = Buffer.concat([Buffer.from([0, 255, 1, 13, 10]), Buffer.alloc(16_384, 0xa5)]);
  const peerDirectory = `zmodem-${direction}`;
  const transferRoot = join(root, peerDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'incoming'), { recursive: true });
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await writeFile(source, bytes);
  await mkdir(downloads);
  const label = `axterm.external-lrzsz=${randomUUID()}`;
  const command =
    direction === 'download'
      ? `exec sz --binary --quiet /peer/${peerDirectory}/outgoing/source.bin`
      : `cd /peer/${peerDirectory}/incoming\nexec rz --binary --quiet --overwrite`;
  const channel = openPeer(command, label);
  const events: string[] = [];
  const ordinary: Buffer[] = [];
  const session = new ZmodemSession(
    { write: (data) => channel.write(data) },
    {
      s: (message) => {
        events.push(String(message.event));
        if (message.event === 'receive-start')
          session.handleMessage({ event: 'set-save-path', path: downloads });
        if (message.event === 'send-start')
          session.handleMessage({ event: 'send-files', files: [{ path: source }] });
      },
      send: (data) => ordinary.push(Buffer.from(data)),
    },
  );
  const disposeData = channel.onData((data) => {
    if (!session.handleData(data)) ordinary.push(Buffer.from(data));
  });
  const exited = new Promise<number | null>((resolveExit) => channel.onExit(resolveExit));
  try {
    await vi.waitFor(
      () => expect(events).toContain(direction === 'download' ? 'receive-start' : 'send-start'),
      {
        timeout: 8_000,
      },
    );
    expect(await withDeadline(exited, `ZMODEM ${direction}`)).toBe(0);
    expect(events).toContain('session-complete');
    expect(session.isActive()).toBe(false);
    const result =
      direction === 'download'
        ? await readFile(join(downloads, 'source.bin'))
        : await readFile(join(transferRoot, 'incoming', 'source.bin'));
    expect(result).toEqual(bytes);
  } finally {
    disposeData();
    session.destroy();
    await channel.close();
    await assertNoPeerContainer(label);
  }
}

async function zmodemReceiveCancel(): Promise<void> {
  const peerDirectory = 'zmodem-cancel';
  const transferRoot = join(root, peerDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await writeFile(source, Buffer.alloc(16_384, 0xa5));
  await mkdir(downloads);
  const label = `axterm.external-lrzsz=${randomUUID()}`;
  const channel = openPeer(
    `exec sz --binary --quiet /peer/${peerDirectory}/outgoing/source.bin`,
    label,
  );
  const events: string[] = [];
  const session = new ZmodemSession(
    { write: (data) => channel.write(data) },
    {
      s: (message) => {
        events.push(String(message.event));
        if (message.event === 'receive-start') session.handleMessage({ event: 'cancel' });
      },
      send: () => undefined,
    },
  );
  const disposeData = channel.onData((data) => session.handleData(data));
  const exited = new Promise<number | null>((resolveExit) => channel.onExit(resolveExit));
  try {
    await vi.waitFor(() => expect(events).toContain('receive-start'), { timeout: 8_000 });
    expect(await withDeadline(exited, 'ZMODEM receive cancellation')).not.toBe(0);
    expect(events).toContain('session-end');
    expect(session.isActive()).toBe(false);
    await expect(readFile(join(downloads, 'source.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    disposeData();
    session.destroy();
    await channel.close();
    await assertNoPeerContainer(label);
  }
}

async function xmodemTransfer(direction: 'download' | 'upload'): Promise<void> {
  const bytes = Buffer.concat([Buffer.from([0, 255, 1, 13, 10]), Buffer.alloc(16_379, 0xa5)]);
  const peerDirectory = `xmodem-${direction}`;
  const transferRoot = join(root, peerDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'incoming'), { recursive: true });
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await writeFile(source, bytes);
  await mkdir(downloads);
  const label = `axterm.external-lrzsz=${randomUUID()}`;
  const command =
    direction === 'download'
      ? `exec sx --binary --quiet --1k /peer/${peerDirectory}/outgoing/source.bin`
      : `cd /peer/${peerDirectory}/incoming\nexec rx --binary --quiet upload.bin`;
  const channel = openPeer(command, label);
  const events: string[] = [];
  const output: Buffer[] = [];
  const session = new XmodemSession(
    { write: (data) => channel.write(data) },
    { s: (message) => events.push(String(message.event)) },
  );
  const disposeData = channel.onData((data) => {
    output.push(Buffer.from(data));
    session.handleData(data);
  });
  const exited = new Promise<number | null>((resolveExit) => channel.onExit(resolveExit));
  try {
    if (direction === 'download') {
      session.startReceive();
      session.setSavePath(downloads, 'download.bin');
    } else {
      session.startSend();
      session.setSendFiles([{ path: source, name: 'source.bin', size: bytes.length }]);
    }
    expect(
      await withDeadline(exited, `XMODEM ${direction}`),
      Buffer.concat(output).toString('utf8'),
    ).toBe(0);
    expect(events).toContain('file-complete');
    expect(session.isActive()).toBe(false);
    const result =
      direction === 'download'
        ? await readFile(join(downloads, 'download.bin'))
        : await readFile(join(transferRoot, 'incoming', 'upload.bin'));
    expect(result).toEqual(bytes);
  } finally {
    disposeData();
    session.destroy();
    await channel.close();
    await assertNoPeerContainer(label);
  }
}

async function xmodemReceiveCancel(): Promise<void> {
  const peerDirectory = 'xmodem-cancel';
  const transferRoot = join(root, peerDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await writeFile(source, Buffer.alloc(16_384, 0xa5));
  await mkdir(downloads);
  const label = `axterm.external-lrzsz=${randomUUID()}`;
  const channel = openPeer(
    `exec sx --binary --quiet --1k /peer/${peerDirectory}/outgoing/source.bin`,
    label,
  );
  const events: string[] = [];
  const session = new XmodemSession(
    { write: (data) => channel.write(data) },
    {
      s: (message) => {
        events.push(String(message.event));
        if (message.event === 'file-start') session.cancel();
      },
    },
  );
  const disposeData = channel.onData((data) => session.handleData(data));
  const exited = new Promise<number | null>((resolveExit) => channel.onExit(resolveExit));
  try {
    session.startReceive();
    session.setSavePath(downloads, 'download.bin');
    expect(await withDeadline(exited, 'XMODEM receive cancellation')).not.toBe(0);
    expect(events).toContain('file-start');
    expect(events).toContain('session-end');
    expect(session.isActive()).toBe(false);
    await expect(readFile(join(downloads, 'download.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    disposeData();
    session.destroy();
    await channel.close();
    await assertNoPeerContainer(label);
  }
}

describe.skipIf(skip)(`independent lrzsz peer through ${platform} Docker PTY`, () => {
  beforeAll(provisionPeer, 40_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('downloads ZMODEM binary bytes from the external sz peer', async () => {
    await zmodemTransfer('download');
  });

  it('uploads ZMODEM binary bytes to the external rz peer', async () => {
    await zmodemTransfer('upload');
  });

  it('cancels a ZMODEM download from the external sz peer without publishing a file', async () => {
    await zmodemReceiveCancel();
  });

  it('downloads XMODEM-1K binary bytes from the external sx peer', async () => {
    await xmodemTransfer('download');
  });

  it('uploads XMODEM-1K binary bytes to the external rx peer', async () => {
    await xmodemTransfer('upload');
  });

  it('cancels an XMODEM-1K download from the external sx peer without publishing a file', async () => {
    await xmodemReceiveCancel();
  });
});
