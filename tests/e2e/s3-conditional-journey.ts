import { expect, type Page } from '@playwright/test';

const locales = [
  {
    id: 'en',
    sessionTools: 'Session tools',
    fileTab: 'File manager',
    terminalMenu: 'Terminal menu',
    searchOutput: 'Find terminal output',
    searchFound: 'Found',
    searchNoMatch: 'No matches',
    searchInvalidRegex: 'The regular expression is invalid.',
    regex: 'Use regular expression',
    localFiles: 'Local files',
    localTable: 'Local file table',
    localLoadFailed: 'Unable to load local files. Check access and retry.',
    refreshLocal: 'Refresh local directory',
    transferCenter: 'Transfer center',
    transferEmpty: 'Upload and download tasks will appear here',
    transferLoadFailed: 'Unable to load transfers. Check the connection and retry.',
    transferSucceeded: 'Completed',
    retry: 'Retry',
  },
  {
    id: 'ja',
    sessionTools: 'セッションツール',
    fileTab: 'ファイルマネージャー',
    terminalMenu: 'ターミナルメニュー',
    searchOutput: 'ターミナル出力を検索',
    searchFound: '見つかりました',
    searchNoMatch: '一致なし',
    searchInvalidRegex: '正規表現が無効です。',
    regex: '正規表現を使用',
    localFiles: 'ローカルファイル',
    localTable: 'ローカルファイルの表',
    localLoadFailed:
      'ローカルファイルを読み込めませんでした。アクセス権を確認して再試行してください。',
    refreshLocal: 'ローカルディレクトリを更新',
    transferCenter: '転送センター',
    transferEmpty: 'アップロードとダウンロードのタスクがここに表示されます',
    transferLoadFailed: '転送タスクを読み込めませんでした。接続を確認して再試行してください。',
    transferSucceeded: '完了',
    retry: '再試行',
  },
  {
    id: 'zh-CN',
    sessionTools: '会话工具',
    fileTab: '文件管理',
    terminalMenu: '终端菜单',
    searchOutput: '查找终端输出',
    searchFound: '已找到',
    searchNoMatch: '无匹配',
    searchInvalidRegex: '正则表达式无效。',
    regex: '使用正则表达式',
    localFiles: '本地文件',
    localTable: '本地文件表格',
    localLoadFailed: '无法读取本地文件，请检查访问权限后重试。',
    refreshLocal: '刷新本地目录',
    transferCenter: '传输中心',
    transferEmpty: '上传和下载任务会显示在这里',
    transferLoadFailed: '无法读取传输任务，请检查连接后重试。',
    transferSucceeded: '已完成',
    retry: '重试',
  },
  {
    id: 'zh-TW',
    sessionTools: '工作階段工具',
    fileTab: '檔案管理員',
    terminalMenu: '終端機選單',
    searchOutput: '搜尋終端機輸出',
    searchFound: '已找到',
    searchNoMatch: '沒有相符結果',
    searchInvalidRegex: '正規表示式無效。',
    regex: '使用規則運算式',
    localFiles: '本機檔案',
    localTable: '本機檔案表格',
    localLoadFailed: '無法載入本機檔案，請檢查存取權限後重試。',
    refreshLocal: '重新整理本機目錄',
    transferCenter: '傳輸中心',
    transferEmpty: '上傳與下載工作會顯示在這裡',
    transferLoadFailed: '無法載入傳輸工作，請檢查連線後重試。',
    transferSucceeded: '已完成',
    retry: '重試',
  },
] as const;

const canary = 's3-read-secret-canary-do-not-display';
const failedRead = JSON.stringify({
  type: 'about:blank',
  title: 'Synthetic read failure',
  status: 500,
  detail: canary,
});
const transfer = {
  id: '00000000-0000-4000-8000-000000000003',
  connectionId: '00000000-0000-4000-8000-000000000004',
  direction: 'upload',
  state: 'succeeded',
  bytesTransferred: 64,
  totalBytes: 64,
  createdAt: '2026-09-25T00:00:00.000Z',
  updatedAt: '2026-09-25T00:00:01.000Z',
};

async function assertHorizontalBounds(page: Page, selector: string): Promise<void> {
  const bounds = await page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: innerWidth };
  });
  expect(bounds.left, selector).toBeGreaterThanOrEqual(-1);
  expect(bounds.right, selector).toBeLessThanOrEqual(bounds.viewport + 1);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    .toBe(true);
}

