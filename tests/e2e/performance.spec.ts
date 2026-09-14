import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { ProductDatabase } from '../../packages/runtime/src/adapters/sqlite/database';

const require = createRequire(resolve('apps/desktop/package.json'));
const executablePath = require('electron') as string;
const timestamp = '2026-09-14T00:00:00.000Z';
const groupId = '00000000-0000-4000-8000-000000000001';

function id(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}

test('J-09 keeps the 10k bookmark workspace responsive and DOM-bounded', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-performance-e2e-'));
  const database = await ProductDatabase.open(resolve(userData, 'data', 'axterm.sqlite'));
  try {
    database.transaction(() => {
      database.run(
        `INSERT INTO bookmark_groups(
          id, parent_id, name, color, description, position, created_at, updated_at, version
        ) VALUES (?, NULL, 'Performance 10000', NULL, '', 0, ?, ?, 1)`,
        groupId,
        timestamp,
        timestamp,
      );
      for (let index = 0; index < 10_000; index += 1) {
        database.run(
          `INSERT INTO bookmarks(
            id, group_id, protocol, host_id, title, color, description, position,
            profile_id, connection_profile_id, quick_commands_payload, triggers_payload,
            ftp_payload, telnet_payload, serial_payload, rdp_payload, vnc_payload,
            spice_payload, web_payload, created_at, updated_at, version
          ) VALUES (?, ?, 'local', NULL, ?, NULL, '', ?, NULL, NULL, '[]', '[]',
            'null', 'null', 'null', 'null', 'null', 'null', 'null', ?, ?, 1)`,
          id(index + 10),
          groupId,
          `Server ${index.toString().padStart(5, '0')}`,
          index,
          timestamp,
          timestamp,
        );
      }
    });
  } finally {
    database.close();
  }

  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="bookmarks"]').click();

    const group = page.locator('.bookmark-tree-row').filter({ hasText: 'Performance 10000' });
    await expect(group).toBeVisible();
    await page.evaluate(() => performance.mark('j09-expand-start'));
    await group.locator('.bookmark-row-main').click();
    await expect(page.locator('[data-bookmark-title="Server 00000"]')).toBeVisible();
    const expandDuration = await page.evaluate(
      () => performance.now() - performance.getEntriesByName('j09-expand-start').at(-1)!.startTime,
    );
    expect(expandDuration).toBeLessThan(3_000);
    expect(await page.locator('.bookmark-tree-row').count()).toBeLessThanOrEqual(64);
    await expect(page.locator('.bookmark-tree-spacer')).toHaveCSS('height', '260026px');

    const search = page.getByRole('textbox', { name: '搜索书签' });
    await page.evaluate(() => performance.mark('j09-search-start'));
    await search.fill('Server 09999');
    await expect(page.locator('[data-bookmark-title="Server 09999"]')).toBeVisible();
    await expect(page.locator('.bookmark-search-announcement')).toHaveText('1 个匹配');
    const searchDuration = await page.evaluate(
      () => performance.now() - performance.getEntriesByName('j09-search-start').at(-1)!.startTime,
    );
    expect(searchDuration).toBeLessThan(1_500);
    expect(await page.locator('.bookmark-tree-row').count()).toBeLessThanOrEqual(64);

    await search.fill('');
    const viewport = page.locator('.bookmark-tree-viewport');
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.locator('[data-bookmark-title="Server 09999"]')).toBeVisible();
    expect(await page.locator('.bookmark-tree-row').count()).toBeLessThanOrEqual(64);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});
