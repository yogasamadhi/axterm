import { dictionaries as workspaceDictionaries } from '../../packages/plugins/workspace/src/client/locales';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch';

test('window navigation spans both edges and sidebars start below it', async ({
  browserName: _browserName,
}, info) => {
  const packaged = info.project.name === 'packaged' || !!process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
  const candidate = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
  test.skip(packaged && !candidate, 'An explicit isolated package is required');
  const executablePath = createRequire(resolve('apps/desktop/package.json'))('electron') as string;
  const root = await mkdtemp(join(tmpdir(), 'axterm-navigation-'));
  const app = await launchLevel3Desktop({
    executablePath,
    args: [`--user-data-dir=${root}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    const tabs = page.locator('[data-workspace-global-tabs] [role=tab]');
    await expect(tabs).toHaveCount(1);
    const checkLayout = async () => {
      const boxes = await page.locator('.app-shell').evaluate((shell) => {
        const rect = (element: Element) => {
          const r = element.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        };
        return {
          shell: rect(shell),
          navigation: rect(shell.querySelector(':scope > .tabbar')!),
          rail: rect(shell.querySelector('.activity-bar')!),
          main: rect(shell.querySelector('.workspace-main')!),
          sessions: Array.from(
            shell.querySelectorAll<HTMLElement>('.workspace-session:not([hidden])'),
          ).map((session) => {
            return rect(session);
          }),
          sidebarTitle: shell
            .querySelector(':scope > .workspace-sidebar > .explorer-header')
            ?.getClientRects().length
            ? rect(shell.querySelector(':scope > .workspace-sidebar > .explorer-header')!)
            : undefined,
          paneHeaders: Array.from(
            shell.querySelectorAll<HTMLElement>('.terminal-pane:not([hidden]) .pane-tabbar'),
          ).map(rect),
          sidebarBody: Array.from(
            shell.querySelector(':scope > .workspace-sidebar')?.children ?? [],
          )
            .filter(
              (element) =>
                !element.classList.contains('explorer-header') && element.getClientRects().length,
            )
            .map(rect),
          sidebar: shell.querySelector(':scope > .workspace-sidebar')?.getClientRects().length
            ? rect(shell.querySelector(':scope > .workspace-sidebar')!)
            : undefined,
        };
      });
      expect(boxes.navigation.left).toBe(boxes.shell.left);
      expect(boxes.navigation.right).toBe(boxes.shell.right);
      expect(boxes.navigation.top).toBe(boxes.shell.top);
      expect(boxes.rail.top).toBeGreaterThanOrEqual(boxes.navigation.bottom);
      expect(boxes.main.top).toBeGreaterThanOrEqual(boxes.navigation.bottom);
      for (const session of boxes.sessions) {
        const paneHeader = boxes.paneHeaders.find(
          (header) =>
            header.left <= (session.left + session.right) / 2 &&
            header.right > (session.left + session.right) / 2,
        );
        expect(session.top, JSON.stringify(boxes)).toBe(paneHeader?.bottom ?? boxes.main.top);
      }
      if (boxes.sidebar && boxes.sidebarTitle) {
        expect(boxes.sidebar.top).toBe(boxes.sidebarTitle.top);
        expect(boxes.sidebarTitle.top).toBe(boxes.navigation.top);
        expect(boxes.sidebarTitle.bottom).toBe(boxes.navigation.bottom);
      }
      for (const body of boxes.sidebarBody)
        expect(body.top).toBeGreaterThanOrEqual(boxes.navigation.bottom);
    };
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(packaged);
    await checkLayout();
    await page.locator('[data-ai-sidebar-toggle]').click();
    await expect(page.locator('.ai-inspector')).toBeVisible();
    await checkLayout();
    await page.screenshot({ path: 'out/full-width-navigation-ai.png' });
    await page.locator('[data-ai-sidebar-toggle]').click();
    await page.locator('[data-activity-item="bookmarks"]').click();
    await expect(page.locator('aside.workspace-sidebar')).toBeVisible();
    await checkLayout();
    await page.screenshot({ path: 'out/full-width-navigation-bookmarks.png' });
    await page.locator('.layout-toggle').click();
    await page.locator('[data-layout-choice="c2"]').click();
    await expect(page.locator('.terminal-pane')).toHaveCount(2);
    await checkLayout();
    const panes = page.locator('.terminal-pane');
    await panes.nth(1).click();
    await panes.nth(1).locator('[data-terminal-new]').click();
    await expect(tabs).toHaveCount(2);
    const second = tabs.nth(1);
    const secondPanel = page.locator('[id="' + (await second.getAttribute('aria-controls')) + '"]');
    const language = await page.locator('html').getAttribute('lang');
    const paneText =
      workspaceDictionaries[language as keyof typeof workspaceDictionaries] ??
      workspaceDictionaries.en;
    await panes.nth(1).getByRole('button', { name: paneText.maximizePane, exact: true }).click();
    await expect(panes.nth(0)).toBeHidden();
    await expect(secondPanel).toBeVisible();
    await expect(second).toHaveAttribute('aria-selected', 'true');
    await checkLayout();
    await panes.nth(1).getByRole('button', { name: paneText.restorePane, exact: true }).click();
    await expect(panes.nth(0)).toBeVisible();
    await expect(panes.nth(1)).toBeVisible();
    await expect(secondPanel).toBeVisible();
    await checkLayout();
  } finally {
    await closeLevel3Desktop(app);
    await rm(root, { recursive: true, force: true });
  }
});
