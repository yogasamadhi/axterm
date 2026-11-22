import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch';

test.beforeEach(({ browserName: _browserName }, info) => {
  test.skip(
    info.project.name === 'packaged' && !process.env.AXTERM_LEVEL3_PACKAGE_RESULT,
    'An explicit new-architecture package result is required.',
  );
});

test('the close control remains hittable and applies the platform policy with multiple tabs', async () => {
  test.skip(process.platform === 'darwin', 'Custom native title-bar controls are Windows/Linux.');
  const home = await mkdtemp(resolve(tmpdir(), 'axterm-platform-close-'));
  const app = await launchLevel3Desktop({
    executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
    args: [`--user-data-dir=${home}`],
    env: { ...process.env },
  });
  const child = app.process();
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setBounds({ x: 100, y: 100, width: 800, height: 700 }),
    );
    const tabs = page.locator('[data-workspace-global-tabs]').getByRole('tab');
    for (let index = 0; index < 2; index++) {
      await page.locator('[data-terminal-new]').click();
      await expect(tabs).toHaveCount(index + 2);
    }
    const terminal = page.locator('[data-terminal-id]:visible');
    await expect(terminal).toHaveAttribute('data-terminal-channel', 'ready');
    const terminalId = await terminal.getAttribute('data-terminal-id');
    const close = page.locator('[data-window-action=close]');
    const geometry = await close.evaluate((element) => {
      const controls = element.closest('[data-desktop-window-controls]')!;
      const scroll = document.querySelector('[data-workspace-global-tabs]')!;
      const rect = element.getBoundingClientRect();
      return {
        controlsLeft: controls.getBoundingClientRect().left,
        scrollRight: scroll.getBoundingClientRect().right,
        closeHit: element.contains(
          document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
        ),
      };
    });
    expect(geometry.scrollRight).toBeLessThanOrEqual(geometry.controlsLeft + 1);
    expect(geometry.closeHit).toBe(true);
    await close.hover();
    await expect.poll(() => close.evaluate((button) => button.matches(':hover'))).toBe(true);
    if (process.platform === 'win32') {
      await page.locator('.app-statusbar [data-runtime-details-trigger]').click();
      const hostPid = Number(await page.getByTestId('runtime-process-id').innerText());
      expect(hostPid).toBeGreaterThan(0);
      expect(process.kill(hostPid, 0)).toBe(true);
      await page.keyboard.press('Escape');
      await app.evaluate(({ BrowserWindow, dialog }) => {
        const state = globalThis as typeof globalThis & { quitPrompts: number };
        state.quitPrompts = 0;
        dialog.showMessageBox = (async (options: Electron.MessageBoxOptions) => {
          if (
            options.message !== 'Active tasks may be interrupted.' ||
            options.buttons?.join(',') !== 'Cancel,Quit'
          )
            throw new Error('Unexpected native quit prompt');
          return { response: state.quitPrompts++, checkboxChecked: false };
        }) as typeof dialog.showMessageBox;
        BrowserWindow.getAllWindows()[0]!.focus();
      });
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFocused()),
        )
        .toBe(true);
      await close.click();
      await expect
        .poll(() =>
          app.evaluate(
            () => (globalThis as typeof globalThis & { quitPrompts: number }).quitPrompts,
          ),
        )
        .toBe(1);
      expect(
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
      ).toBe(true);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(tabs).toHaveCount(3);
      expect(process.kill(hostPid, 0)).toBe(true);

      const exited = app.waitForEvent('close');
      await close.click();
      await exited;
      await expect.poll(() => child.exitCode).toBe(0);
      assert.throws(() => process.kill(hostPid, 0), { code: 'ESRCH' });
      return;
    }

    await close.click();
    await page.getByRole('alertdialog').locator('button.danger').click();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()),
      )
      .toBe(false);
    expect(page.isClosed()).toBe(false);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show());
    await expect(tabs).toHaveCount(3);
    await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!);
    await expect(terminal).toHaveAttribute('data-terminal-channel', 'ready');
    const input = terminal.locator('.xterm-helper-textarea');
    await input.pressSequentially("printf 'PLATFORM_%s\\n' HOST_ALIVE");
    await input.press('Enter');
    await expect(terminal.locator('.xterm-rows')).toContainText('PLATFORM_HOST_ALIVE');
  } finally {
    if (child.exitCode === null && child.signalCode === null) await closeLevel3Desktop(app);
    await rm(home, { recursive: true, force: true });
  }
});
