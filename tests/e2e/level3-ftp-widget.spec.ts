import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { EOL, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { promisify } from 'node:util';
import { Client as FtpClient } from 'basic-ftp';
import { expect, test } from '@playwright/test';
import { openWidgets } from './settings-workspace-navigation';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch';
import { setLevel3NativeSelection } from '../support/level3-native-selection';
const execFileAsync = promisify(execFile);
const fileSha256 = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
test('FTP Widget retains the independent wire journeys on the actual desktop and new package', async ({
  browserName: _browserName,
}, info) => {
  test.skip(
    info.project.name === 'packaged' && !process.env.AXTERM_LEVEL3_PACKAGE_RESULT,
    'An explicit new isolated package is required.',
  );
  const runLongTransfer = process.env.AXTERM_PACKAGED_FTP_LONG_TRANSFER === '1';
  const runStalledTransfer = process.env.AXTERM_PACKAGED_FTP_STALLED_TRANSFER === '1';
  const runActiveStalledTransfer = process.env.AXTERM_PACKAGED_FTP_ACTIVE_STALLED_TRANSFER === '1';
  const runStopRestart = process.env.AXTERM_PACKAGED_FTP_STOP_RESTART === '1';
  const optionalTransfers = [runLongTransfer, runStalledTransfer, runActiveStalledTransfer].filter(
    Boolean,
  ).length;
  if (optionalTransfers > 0) test.setTimeout(90_000 + optionalTransfers * 90_000);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axterm-packaged-ftp-')));
  const shared = join(directory, 'shared');
  const curlSource = join(directory, 'curl-source.bin');
  const curlDownloaded = join(directory, 'curl-downloaded.bin');
  const curlActiveDownloaded = join(directory, 'curl-active-downloaded.bin');
  const curlAsciiSource = join(directory, 'curl-ascii-source.txt');
  const curlAsciiDownloaded = join(directory, 'curl-ascii-downloaded.txt');
  const curlPayload = Buffer.concat([Buffer.from([0, 255, 13, 10]), Buffer.alloc(8_192, 0xa5)]);
  const curlAsciiPayload = Buffer.from('PACKAGED_ASCII_LINE1\nPACKAGED_ASCII_LINE2\n');
  const hostAsciiPayload = Buffer.concat([
    Buffer.from('PACKAGED_ASCII_LINE1'),
    Buffer.from(EOL),
    Buffer.from('PACKAGED_ASCII_LINE2'),
    Buffer.from(EOL),
  ]);
  await mkdir(shared);
  await writeFile(join(shared, 'source.txt'), 'PACKAGED_FTP_SOURCE');
  await writeFile(curlSource, curlPayload);
  await writeFile(curlAsciiSource, curlAsciiPayload);
  const home = join(directory, 'home');
  await mkdir(home);
  const app = await launchLevel3Desktop({
    executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
    args: [`--user-data-dir=${home}`],
    env: { ...process.env },
  });
  const ftp = new FtpClient(5_000);
  try {
    await setLevel3NativeSelection(app, shared, 'open-directory');
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await openWidgets(page);
    const workspace = page.locator('.widget-workspace');
    await workspace.getByRole('button', { name: /Local FTP Server|本地 FTP 服务器/ }).click();
    const form = workspace.locator('.local-ftp-widget-form');
    expect(
      await form
        .locator('select[name="host"] option')
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
    ).toEqual(['127.0.0.1', '::1']);
    await form.getByRole('button', { name: '选择目录' }).click();
    await form.locator('input[name="port"]').fill('0');
    await form.locator('input[name="password"]').fill('packaged-ftp-session-only');
    await form.locator('input[name="passivePortStart"]').fill('50416');
    await form.locator('input[name="passivePortEnd"]').fill('50423');
    await form.getByRole('button', { name: /Start widget|启动 Widget/ }).click();
    const instance = workspace.locator('.widget-instance-list article').filter({
      hasText: /Local FTP Server|本地 FTP 服务器/,
    });
    await expect(instance).toBeVisible();
    const text = (await instance.locator('.widget-instance-title small').textContent()) ?? '';
    const address = new URL(text.match(/ftp:\/\/[^\s·]+/)![0]);
    await ftp.access({
      host: address.hostname,
      port: Number(address.port),
      user: 'ftpuser',
      password: 'packaged-ftp-session-only',
    });
    expect((await ftp.list()).map(({ name }) => name)).toContain('source.txt');
    const largeDirectory = join(shared, 'large');
    await mkdir(largeDirectory);
    for (let index = 0; index <= 1_000; index += 1) {
      await writeFile(join(largeDirectory, `entry-${String(index).padStart(4, '0')}.txt`), 'x');
    }
    for (const verb of ['LIST', 'NLST', 'MLSD']) {
      await ftp.send('PASV');
      await expect(ftp.send(`${verb} large`)).rejects.toMatchObject({ code: 550 });
      expect((await ftp.send('NOOP')).code).toBe(200);
    }
    await rename(largeDirectory, join(shared, 'moved'));
    await unlink(join(shared, 'moved', 'entry-1000.txt'));
    expect(await ftp.list('moved')).toHaveLength(1_000);
    await ftp.uploadFrom(Readable.from(Buffer.from('PACKAGED_FTP_UPLOAD')), 'uploaded.txt');
    expect(await readFile(join(shared, 'uploaded.txt'), 'utf8')).toBe('PACKAGED_FTP_UPLOAD');
    await ftp.uploadFrom(
      Readable.from(Buffer.from('PACKAGED_FTP_REPLACEMENT')),
      'replacement-stage.txt',
    );
    await ftp.rename('replacement-stage.txt', 'source.txt');
    expect(await readFile(join(shared, 'source.txt'), 'utf8')).toBe('PACKAGED_FTP_REPLACEMENT');
    await expect(readFile(join(shared, 'replacement-stage.txt'), 'utf8')).rejects.toThrow();
    if (process.platform !== 'win32') {
      await mkdir(join(shared, 'protected-dir'));
      await symlink('source.txt', join(shared, 'file-link'));
      await symlink('protected-dir', join(shared, 'dir-link'));
      await expect(ftp.send('DELE file-link')).rejects.toThrow();
      await expect(ftp.send('RMD dir-link')).rejects.toThrow();
      await expect(ftp.send('RNFR file-link')).rejects.toThrow();
      await expect(ftp.send('RNTO renamed-link.txt')).rejects.toThrow();
      expect(await readFile(join(shared, 'source.txt'), 'utf8')).toBe('PACKAGED_FTP_REPLACEMENT');
      expect(await readdir(join(shared, 'protected-dir'))).toEqual([]);
      expect(await readdir(join(shared, 'dir-link'))).toEqual([]);
      await expect(readFile(join(shared, 'renamed-link.txt'))).rejects.toThrow();
    }
    ftp.close();

    if (runLongTransfer) {
      const slowFtp = new FtpClient(45_000);
      try {
        await slowFtp.access({
          host: address.hostname,
          port: Number(address.port),
          user: 'ftpuser',
          password: 'packaged-ftp-session-only',
        });
        const slowSource = Readable.from(
          (async function* () {
            yield Buffer.from('first-');
            await new Promise((resolveWait) => setTimeout(resolveWait, 16_000));
            yield Buffer.from('middle-');
            await new Promise((resolveWait) => setTimeout(resolveWait, 16_000));
            yield Buffer.from('last');
          })(),
        );
        await slowFtp.uploadFrom(slowSource, 'long-transfer.bin');
        expect(await readFile(join(shared, 'long-transfer.bin'), 'utf8')).toBe('first-middle-last');
        expect((await slowFtp.send('NOOP')).code).toBe(200);
      } finally {
        slowFtp.close();
      }
    }

    if (runStalledTransfer) {
      const stalledFtp = new FtpClient(45_000);
      const stalledSource = new PassThrough();
      try {
        await stalledFtp.access({
          host: address.hostname,
          port: Number(address.port),
          user: 'ftpuser',
          password: 'packaged-ftp-session-only',
        });
        const startedAt = Date.now();
        const upload = stalledFtp.uploadFrom(stalledSource, 'source.txt');
        stalledSource.write('STALLED_PARTIAL_BYTES');
        await expect
          .poll(async () => (await readdir(shared)).some((name) => name.endsWith('.part')))
          .toBe(true);
        await expect(upload).rejects.toThrow();
        expect(Date.now() - startedAt).toBeGreaterThan(29_000);
        expect(await readFile(join(shared, 'source.txt'), 'utf8')).toBe('PACKAGED_FTP_REPLACEMENT');
        expect((await readdir(shared)).filter((name) => name.endsWith('.part'))).toEqual([]);
        const recoveryFtp = new FtpClient(5_000);
        try {
          await recoveryFtp.access({
            host: address.hostname,
            port: Number(address.port),
            user: 'ftpuser',
            password: 'packaged-ftp-session-only',
          });
          expect((await recoveryFtp.send('NOOP')).code).toBe(200);
        } finally {
          recoveryFtp.close();
        }
      } finally {
        stalledSource.destroy();
        stalledFtp.close();
      }
    }

    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const curlShared = [
      '--silent',
      '--show-error',
      '--fail',
      '--disable-epsv',
      '--max-time',
      '10',
      '--user',
      'ftpuser:packaged-ftp-session-only',
    ];
    const remoteRoot = `ftp://${address.hostname}:${address.port}/`;
    if (runActiveStalledTransfer) {
      const stalledCurl = spawn(
        curl,
        [
          '--silent',
          '--show-error',
          '--fail',
          '--max-time',
          '40',
          '--user',
          'ftpuser:packaged-ftp-session-only',
          '--ftp-port',
          '-',
          '--upload-file',
          '-',
          `${remoteRoot}source.txt`,
        ],
        { stdio: ['pipe', 'ignore', 'pipe'] },
      );
      stalledCurl.stdin.on('error', () => undefined);
      stalledCurl.stderr.resume();
      const closed = once(stalledCurl, 'close');
      const startedAt = Date.now();
      try {
        stalledCurl.stdin.write('STALLED_ACTIVE_BYTES');
        await expect
          .poll(async () => {
            const stagingName = (await readdir(shared)).find((name) => name.endsWith('.part'));
            return stagingName ? (await stat(join(shared, stagingName))).size > 0 : false;
          })
          .toBe(true);
        await expect
          .poll(async () => (await readdir(shared)).every((name) => !name.endsWith('.part')), {
            timeout: 25_000,
            intervals: [250],
          })
          .toBe(true);
        expect(Date.now() - startedAt).toBeGreaterThan(14_000);
        expect(Date.now() - startedAt).toBeLessThan(30_000);
        stalledCurl.kill();
        await closed;
        expect(await readFile(join(shared, 'source.txt'), 'utf8')).toBe('PACKAGED_FTP_REPLACEMENT');
        expect((await readdir(shared)).filter((name) => name.endsWith('.part'))).toEqual([]);
        const recoveryFtp = new FtpClient(5_000);
        try {
          await recoveryFtp.access({
            host: address.hostname,
            port: Number(address.port),
            user: 'ftpuser',
            password: 'packaged-ftp-session-only',
          });
          expect((await recoveryFtp.send('NOOP')).code).toBe(200);
        } finally {
          recoveryFtp.close();
        }
      } finally {
        stalledCurl.stdin.destroy();
        stalledCurl.kill();
      }
    }
    if (runLongTransfer) {
      const slowDownloadSource = join(shared, 'long-download.bin');
      const slowDownloadTarget = join(directory, 'long-downloaded.bin');
      await writeFile(slowDownloadSource, Buffer.alloc(36 * 1024 * 1024, 0xa5));
      const startedAt = Date.now();
      const { stderr } = await execFileAsync(
        curl,
        [
          '--silent',
          '--show-error',
          '--fail',
          '--verbose',
          '--disable-epsv',
          '--limit-rate',
          '1M',
          '--max-time',
          '75',
          '--user',
          'ftpuser:packaged-ftp-session-only',
          '--quote',
          '-NOOP',
          '--output',
          slowDownloadTarget,
          `${remoteRoot}long-download.bin`,
        ],
        { maxBuffer: 1024 * 1024, timeout: 80_000 },
      );
      expect(Date.now() - startedAt).toBeGreaterThan(30_000);
      expect(await fileSha256(slowDownloadTarget)).toBe(await fileSha256(slowDownloadSource));
      const replies = stderr.split(/\r?\n/u).map((line) => line.trim());
      const noopIndex = replies.findIndex((line) => line === '> NOOP');
      expect(noopIndex).toBeGreaterThan(0);
      expect(replies.slice(noopIndex + 1).some((line) => /^< 200 /u.test(line))).toBe(true);
    }
    const listedByCurl = await execFileAsync(curl, [...curlShared, '--list-only', remoteRoot], {
      maxBuffer: 64 * 1024,
      timeout: 10_000,
    });
    expect(listedByCurl.stdout).toContain('source.txt');
    await execFileAsync(
      curl,
      [...curlShared, '--upload-file', curlSource, `${remoteRoot}curl-upload.bin`],
      {
        maxBuffer: 64 * 1024,
        timeout: 10_000,
      },
    );
    expect(await readFile(join(shared, 'curl-upload.bin'))).toEqual(curlPayload);
    await execFileAsync(
      curl,
      [...curlShared, '--output', curlDownloaded, `${remoteRoot}curl-upload.bin`],
      {
        maxBuffer: 64 * 1024,
        timeout: 10_000,
      },
    );
    expect(await readFile(curlDownloaded)).toEqual(curlPayload);
    await execFileAsync(
      curl,
      [
        ...curlShared,
        '--crlf',
        '--use-ascii',
        '--upload-file',
        curlAsciiSource,
        `${remoteRoot}curl-ascii.txt`,
      ],
      {
        maxBuffer: 64 * 1024,
        timeout: 10_000,
      },
    );
    expect(await readFile(join(shared, 'curl-ascii.txt'))).toEqual(hostAsciiPayload);
    await execFileAsync(
      curl,
      [
        ...curlShared,
        '--use-ascii',
        '--output',
        curlAsciiDownloaded,
        `${remoteRoot}curl-ascii.txt`,
      ],
      {
        maxBuffer: 64 * 1024,
        timeout: 10_000,
      },
    );
    expect(await readFile(curlAsciiDownloaded)).toEqual(hostAsciiPayload);
    await execFileAsync(
      curl,
      [
        '--silent',
        '--show-error',
        '--fail',
        '--max-time',
        '10',
        '--user',
        'ftpuser:packaged-ftp-session-only',
        '--ftp-port',
        '-',
        '--upload-file',
        curlSource,
        `${remoteRoot}curl-active-upload.bin`,
      ],
      {
        maxBuffer: 64 * 1024,
        timeout: 10_000,
      },
    );
    expect(await readFile(join(shared, 'curl-active-upload.bin'))).toEqual(curlPayload);
    await execFileAsync(
      curl,
      [
        '--silent',
        '--show-error',
        '--fail',
        '--max-time',
        '10',
        '--user',
        'ftpuser:packaged-ftp-session-only',
        '--ftp-port',
        '-',
        '--output',
        curlActiveDownloaded,
        `${remoteRoot}curl-active-upload.bin`,
      ],
      {
        maxBuffer: 64 * 1024,
        timeout: 10_000,
      },
    );
    expect(await readFile(curlActiveDownloaded)).toEqual(curlPayload);

    if (runStopRestart) {
      const interrupted = new FtpClient(5_000);
      const uploadSource = new PassThrough();
      try {
        await interrupted.access({
          host: address.hostname,
          port: Number(address.port),
          user: 'ftpuser',
          password: 'packaged-ftp-session-only',
        });
        const uploadResult = interrupted.uploadFrom(uploadSource, 'source.txt').then(
          () => 'completed',
          () => 'failed',
        );
        uploadSource.write('PACKAGED_STOP_PARTIAL_BYTES');
        await expect
          .poll(async () => {
            const stage = (await readdir(shared)).find((name) => name.endsWith('.part'));
            return stage ? (await stat(join(shared, stage))).size > 0 : false;
          })
          .toBe(true);
        await instance.getByTitle('停止').click();
        await instance.getByTitle('再次点击确认停止').click();
        await expect(workspace.getByText(/No running instances|没有运行中的实例/)).toBeVisible();
        uploadSource.destroy();
        interrupted.close();
        expect(await uploadResult).toBe('failed');
        expect(await readFile(join(shared, 'source.txt'), 'utf8')).toBe('PACKAGED_FTP_REPLACEMENT');
        expect((await readdir(shared)).filter((name) => name.endsWith('.part'))).toEqual([]);
      } finally {
        uploadSource.destroy();
        interrupted.close();
      }

      await form.locator('input[name="port"]').fill(address.port);
      await form.locator('input[name="password"]').fill('packaged-ftp-session-only');
      await form.locator('input[name="passivePortStart"]').fill('50416');
      await form.locator('input[name="passivePortEnd"]').fill('50423');
      await form.getByRole('button', { name: /Start widget|启动 Widget/ }).click();
      await expect(instance).toBeVisible();
      const restartedAddress = new URL(
        ((await instance.locator('.widget-instance-title small').textContent()) ?? '').match(
          /ftp:\/\/[^\s·]+/,
        )![0],
      );
      expect(restartedAddress.port).toBe(address.port);
      const recovered = new FtpClient(5_000);
      try {
        await recovered.access({
          host: restartedAddress.hostname,
          port: Number(restartedAddress.port),
          user: 'ftpuser',
          password: 'packaged-ftp-session-only',
        });
        expect((await recovered.send('NOOP')).code).toBe(200);
        expect((await recovered.list()).map(({ name }) => name)).toContain('source.txt');
      } finally {
        recovered.close();
      }
    }

    await instance.getByTitle('停止').click();
    await instance.getByTitle('再次点击确认停止').click();
    await expect(workspace.getByText(/No running instances|没有运行中的实例/)).toBeVisible();
  } finally {
    ftp.close();
    await closeLevel3Desktop(app);
    await rm(directory, { recursive: true, force: true });
  }
});
