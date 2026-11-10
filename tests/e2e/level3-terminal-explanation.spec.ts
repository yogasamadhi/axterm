import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch';
import { configureLevel3ModelNames } from '../fixtures/level3-ai-model-names';
const executablePath = createRequire(resolve('apps/desktop/package.json'))('electron') as string;
test('terminal context keeps log actions and prepares a redacted AI draft through actual owners', async () => {
  test.skip(process.platform === 'win32', 'This fixture uses a POSIX shell.');
  const home = await mkdtemp(resolve(tmpdir(), 'axterm-selection-explanation-'));
  const app = await launchLevel3Desktop({
    executablePath,
    args: [`--user-data-dir=${home}`],
    env: { ...process.env },
  });
  try {
    const page = await app.firstWindow(),
      errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await configureLevel3ModelNames(page, ['Selection explanation fixture']);
    await page.locator('[data-ai-sidebar-toggle]').click();
    await page.getByRole('button', { name: '新建终端', exact: true }).first().click();
    const layer = page.locator('[data-terminal-channel]:visible');
    await expect(layer).toHaveAttribute('data-terminal-channel', 'ready');
    const input = layer.locator('.xterm-helper-textarea');
    const selected = 'AXTERM_EXPLAIN AI_MODEL_NAME_TEST_KEY';
    await input.pressSequentially(`printf '\\n${selected}\\n'`);
    await input.press('Enter');
    const row = layer.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^${selected}$`) });
    await expect(row).toHaveCount(1);
    const cell = await row.locator('span').first().boundingBox();
    if (!cell) throw Error('Missing selected output row');
    await page.mouse.move(cell.x + 1, cell.y + cell.height / 2);
    await page.mouse.down();
    await page.mouse.move(cell.x + cell.width + 1, cell.y + cell.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(layer.locator('.xterm-selection div')).not.toHaveCount(0);
    await page.mouse.click(cell.x + 15, cell.y + cell.height / 2, { button: 'right' });
    const menu = page.getByRole('menu', { name: '终端菜单' });
    await expect(menu.getByRole('menuitem', { name: '保存终端日志', exact: true })).toBeEnabled();
    await expect(menu.getByRole('menuitem', { name: '录制', exact: true })).toBeEnabled();
    await menu.getByRole('menuitem', { name: '使用 AI 解释', exact: true }).click();
    const prompt = page.locator('textarea[name=prompt]:visible');
    await expect(prompt).toHaveValue(/AXTERM_EXPLAIN.*\[REDACTED_KNOWN_SECRET\]/s);
    await expect(prompt).not.toHaveValue(/AI_MODEL_NAME_TEST_KEY/);
    expect(errors).toEqual([]);
  } finally {
    await closeLevel3Desktop(app);
    await rm(home, { recursive: true, force: true });
  }
});
