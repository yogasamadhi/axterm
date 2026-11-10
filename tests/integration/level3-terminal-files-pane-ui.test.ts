import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { expect as browserExpect, type ElectronApplication } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';

it('uses the original per-terminal file surface and native authority without creating another PTY or global tab', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-paired-files-')),
    directory = join(home, 'selected');
  let app: ElectronApplication | undefined,
    nativeProcess: ReturnType<ElectronApplication['process']> | undefined;
  try {
    await mkdir(directory);
    await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        writeFile(join(directory, `z-file-${String(index).padStart(3, '0')}.txt`), ''),
      ),
    );
    await writeFile(join(directory, 'paired-local.txt'), 'PAIRED_FILE_BODY');
    app = await launchLevel3Desktop({
      executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
      args: [resolve('apps/desktop'), `--user-data-dir=${home}`],
      env: { ...process.env },
      timeout: 12000,
    });
    nativeProcess = app.process();
    const page = await app.firstWindow();
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const terminal = page.locator('[data-terminal-channel=ready]');
    await terminal.waitFor();
    await app.evaluate(
      (_, input) => {
        const module = process.getBuiltinModule('node:module');
        const { ElectronFileChooser } = module.createRequire(input.module)(input.module);
        const state = globalThis as typeof globalThis & { pairedSelections?: number };
        state.pairedSelections = 0;
        ElectronFileChooser.prototype.defaultDirectory = function () {
          return input.directory;
        };
        ElectronFileChooser.prototype.choose = async function (kind: string, signal: AbortSignal) {
          signal.throwIfAborted();
          if (kind !== 'open-directory') throw Error('Unexpected native chooser');
          state.pairedSelections!++;
          return input.directory;
        };
      },
      { module: resolve('apps/desktop/lib/shell/file-chooser.js'), directory },
    );
    const id = await terminal.getAttribute('data-terminal-id'),
      toolbar = terminal.locator('.terminal-session-toolbar');
    const globalTabs = page.locator('[data-workspace-global-tabs]').getByRole('tab');
    await browserExpect(globalTabs).toHaveCount(1);
    await toolbar.getByRole('tab', { name: '文件管理', exact: true }).click();
    const files = page.locator('[data-files-workspace]:visible');
    await files.waitFor();
    await browserExpect(files.getByText('paired-local.txt', { exact: true })).toBeVisible();
    await files.getByRole('button', { name: '更换目录', exact: true }).click();
    await browserExpect(files.getByText('paired-local.txt', { exact: true })).toBeVisible();
    expect(
      await app.evaluate(
        () => (globalThis as typeof globalThis & { pairedSelections: number }).pairedSelections,
      ),
    ).toBe(1);
    await toolbar.getByRole('tab', { name: '终端', exact: true }).click();
    await browserExpect(files).toBeHidden();
    const input = terminal.locator('.xterm-helper-textarea');
    await input.pressSequentially("printf 'PAIRED_%s\\n' PTY_OUTPUT");
    await input.press('Enter');
    await browserExpect(terminal.locator('.xterm-rows')).toContainText('PAIRED_PTY_OUTPUT');
    expect(await terminal.getAttribute('data-terminal-id')).toBe(id);
    await toolbar.getByRole('button', { name: '搜索终端', exact: true }).click();
    await browserExpect(terminal.getByRole('search')).toBeVisible();
    await terminal.getByRole('search').locator('input').press('Escape');
    await browserExpect(terminal.getByRole('search')).toBeHidden();
    await toolbar.getByRole('tab', { name: '文件管理', exact: true }).click();
    await browserExpect(files.getByText('paired-local.txt', { exact: true })).toBeVisible();
    expect(
      await app.evaluate(
        () => (globalThis as typeof globalThis & { pairedSelections: number }).pairedSelections,
      ),
    ).toBe(1);
    const pane = files.locator('.file-pane-local'),
      scroll = pane.locator('.file-table-scroll');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1200, 700));
    const compactHeight = await scroll.evaluate((element) => element.clientHeight);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1200, 900));
    await browserExpect
      .poll(() => scroll.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(compactHeight + 150);
    expect(await scroll.evaluate((element) => element.clientHeight)).toBeGreaterThan(400);
    await browserExpect.poll(() => pane.locator('.file-data-row').count()).toBeGreaterThan(20);
    const bottomGap = await pane.evaluate(
      (element) =>
        element.getBoundingClientRect().bottom -
        element.querySelector('.file-table-scroll')!.getBoundingClientRect().bottom,
    );
    expect(bottomGap).toBeLessThan(50);
    await browserExpect(globalTabs).toHaveCount(1);
    await page.locator('[data-workspace-global-tabs] .tab-close').click();
    await browserExpect(globalTabs).toHaveCount(0);
    await browserExpect(page.locator('[data-files-workspace]')).toHaveCount(0);
    expect(errors).toEqual([]);
    await closeLevel3Desktop(app);
    expect(nativeProcess.exitCode).toBe(0);
    app = undefined;
  } finally {
    if (app) {
      if (nativeProcess?.exitCode === null) nativeProcess.kill('SIGKILL');
      await app.close().catch(() => {});
    }
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
