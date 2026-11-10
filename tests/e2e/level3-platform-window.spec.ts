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

test('Windows and Linux close control remains hittable and hides a multi-tab window while the Host runs', async () => {
  test.skip(process.platform === 'darwin', 'Custom native title-bar controls are Windows/Linux.');
  const home = await mkdtemp(resolve(tmpdir(), 'axterm-platform-close-'));
  const app = await launchLevel3Desktop({
    executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
    args: [`--user-data-dir=${home}`],
    env: { ...process.env },
  });
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
    await close.click();
    // Approved desktop architecture: ordinary close hides the window; explicit Quit owns task review.
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
    await input.pressSequentially(
      process.platform === 'win32'
        ? "Write-Output ('PLATFORM_' + 'HOST_ALIVE')"
        : "printf 'PLATFORM_%s\\n' HOST_ALIVE",
    );
    await input.press('Enter');
    await expect(terminal.locator('.xterm-rows')).toContainText('PLATFORM_HOST_ALIVE');
  } finally {
    await closeLevel3Desktop(app);
    await rm(home, { recursive: true, force: true });
  }
});
