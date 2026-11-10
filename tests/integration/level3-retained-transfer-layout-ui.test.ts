import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { expect as ui, type ElectronApplication } from '@playwright/test';
import { seedLevel3CompletedTransfer } from '../fixtures/level3-transfer-history.ts';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';
import { openLevel3Settings } from '../support/level3-workspace-actions.ts';

it('retains27 long-path transfer facts and original viewport, scrolling and control bounds through200percent zoom', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-owned-transfer-layout-'));
  let app: ElectronApplication | undefined;
  try {
    await seedLevel3CompletedTransfer(home, 27, true);
    app = await launchLevel3Desktop({
      executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
      args: [resolve('apps/desktop'), `--user-data-dir=${home}`],
      env: { ...process.env },
      timeout: 12000,
    });
    const page = await app.firstWindow();
    page.setDefaultTimeout(6000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.locator('[data-transfers-trigger]').click();
    const center = page.getByRole('dialog', { name: 'Transfer center', exact: true });
    await ui(center.locator('article')).toHaveCount(20);
    await center.locator('.transfer-center-more').click();
    await ui(center.locator('article')).toHaveCount(27);
    const screenshots = resolve('out/level3-migration/sdk/retained-transfer-layout');
    await mkdir(screenshots, { recursive: true });
    for (const [width, height, zoom] of [
      [1440, 900, 1],
      [1024, 768, 1.5],
      [800, 580, 2],
    ] as const) {
      const contentSize = await app.evaluate(
        ({ BrowserWindow }, dimensions) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          window.setBounds({ x: 0, y: 0, width: dimensions.width, height: dimensions.height });
          window.webContents.setZoomFactor(dimensions.zoom);
          return window.getContentSize();
        },
        { width, height, zoom },
      );
      await ui
        .poll(async () =>
          Math.abs((await page.evaluate(() => innerWidth)) - contentSize[0]! / zoom),
        )
        .toBeLessThanOrEqual(1);
      await ui
        .poll(async () =>
          Math.abs((await page.evaluate(() => innerHeight)) - contentSize[1]! / zoom),
        )
        .toBeLessThanOrEqual(1);
      const layout = await center.evaluate((element) => {
        const bounds = element.getBoundingClientRect(),
          list = element.querySelector('.transfer-center-list')!,
          controls = Array.from(
            element.querySelectorAll(':scope > header button, :scope > footer button'),
          );
        return {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          overflow: element.scrollWidth - element.clientWidth,
          controlsInside: controls.every((button) => {
            const rect = button.getBoundingClientRect();
            return (
              rect.left >= bounds.left &&
              rect.right <= bounds.right &&
              rect.top >= bounds.top &&
              rect.bottom <= bounds.bottom
            );
          }),
          listHeight: list.clientHeight,
          listOverflow: list.scrollWidth - list.clientWidth,
          canScroll: list.scrollHeight > list.clientHeight,
        };
      });
      expect(layout.left).toBeGreaterThanOrEqual(0);
      expect(layout.top).toBeGreaterThanOrEqual(0);
      expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight);
      expect(layout.overflow).toBeLessThanOrEqual(1);
      expect(layout.controlsInside).toBe(true);
      expect(layout.listHeight).toBeGreaterThan(30);
      expect(layout.listOverflow).toBeLessThanOrEqual(1);
      expect(layout.canScroll).toBe(true);
      await center.locator('.transfer-center-list').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await ui(center.locator('article').last()).toBeInViewport();
      await page.screenshot({ path: join(screenshots, `transfer-center-${width}-${zoom}.png`) });
    }
    expect(errors).toEqual([]);
  } finally {
    if (app) await closeLevel3Desktop(app);
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
