import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchLocalOptimizationApp } from '../fixtures/local-optimization-launch';

test('window navigation spans both edges and sidebars start below it', async ({
  browserName: _browserName,
}, info) => {
  const packaged = info.project.name === 'packaged';
  const candidate = process.env.AXTERM_NAVIGATION_APP;
  test.skip(packaged && !candidate, 'An explicit isolated package is required');
  const executablePath = packaged
    ? join(candidate!, 'Axterm.exe')
    : (createRequire(resolve('apps/desktop/package.json'))('electron') as string);
  const root = await mkdtemp(join(tmpdir(), 'axterm-navigation-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [
      ...(packaged ? [] : [resolve('apps/desktop')]),
      `--user-data-dir=${join(root, 'user-data')}`,
    ],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.workspace-primary-tabs .terminal-tab')).toHaveCount(1);
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
          paneHeader: rect(shell.querySelector('.terminal-pane[data-global-tabs] > header')!),
          session: rect(
            shell.querySelector('.terminal-session-layer[data-global-tabs]:not([hidden])')!,
          ),
          sidebar: shell.querySelector('.workspace-sidebar')?.getClientRects().length
            ? rect(shell.querySelector('.workspace-sidebar')!)
            : undefined,
        };
      });
      expect(boxes.navigation.left).toBe(boxes.shell.left);
      expect(boxes.navigation.right).toBe(boxes.shell.right);
      expect(boxes.navigation.top).toBe(boxes.shell.top);
      expect(boxes.rail.top).toBeGreaterThanOrEqual(boxes.navigation.bottom);
      expect(boxes.main.top).toBeGreaterThanOrEqual(boxes.navigation.bottom);
      expect(boxes.session.top).toBe(boxes.paneHeader.bottom);
      if (boxes.sidebar) expect(boxes.sidebar.top).toBeGreaterThanOrEqual(boxes.navigation.bottom);
    };
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(packaged);
    await checkLayout();
    await page.locator('[data-activity-item="ai"]').click();
    await expect(page.locator('.ai-inspector')).toBeVisible();
    await checkLayout();
    await page.screenshot({ path: 'out/full-width-navigation-ai.png' });
    await page.locator('[data-activity-item="ai"]').click();
    await page.locator('[data-activity-item="bookmarks"]').click();
    await expect(page.locator('.workspace-sidebar')).toBeVisible();
    await checkLayout();
    await page.screenshot({ path: 'out/full-width-navigation-bookmarks.png' });
    await page.getByTitle('布局与工作区', { exact: true }).click();
    await page.locator('[data-layout-choice="c2"]').click();
    await expect(page.locator('.terminal-pane')).toHaveCount(2);
    await checkLayout();
    await page.locator('.terminal-pane').nth(1).locator('.tab-add').click();
    await page.getByRole('button', { name: '最大化窗格 2', exact: true }).click();
    await expect(page.locator('.workspace-primary-tabs .pane-tabbar')).toHaveAttribute(
      'data-pane-index',
      '1',
    );
    await checkLayout();
    await page.getByRole('button', { name: '还原窗格 2', exact: true }).click();
    await expect(page.locator('.workspace-primary-tabs .pane-tabbar')).toHaveAttribute(
      'data-pane-index',
      '0',
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