export async function verifyFourLocaleS3ConditionalJourney(page: Page): Promise<void> {
  let failLocal = false;
  let transferMode: 'empty' | 'normal' | 'failed' = 'empty';
  await page.route('**/api/v1/file-grants/*/list', async (route) => {
    if (route.request().method() !== 'POST' || !failLocal) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 500,
      contentType: 'application/problem+json',
      body: failedRead,
    });
  });
  await page.route('**/api/v1/transfers', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    if (transferMode === 'failed') {
      await route.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        body: failedRead,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(transferMode === 'normal' ? [transfer] : []),
    });
  });

  for (const locale of locales) {
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('.settings-workspace-tabs button').nth(1).click();
    await page.locator('[data-settings-category="common"]').click();
    await page.getByTestId('application-language').selectOption(locale.id);
    await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
    await page.locator('[data-activity-item="setting"]').focus();
    await page.keyboard.press('Alt+q');
    await expect(page.locator('.app-shell')).toHaveClass(/surface-terminal/u);
    const shell = page.locator('.app-shell');
    if (!(await shell.getAttribute('class'))?.includes('sidebar-collapsed')) {
      await page.keyboard.press('Meta+b');
      await expect(shell).toHaveClass(/sidebar-collapsed/u);
    }

    const layer = page.locator('.terminal-session-layer:not([hidden])');
    const host = layer.locator('.terminal-host');
    const input = layer.locator('.xterm-helper-textarea');
    await expect(host).toHaveAttribute('data-connection-state', 'connected');
    await host.click({ button: 'right', position: { x: 20, y: 20 } });
    const menu = page.getByRole('menu', { name: locale.terminalMenu });
    await expect(menu).toBeVisible();
    await assertHorizontalBounds(page, '.terminal-context-menu');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    const token = `AXTERM_S3_${locale.id.replace('-', '_')}_READY`;
    await input.pressSequentially(`printf '\\n${token}\\n'`);
    await input.press('Enter');
    await input.press('Meta+f');
    const search = layer.getByRole('textbox', { name: locale.searchOutput });
    await expect(search).toBeFocused();
    await assertHorizontalBounds(page, '.terminal-search');
    await search.fill(token);
    await expect(layer.locator('.terminal-search-result')).toHaveText(locale.searchFound);
    await expect(layer.locator('.terminal-search-count')).toHaveText(/\d+\/[1-9]\d*/u);
    await search.fill('S3_UNMATCHED_OUTPUT');
    await expect(layer.locator('.terminal-search-result')).toHaveText(locale.searchNoMatch);
    const regex = layer.getByRole('button', { name: locale.regex });
    if ((await regex.getAttribute('aria-pressed')) !== 'true') await regex.click();
    await search.fill('[');
    await expect(search).toHaveAttribute('aria-invalid', 'true');
    await expect(layer.locator('.terminal-search-result')).toHaveText(locale.searchInvalidRegex);
    await search.press('Escape');
    await expect(search).toHaveCount(0);

    await page
      .getByRole('tablist', { name: locale.sessionTools })
      .getByRole('tab', { name: locale.fileTab })
      .click();
    const local = page.getByRole('region', { name: locale.localFiles });
    await expect(local).toBeVisible();
    const localTable = local.locator('.file-table');
    await expect(localTable).toHaveAttribute('aria-label', locale.localTable);
    await expect(localTable).toBeVisible();
    failLocal = true;
    await local
      .locator('.file-address-bar')
      .getByRole('button', { name: locale.refreshLocal })
      .click();
    const localRecovery = local.locator('.file-pane-recovery');
    await expect(localRecovery.getByRole('alert')).toHaveText(locale.localLoadFailed);
    await expect(localTable).toHaveCount(0);
    await expect(page.getByText(canary)).toHaveCount(0);
    const localRetry = localRecovery.getByRole('button', { name: locale.refreshLocal });
    await localRetry.scrollIntoViewIfNeeded();
    await expect(localRetry).toBeInViewport();
    await assertHorizontalBounds(page, '.file-pane-recovery');
    failLocal = false;
    await localRetry.focus();
    await expect(localRetry).toBeFocused();
    await localRetry.press('Enter');
    await expect(localRecovery).toHaveCount(0);
    await expect(localTable).toBeVisible();

    transferMode = 'empty';
    await page.locator('.status-transfer').click();
    const center = page.getByRole('complementary', { name: locale.transferCenter });
    await expect(center).toBeVisible();
    await expect(center.locator('.transfer-center-empty')).toHaveText(locale.transferEmpty);
    await assertHorizontalBounds(page, '.transfer-center');
    transferMode = 'normal';
    await expect(center.locator('article')).toContainText(locale.transferSucceeded);
    transferMode = 'failed';
    const transferRecovery = center.getByRole('alert');
    await expect(transferRecovery).toContainText(locale.transferLoadFailed);
    await expect(center.locator('article')).toHaveCount(0);
    await expect(page.getByText(canary)).toHaveCount(0);
    transferMode = 'empty';
    const transferRetry = transferRecovery.getByRole('button', { name: locale.retry });
    await transferRetry.focus();
    await expect(transferRetry).toBeFocused();
    await transferRetry.press('Enter');
    await expect(transferRecovery).toHaveCount(0);
    await expect(center.locator('.transfer-center-empty')).toHaveText(locale.transferEmpty);
    await page.locator('.status-transfer').click();
  }
}
