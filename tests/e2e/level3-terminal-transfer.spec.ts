import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { expect, test, type ElectronApplication, type Locator } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch';
import { setLevel3NativeSelection } from '../support/level3-native-selection';

const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const executablePath = createRequire(resolve('apps/desktop/package.json'))('electron') as string;
async function setup(
  protocol: 'trzsz' | 'zmodem' | 'xmodem',
  bytes: Buffer,
  selectedDestination?: string,
) {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-l3-native-transfer-'));
  let app: ElectronApplication | undefined;
  try {
    const home = join(directory, 'home'),
      destination = selectedDestination ?? join(directory, 'downloads');
    await mkdir(home);
    if (!selectedDestination) await mkdir(destination);
    const fixture = join(directory, protocol + '-peer.mjs'),
      source = join(directory, 'source.bin');
    await writeFile(source, bytes);
    await build({
      entryPoints: [
        resolve(`packages/plugins/terminals/tests/terminal-transfer/fixtures/${protocol}-peer.mjs`),
      ],
      outfile: fixture,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
    });
    app = await launchLevel3Desktop({
      executablePath,
      args: [`--user-data-dir=${home}`],
      env: { ...process.env },
    });
    const page = await app.firstWindow();
    const terminal = page.locator('[data-terminal-id]:visible');
    await expect(terminal).toHaveAttribute('data-terminal-channel', 'ready');
    const input = terminal.locator('.xterm-helper-textarea');
    const binary = await app.evaluate(({ app }) => app.getPath('exe'));
    const command = (path: string, mode = '') =>
      `ELECTRON_RUN_AS_NODE=1 ${quote(binary)} ${quote(fixture)} ${quote(path)}${mode ? ' ' + mode : ''}`;
    const choose = (path: string) =>
      setLevel3NativeSelection(app!, path, path === destination ? 'open-directory' : 'open-file');
    await choose(destination);
    return { directory, home, destination, source, app, page, terminal, input, command, choose };
  } catch (error) {
    if (app) await closeLevel3Desktop(app).catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
async function enter(input: Locator, command: string) {
  await input.press('Control+A');
  await input.press('Control+U');
  await input.pressSequentially(command, { delay: 4 });
  await input.press('Enter');
}
for (const protocol of ['trzsz', 'zmodem', 'xmodem'] as const) {
  test(`${protocol.toUpperCase()} roundtrip preserves original binary bytes through the actual desktop UI and its embedded Node`, async ({
    browserName: _browserName,
  }, info) => {
    test.skip(process.platform === 'win32', 'Original POSIX PTY peer requires stty.');
    test.skip(
      info.project.name === 'packaged' && !process.env.AXTERM_LEVEL3_PACKAGE_RESULT,
      'An explicit new isolated package is required.',
    );
    const bytes = Buffer.concat([
      Buffer.from([0, 1, 2, 255]),
      Buffer.alloc(protocol === 'xmodem' ? 16_380 : 16_384, 0xa5),
    ]);
    const f = await setup(protocol, bytes);
    try {
      await enter(f.input, f.command(f.source));
      await expect(f.terminal.locator('.xterm-rows')).toContainText(
        protocol === 'trzsz'
          ? 'AXTERM_PEER_READY_SEND'
          : `AXTERM_${protocol.toUpperCase()}_READY_SEND`,
      );
      await f.input.pressSequentially('!');
      if (protocol === 'xmodem') {
        await f.terminal.click({ button: 'right', position: { x: 100, y: 100 } });
        await f.page
          .getByRole('menuitem', { name: /XMODEM 接收文件|Receive file with XMODEM/ })
          .click();
      }
      const downloaded = join(
        f.destination,
        protocol === 'xmodem' ? 'xmodem-download.bin' : 'source.bin',
      );
      await expect
        .poll(() => readFile(downloaded).catch(() => undefined), { timeout: 20_000 })
        .toEqual(bytes);
      await expect(f.terminal.locator('.terminal-transfer-indicator.completed')).toBeVisible();
      await f.choose(f.source);
      const uploaded = join(f.directory, 'uploaded.bin');
      await enter(f.input, f.command(uploaded, 'receive'));
      await expect(f.terminal.locator('.xterm-rows')).toContainText(
        protocol === 'trzsz'
          ? 'AXTERM_PEER_READY_RECEIVE'
          : `AXTERM_${protocol.toUpperCase()}_READY_RECEIVE`,
      );
      if (protocol === 'xmodem') {
        await f.terminal.click({ button: 'right', position: { x: 100, y: 100 } });
        await f.page
          .getByRole('menuitem', { name: /XMODEM 发送文件|Send file with XMODEM/ })
          .click();
        await expect(f.terminal.locator('.terminal-transfer-indicator.waiting-peer')).toBeVisible();
      }
      await f.input.pressSequentially('!');
      await expect
        .poll(() => readFile(uploaded).catch(() => undefined), { timeout: 20_000 })
        .toEqual(bytes);
      await expect(f.terminal.locator('.terminal-transfer-indicator.completed')).toBeVisible();
      expect(await readFile(downloaded)).toEqual(bytes);
    } finally {
      await closeLevel3Desktop(f.app);
      await rm(f.directory, { recursive: true, force: true });
    }
  });
}
for (const mode of ['misreport-size', 'oversized-chunk-header'] as const) {
  test(`TRZSZ ${mode} preserves the original empty destination on the actual desktop`, async ({
    browserName: _browserName,
  }, info) => {
    test.skip(process.platform !== 'darwin', 'Original macOS transfer safety journey.');
    test.skip(
      info.project.name === 'packaged' && !process.env.AXTERM_LEVEL3_PACKAGE_RESULT,
      'An explicit new isolated package is required.',
    );
    const f = await setup('trzsz', Buffer.from([0, 1, 2, 3]));
    try {
      await enter(f.input, f.command(f.source, mode));
      await expect(f.terminal.locator('.xterm-rows')).toContainText('AXTERM_PEER_READY_SEND');
      await f.input.pressSequentially('!');
      await expect(f.terminal.locator('.terminal-transfer-indicator.failed')).toBeVisible();
      expect(await readdir(f.destination)).toEqual([]);
      await expect(readFile(join(f.destination, 'source.bin'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await closeLevel3Desktop(f.app);
      await rm(f.directory, { recursive: true, force: true });
    }
  });
}

test('TRZSZ graceful quit keeps the original destination empty during an active receive', async ({
  browserName: _browserName,
}, info) => {
  test.skip(process.platform !== 'darwin', 'Original macOS graceful transfer shutdown journey.');
  test.skip(
    info.project.name === 'packaged' && !process.env.AXTERM_LEVEL3_PACKAGE_RESULT,
    'An explicit new isolated package is required.',
  );
  const f = await setup('trzsz', Buffer.alloc(4 * 1024 * 1024, 0xa5));
  let closed = false;
  const privateBytes = async (directory: string): Promise<number> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    let total = 0;
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) total += await privateBytes(path);
      else if (entry.isFile() && entry.name.endsWith('.part') && !entry.name.startsWith('._'))
        total += (await stat(path)).size;
    }
    return total;
  };
  try {
    await enter(f.input, f.command(f.source, 'stall-after-first-chunk'));
    await expect(f.terminal.locator('.xterm-rows')).toContainText('AXTERM_PEER_READY_SEND');
    await f.input.pressSequentially('!');
    await expect
      .poll(() => privateBytes(join(f.home, 'profiles/desktop/terminal-stages')), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    expect(await readdir(f.destination)).toEqual([]);
    await closeLevel3Desktop(f.app);
    closed = true;
    expect(await readdir(f.destination)).toEqual([]);
    await expect(readFile(join(f.destination, 'source.bin'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    if (!closed) await closeLevel3Desktop(f.app);
    await rm(f.directory, { recursive: true, force: true });
  }
});

for (const protocol of ['trzsz', 'zmodem', 'xmodem'] as const) {
  test(`unsafe real-volume ${protocol} publication retains the original failure wording and no partial destination`, async ({
    browserName: _browserName,
  }, info) => {
    const volume = process.env.AXTERM_REAL_NO_REPLACE_DIRECTORY?.trim();
    test.skip(
      process.platform !== 'darwin' || !volume,
      'Original real macOS volume must reject hard links and native no-replace rename.',
    );
    test.skip(
      info.project.name === 'packaged' && !process.env.AXTERM_LEVEL3_PACKAGE_RESULT,
      'An explicit new isolated package is required.',
    );
    test.setTimeout(90_000);
    const destination = await mkdtemp(join(volume!, 'axterm-l3-unsupported-' + protocol + '-'));
    let f: Awaited<ReturnType<typeof setup>> | undefined;
    try {
      f = await setup(protocol, Buffer.alloc(1024, 0xa5), destination);
      await enter(f.input, f.command(f.source));
      await expect(f.terminal.locator('.xterm-rows')).toContainText(
        protocol === 'trzsz'
          ? 'AXTERM_PEER_READY_SEND'
          : `AXTERM_${protocol.toUpperCase()}_READY_SEND`,
      );
      await f.input.pressSequentially('!');
      if (protocol === 'xmodem') {
        await f.terminal.click({ button: 'right', position: { x: 100, y: 100 } });
        await f.page
          .getByRole('menuitem', { name: /XMODEM 接收文件|Receive file with XMODEM/ })
          .click();
      }
      const indicator = f.terminal.locator('.terminal-transfer-indicator.failed');
      await expect(indicator).toBeVisible();
      await expect(indicator).toContainText(
        /目标文件系统无法安全保存接收文件|This destination filesystem cannot safely publish/u,
      );
      expect((await readdir(destination)).filter((name) => !name.startsWith('._'))).toEqual([]);
    } finally {
      if (f) {
        try {
          await closeLevel3Desktop(f.app);
        } finally {
          await rm(f.directory, { recursive: true, force: true });
        }
      }
      await rm(destination, { recursive: true, force: true });
    }
  });
}

async function privateParts(directory: string): Promise<Array<{ path: string; bytes: number }>> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await privateParts(path)));
    else if (entry.isFile() && entry.name.endsWith('.part') && !entry.name.startsWith('._'))
      files.push({ path, bytes: (await stat(path)).size });
  }
  return files;
}
async function processIdentities() {
  const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], {
    maxBuffer: 1024 * 1024,
  });
  return new Map(
    stdout.split('\n').flatMap((line) => {
      const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return row
        ? [
            [
              Number(row[1]),
              { pid: Number(row[1]), parent: Number(row[2]), started: row[3]!.trim() },
            ] as const,
          ]
        : [];
    }),
  );
}
for (const protocol of ['trzsz', 'xmodem', 'zmodem'] as const) {
  test(`${protocol.toUpperCase()} hard-kill recovery requires a fresh directory selection and explicit removal`, async ({
    browserName: _browserName,
  }, info) => {
    test.skip(
      process.platform !== 'darwin' || process.env.AXTERM_PACKAGED_TRANSFER_CRASH_PROBE !== '1',
      'Original opt-in macOS hard-kill recovery probe.',
    );
    test.skip(
      info.project.name === 'packaged' && !process.env.AXTERM_LEVEL3_PACKAGE_RESULT,
      'An explicit new isolated package is required.',
    );
    test.setTimeout(90_000);
    const f = await setup(protocol, Buffer.alloc(4 * 1024 * 1024, 0xa5));
    let crashed = false,
      restarted: ElectronApplication | undefined;
    const stageDirectory = join(f.home, 'profiles/desktop/terminal-stages');
    try {
      await enter(
        f.input,
        f.command(
          f.source,
          protocol === 'trzsz' ? 'stall-after-first-chunk' : 'send stall-after-first-chunk',
        ),
      );
      await expect(f.terminal.locator('.xterm-rows')).toContainText(
        protocol === 'trzsz'
          ? 'AXTERM_PEER_READY_SEND'
          : `AXTERM_${protocol.toUpperCase()}_READY_SEND`,
      );
      await f.input.pressSequentially('!');
      if (protocol === 'xmodem') {
        await f.terminal.click({ button: 'right', position: { x: 100, y: 100 } });
        await f.page
          .getByRole('menuitem', { name: /XMODEM 接收文件|Receive file with XMODEM/ })
          .click();
      }
      await expect
        .poll(
          async () =>
            (await privateParts(stageDirectory)).reduce((total, file) => total + file.bytes, 0),
          { timeout: 20_000 },
        )
        .toBeGreaterThan(0);
      const before = await privateParts(stageDirectory);
      expect(before).toHaveLength(1);
      await f.page.locator('.app-statusbar [data-runtime-details-trigger]').click();
      const generation = await f.page.getByTestId('runtime-generation').innerText();
      await f.page.keyboard.press('Escape');
      const snapshot = await processIdentities();
      const rootPid = f.app.process().pid!;
      const owned = [rootPid];
      for (let index = 0; index < owned.length; index++)
        for (const entry of snapshot.values())
          if (entry.parent === owned[index] && !owned.includes(entry.pid)) owned.push(entry.pid);
      expect(owned.length).toBeGreaterThan(1);
      const current = await processIdentities();
      const exited = once(f.app.process(), 'exit');
      for (const pid of owned) {
        if (current.get(pid)?.started !== snapshot.get(pid)?.started) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      crashed = true;
      await exited;
      await expect
        .poll(
          async () => {
            const current = await processIdentities();
            return owned.filter((pid) => current.get(pid)?.started === snapshot.get(pid)?.started);
          },
          { timeout: 15_000 },
        )
        .toEqual([]);
      expect(await readdir(f.destination)).toEqual([]);
      const afterCrash = await privateParts(stageDirectory);
      expect(afterCrash).toHaveLength(1);
      expect(afterCrash[0]!.path).toBe(before[0]!.path);
      expect(afterCrash[0]!.bytes).toBeGreaterThanOrEqual(before[0]!.bytes);
      expect(afterCrash[0]!.bytes).toBeLessThan(4 * 1024 * 1024);
      restarted = await launchLevel3Desktop({
        executablePath,
        args: [`--user-data-dir=${f.home}`],
        env: { ...process.env },
      });
      const page = await restarted.firstWindow();
      await page.locator('[data-terminal-channel=ready]').waitFor();
      await page.locator('.app-statusbar [data-runtime-details-trigger]').click();
      await expect(page.getByTestId('runtime-generation')).not.toHaveText(generation);
      await page.keyboard.press('Escape');
      expect(await privateParts(stageDirectory)).toEqual(afterCrash);
      expect(await readdir(f.destination)).toEqual([]);
      await setLevel3NativeSelection(restarted, f.destination, 'open-directory');
      await page
        .locator('[data-terminal-id]:visible')
        .click({ button: 'right', position: { x: 100, y: 100 } });
      await page
        .getByRole('menuitem', {
          name: /Review interrupted downloads|检查中断的下载|中断したダウンロードを確認|檢查中斷的下載/u,
        })
        .click();
      const review = page.getByRole('dialog', {
        name: /Interrupted download files|中断的下载文件|中断したダウンロードファイル|中斷的下載檔案/u,
      });
      await expect(review).toContainText(
        protocol === 'xmodem' ? 'xmodem-download.bin' : 'source.bin',
      );
      expect(await review.textContent()).not.toContain(f.destination);
      expect(await privateParts(stageDirectory)).toEqual(afterCrash);
      await review
        .getByRole('button', {
          name: /Remove partial|删除暂存文件|一時ファイルを削除|刪除暫存檔案/u,
        })
        .click();
      await review
        .getByRole('button', { name: /Confirm removal|确认删除|削除を確定|確認刪除/u })
        .click();
      await expect(review.locator('li')).toHaveCount(0);
      expect(await privateParts(stageDirectory)).toEqual([]);
      expect(await readdir(f.destination)).toEqual([]);
    } finally {
      try {
        if (restarted) await closeLevel3Desktop(restarted);
        if (!crashed) await closeLevel3Desktop(f.app);
      } finally {
        await rm(f.directory, { recursive: true, force: true });
      }
    }
  });
}

test('Host crash rotates the live window generation and requires fresh recovery selection before removing an interrupted receive', async ({
  browserName: _browserName,
}, info) => {
  test.skip(
    process.platform !== 'darwin' || process.env.AXTERM_PACKAGED_TRANSFER_CRASH_PROBE !== '1',
    'Original opt-in macOS generation recovery probe.',
  );
  test.skip(
    info.project.name === 'packaged' && !process.env.AXTERM_LEVEL3_PACKAGE_RESULT,
    'An explicit new isolated package is required.',
  );
  test.setTimeout(90_000);
  const f = await setup('trzsz', Buffer.alloc(4 * 1024 * 1024, 0xa5));
  const stageDirectory = join(f.home, 'profiles/desktop/terminal-stages');
  try {
    await enter(f.input, f.command(f.source, 'stall-after-first-chunk'));
    await expect(f.terminal.locator('.xterm-rows')).toContainText('AXTERM_PEER_READY_SEND');
    await f.input.pressSequentially('!');
    await expect
      .poll(
        async () =>
          (await privateParts(stageDirectory)).reduce((total, file) => total + file.bytes, 0),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    await f.page.locator('.app-statusbar [data-runtime-details-trigger]').click();
    const generation = await f.page.getByTestId('runtime-generation').innerText();
    const pid = Number(await f.page.getByTestId('runtime-process-id').innerText());
    expect(pid).toBeGreaterThan(0);
    await f.page.keyboard.press('Escape');
    const identities = await processIdentities();
    expect(identities.get(pid)?.parent).toBe(f.app.process().pid);
    await f.app.evaluate(({ dialog }) => {
      const state = globalThis as typeof globalThis & { transferRecoveryCount?: number };
      state.transferRecoveryCount = 0;
      dialog.showMessageBox = (async (options: Electron.MessageBoxOptions) => {
        if (
          options.title !== 'Axterm Recovery' ||
          options.message !== 'Axterm could not continue.' ||
          options.buttons?.join(',') !== 'Restart,Disable External Plugins and Restart,Quit'
        )
          throw new Error('Unexpected native recovery prompt');
        state.transferRecoveryCount!++;
        return { response: 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    process.kill(pid, 'SIGKILL');
    await expect
      .poll(() =>
        f.app.evaluate(
          () =>
            (globalThis as typeof globalThis & { transferRecoveryCount?: number })
              .transferRecoveryCount,
        ),
      )
      .toBe(1);
    await expect(f.page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await f.page.locator('[data-terminal-channel=ready]').waitFor();
    await f.page.locator('.app-statusbar [data-runtime-details-trigger]').click();
    await expect(f.page.getByTestId('runtime-generation')).not.toHaveText(generation);
    await f.page.keyboard.press('Escape');
    const preserved = await privateParts(stageDirectory);
    expect(preserved).toHaveLength(1);
    expect(preserved[0]!.bytes).toBeGreaterThan(0);
    expect(await readdir(f.destination)).toEqual([]);
    await setLevel3NativeSelection(f.app, f.destination, 'open-directory');
    await f.page
      .locator('[data-terminal-id]:visible')
      .click({ button: 'right', position: { x: 100, y: 100 } });
    await f.page
      .getByRole('menuitem', {
        name: /Review interrupted downloads|检查中断的下载|中断したダウンロードを確認|檢查中斷的下載/u,
      })
      .click();
    const review = f.page.getByRole('dialog', {
      name: /Interrupted download files|中断的下载文件|中断したダウンロードファイル|中斷的下載檔案/u,
    });
    await expect(review).toContainText('source.bin');
    expect(await review.textContent()).not.toContain(f.destination);
    expect(await privateParts(stageDirectory)).toEqual(preserved);
    await review
      .getByRole('button', { name: /Remove partial|删除暂存文件|一時ファイルを削除|刪除暫存檔案/u })
      .click();
    expect(await privateParts(stageDirectory)).toEqual(preserved);
    await review
      .getByRole('button', { name: /Confirm removal|确认删除|削除を確定|確認刪除/u })
      .click();
    await expect.poll(() => privateParts(stageDirectory)).toEqual([]);
    expect(await readdir(f.destination)).toEqual([]);
  } finally {
    try {
      await closeLevel3Desktop(f.app);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});
