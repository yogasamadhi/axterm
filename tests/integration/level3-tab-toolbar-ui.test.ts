import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { expect as browserExpect, type ElectronApplication } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';
it('uses the retained overflow/current menu for real terminal owners and preserves footer order', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-tab-toolbar-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launchLevel3Desktop({
      executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
      args: [resolve('apps/desktop'), `--user-data-dir=${home}`],
      env: { ...process.env },
      timeout: 12000,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(7000);
    await page.locator('[data-terminal-channel=ready]:visible').waitFor();
    const tabs = page.locator('[data-workspace-global-tabs]').getByRole('tab');
    await browserExpect(tabs).toHaveCount(1);
    const firstId = await tabs.first().getAttribute('data-tab-id');
    await page.locator('[data-current-tab-actions]').click();
    await page.locator('[data-session-action=duplicate]').click();
    await browserExpect(tabs).toHaveCount(2);
    await page.locator('[data-all-tabs]').click();
    await page.locator(`[data-overflow-tab="${firstId}"]`).click();
    await browserExpect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await page.locator('[data-current-tab-actions]').click();
    await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
    const rename = page.getByRole('dialog');
    await rename.getByRole('textbox').fill('Retained toolbar title');
    await rename.getByRole('textbox').press('Enter');
    await browserExpect(tabs.first()).toHaveAttribute('aria-label', 'Retained toolbar title');
    const before = await tabs.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-tab-id')),
    );
    await page.locator('[data-current-tab-actions]').click();
    await page.locator('[data-session-action=reload-all]').click();
    await browserExpect(page.locator('[data-terminal-channel=ready]')).toHaveCount(2);
    await expect
      .poll(
        async () =>
          (
            await tabs.evaluateAll((elements) =>
              elements.map((element) => element.getAttribute('data-tab-id')),
            )
          ).every((id) => !before.includes(id)),
        { timeout: 7000 },
      )
      .toBe(true);
    const footer = page.locator('footer.app-statusbar');
    const order = await footer
      .locator(
        '.batch-input-trigger,.status-quick-command,.status-command-history,.status-information,.status-transfer,[data-terminal-kind]',
      )
      .evaluateAll((elements) =>
        elements.map((element) =>
          element.classList.contains('batch-input-trigger')
            ? 'batch'
            : element.classList.contains('status-quick-command')
              ? 'quick'
              : element.classList.contains('status-command-history')
                ? 'history'
                : element.classList.contains('status-information')
                  ? 'information'
                  : element.classList.contains('status-transfer')
                    ? 'transfers'
                    : 'kind',
        ),
      );
    expect(order).toEqual(['batch', 'quick', 'history', 'information', 'transfers', 'kind']);
    await page.locator('[data-terminal-information-toggle]').click();
    await browserExpect(page.locator('.terminal-information-panel')).toBeVisible();
    await closeLevel3Desktop(app);
    app = undefined;
  } catch (error) {
    if (app)
      await writeFile(
        'out/level3-migration/sdk/tab-toolbar-ui-diagnostic.json',
        JSON.stringify({
          bodies: await Promise.all(
            app.windows().map(async (page) => ({
              body: await page
                .locator('body')
                .innerText()
                .catch(() => '<closed>'),
              tabs: await page
                .locator('[data-workspace-global-tabs] [role=tab]')
                .evaluateAll((elements) => elements.map((e) => e.getAttribute('data-tab-id')))
                .catch(() => []),
            })),
          ),
        }),
      );
    throw error;
  } finally {
    if (app) {
      app.process().kill('SIGKILL');
      await app.close().catch(() => {});
    }
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
