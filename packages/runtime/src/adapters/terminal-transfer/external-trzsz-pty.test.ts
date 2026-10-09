import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NodePtyAdapter } from '../pty/node-pty-adapter';
import { TrzszSession } from './trzsz';

const execFileAsync = promisify(execFile);
const enabled = process.env.AXTERM_EXTERNAL_TRZSZ === '1';
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
    `Unsupported external trzsz platform: ${platform}; use linux/arm64 or linux/amd64`,
  );
const selectedPeer = peer ?? peers['linux/arm64'];
const skip = !enabled || process.platform === 'win32';

let root = '';

async function command(program: string, args: string[]) {
  return execFileAsync(program, args, { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 });
}

async function provisionPeer(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'axterm-external-trzsz-'));
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
  const { stdout } = await command('docker', [
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `label=${label}`,
  ]);
  expect(stdout.trim()).toBe('');
}

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`External trzsz ${label} timed out`)), 20_000),
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
      command,
    ],
    cwd: root,
    env: {},
    term: 'xterm-256color',
    loginShell: false,
    cols: 80,
    rows: 24,
  });
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
  const label = `axterm.external-trzsz=${randomUUID()}`;
  const peerCommand =
    direction === 'download' ? 'tsz /peer/transfer-download/outgoing/source.bin' : 'trz';
  const command =
    direction === 'download'
      ? `exec /peer/${selectedPeer.peerDirectory}/${peerCommand}`
      : `cd /peer/transfer-upload/incoming\nexec /peer/${selectedPeer.peerDirectory}/${peerCommand}`;
  const channel = openPeer(command, label);
  const events: string[] = [];
  const ordinary: Buffer[] = [];
  const session = new TrzszSession(
    { write: (data) => channel.write(data) },
    {
      s: (message) => {
        events.push(String(message.event));
        if (message.event === 'receive-start')
          session.handleMessage({ event: 'set-save-path', path: downloads });
        if (message.event === 'send-start')
          session.handleMessage({ event: 'send-files', files: [{ path: source }] });
      },
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
    expect(
      await withDeadline(exited, `${direction} transfer`),
      Buffer.concat(ordinary).toString('utf8'),
    ).toBe(0);
    expect(events).toContain('session-complete');
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

async function cancelDownload(): Promise<void> {
  const transferDirectory = 'transfer-cancel';
  const transferRoot = join(root, transferDirectory);
  const source = join(transferRoot, 'outgoing', 'source.bin');
  const downloads = join(transferRoot, 'downloads');
  await mkdir(join(transferRoot, 'outgoing'), { recursive: true });
  await mkdir(downloads);
  await writeFile(source, Buffer.alloc(16_384, 0xa5));
  const label = `axterm.external-trzsz=${randomUUID()}`;
  const channel = openPeer(
    `exec /peer/${selectedPeer.peerDirectory}/tsz /peer/${transferDirectory}/outgoing/source.bin`,
    label,
  );
  const events: string[] = [];
  const session = new TrzszSession(
    { write: (data) => channel.write(data) },
    {
      s: (message) => {
        events.push(String(message.event));
        if (message.event === 'receive-start') session.handleMessage({ event: 'cancel' });
      },
    },
  );
  const disposeData = channel.onData((data) => session.handleData(data));
  const exited = new Promise<number | null>((resolveExit) => channel.onExit(resolveExit));
  try {
    await vi.waitFor(() => expect(events).toContain('receive-start'), { timeout: 8_000 });
    expect(await withDeadline(exited, 'download cancellation')).toBe(0);
    await vi.waitFor(() => expect(events).toContain('session-end'), { timeout: 8_000 });
    expect(session.isActive()).toBe(false);
    await expect(readFile(join(downloads, 'source.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    disposeData();
    session.destroy();
    await channel.close();
    await assertNoPeerContainer(label);
  }
}

describe.skipIf(skip)(`independent trzsz-go 1.2.0 peer through ${platform} Docker PTY`, () => {
  beforeAll(provisionPeer, 45_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('downloads TRZSZ binary bytes from the external tsz peer', async () => {
    await transfer('download');
  });

  it('uploads TRZSZ binary bytes to the external trz peer', async () => {
    await transfer('upload');
  });

  it('cancels a TRZSZ download from the external tsz peer without publishing a file', async () => {
    await cancelDownload();
  });
});
