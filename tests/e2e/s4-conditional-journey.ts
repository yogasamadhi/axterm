import {
  installLevel3StreamFaults,
  setLevel3StreamFault,
  level3StreamOpens,
} from '../support/level3-stream-faults';
import { selectLevel3Language } from '../support/level3-language';
import { openWidgets, openTerminalThemes } from './settings-workspace-navigation';
import { expect, type Page } from '@playwright/test';

const locales = [
  {
    id: 'en',
    provider: 'Provider',
    themeList: 'Terminal-theme list',
    themeSearch: 'Search terminal themes',
    themeLoadFailed: 'Unable to load themes. Retry to see current themes.',
    themeNoMatches: 'No matching themes.',
    widgetList: 'Widget list',
    widgetCatalog: 'Built-in Widgets',
    widgetSearch: 'Search Widgets',
    widgetLoadFailed: 'Unable to load Widgets. Retry to see the current list.',
    widgetNoMatches: 'No matching Widgets',
    widgetInstancesLoadFailed: 'Unable to load running instances. Retry to see current status.',
    widgetNoRunning: 'No running instances',
    runningUnavailable: 'Running instances (unavailable)',
    aiInspector: 'AI Assistant',
    aiConfig: 'AI Config',
    aiChatWorkspace: 'AI chat workspace',
    aiHistoryLoadFailed: 'Unable to load chat history. Retry to see current conversations.',
    aiNoHistory: 'No chat history yet',
    aiEmptyConversation: 'How can I help with this terminal?',
    cancel: 'Cancel',
    retry: 'Retry',
  },
  {
    id: 'ja',
    provider: 'プロバイダー',
    themeList: '端末テーマ一覧',
    themeSearch: '端末テーマを検索',
    themeLoadFailed: 'テーマを読み込めませんでした。再試行して現在のテーマを確認してください。',
    themeNoMatches: '一致するテーマはありません。',
    widgetList: 'ウィジェット一覧',
    widgetCatalog: '組み込みウィジェット',
    widgetSearch: 'ウィジェットを検索',
    widgetLoadFailed:
      'ウィジェットを読み込めませんでした。再試行して現在の一覧を確認してください。',
    widgetNoMatches: '一致するウィジェットはありません',
    widgetInstancesLoadFailed:
      '実行中のインスタンスを読み込めませんでした。再試行して現在の状態を確認してください。',
    widgetNoRunning: '実行中のインスタンスはありません',
    runningUnavailable: '実行中のインスタンス（取得不可）',
    aiInspector: 'AI アシスタント',
    aiConfig: 'AI 設定',
    aiChatWorkspace: 'AI チャットワークスペース',
    aiHistoryLoadFailed:
      'チャット履歴を読み込めませんでした。再試行して現在の会話を確認してください。',
    aiNoHistory: 'チャット履歴はまだありません',
    aiEmptyConversation: 'このターミナルについて何をお手伝いできますか？',
    cancel: 'キャンセル',
    retry: '再試行',
  },
  {
    id: 'zh-CN',
    provider: 'Provider',
    themeList: '终端主题列表',
    themeSearch: '搜索终端主题',
    themeLoadFailed: '无法读取主题，请重试以查看当前主题。',
    themeNoMatches: '没有匹配的主题。',
    widgetList: 'Widget 列表',
    widgetCatalog: '内置 Widgets',
    widgetSearch: '搜索 Widgets',
    widgetLoadFailed: '无法读取 Widget，请重试以查看当前列表。',
    widgetNoMatches: '没有匹配的 Widget',
    widgetInstancesLoadFailed: '无法读取运行中的实例，请重试以查看当前状态。',
    widgetNoRunning: '没有运行中的实例',
    runningUnavailable: '运行中的实例（暂不可用）',
    aiInspector: 'AI 助手',
    aiConfig: 'AI 配置',
    aiChatWorkspace: 'AI 聊天工作区',
    aiHistoryLoadFailed: '无法读取聊天历史，请重试以查看当前对话。',
    aiNoHistory: '还没有聊天历史',
    aiEmptyConversation: '需要我协助处理什么终端任务？',
    cancel: '取消',
    retry: '重试',
  },
  {
    id: 'zh-TW',
    provider: '供應商',
    themeList: '終端機主題清單',
    themeSearch: '搜尋終端機主題',
    themeLoadFailed: '無法載入主題，請重試以查看目前的主題。',
    themeNoMatches: '沒有相符的主題。',
    widgetList: '小工具清單',
    widgetCatalog: '內建小工具',
    widgetSearch: '搜尋小工具',
    widgetLoadFailed: '無法載入小工具，請重試以查看目前的清單。',
    widgetNoMatches: '沒有符合的小工具',
    widgetInstancesLoadFailed: '無法載入執行中的執行個體，請重試以查看目前的狀態。',
    widgetNoRunning: '沒有執行中的執行個體',
    runningUnavailable: '執行中的執行個體（暫時無法取得）',
    aiInspector: 'AI 助手',
    aiConfig: 'AI 設定',
    aiChatWorkspace: 'AI 聊天工作區',
    aiHistoryLoadFailed: '無法載入聊天記錄，請重試以查看目前的對話。',
    aiNoHistory: '尚無聊天記錄',
    aiEmptyConversation: '這個終端機需要什麼協助？',
    cancel: '取消',
    retry: '重試',
  },
] as const;

const canary = 's4-runtime-secret-canary-do-not-display';

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

export async function verifyFourLocaleS4ConditionalJourney(page: Page): Promise<void> {
  await installLevel3StreamFaults(page);
  for (const locale of locales) {
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('.settings-workspace-tabs button').nth(1).click();
    await page.locator('[data-settings-category="common"]').click();
    await selectLevel3Language(page, locale.id);
    await expect(page.locator('html')).toHaveAttribute('lang', locale.id);

    await setLevel3StreamFault(page, 'terminals/watchTerminalFacts', true, canary);
    await openTerminalThemes(page);
    const themeList = page.getByRole('complementary', { name: locale.themeList });
    const themeRecovery = themeList.getByRole('alert');
    await expect(themeRecovery).toHaveText(locale.themeLoadFailed + locale.retry);
    await expect(themeList.locator('.terminal-theme-list-item')).toHaveCount(0);
    await expect(themeList.getByText(locale.themeNoMatches)).toHaveCount(0);
    await expect(page.getByText(canary)).toHaveCount(0);
    await assertHorizontalBounds(page, '.terminal-theme-recovery');
    await setLevel3StreamFault(page, 'terminals/watchTerminalFacts', false, canary);
    const themeRetry = themeRecovery.getByRole('button', { name: locale.retry });
    await themeRetry.focus();
    await expect(themeRetry).toBeFocused();
    await expect(themeRetry).toBeInViewport();
    await themeRetry.press('Enter');
    await expect(themeRecovery).toHaveCount(0);
    await expect(themeList.locator('.terminal-theme-list-item:not(.new)').first()).toBeVisible();
    const themeSearch = themeList.getByRole('textbox', { name: locale.themeSearch });
    await themeSearch.fill(`AXTERM_S4_NO_THEME_${locale.id}`);
    await expect(themeList.getByText(locale.themeNoMatches)).toBeVisible();
    await themeSearch.clear();
    await expect(themeList.locator('.terminal-theme-list-item:not(.new)').first()).toBeVisible();

    await setLevel3StreamFault(page, 'automation/watchWidgets', true, canary);
    await openWidgets(page);
    const widgetCatalog = page.getByRole('group', { name: locale.widgetCatalog });
    const widgetRecovery = widgetCatalog.getByRole('alert');
    await expect(widgetRecovery).toContainText(locale.widgetLoadFailed);
    await expect(widgetCatalog.getByText(locale.widgetNoMatches)).toHaveCount(0);
    await expect(page.getByText(canary)).toHaveCount(0);
    await assertHorizontalBounds(page, '.widget-recovery');
    await setLevel3StreamFault(page, 'automation/watchWidgets', false, canary);
    const widgetRetry = widgetRecovery.getByRole('button', { name: locale.retry });
    await widgetRetry.focus();
    await expect(widgetRetry).toBeFocused();
    await expect(widgetRetry).toBeInViewport();
    await widgetRetry.press('Enter');
    await expect(widgetRecovery).toHaveCount(0);
    await expect(widgetCatalog.getByRole('button').first()).toBeVisible();
    const widgetSearch = page.getByRole('textbox', { name: locale.widgetSearch });
    await widgetSearch.fill(`AXTERM_S4_NO_WIDGET_${locale.id}`);
    await expect(widgetCatalog.getByText(locale.widgetNoMatches)).toBeVisible();
    await widgetSearch.clear();
    // Catalog and instances now share one complete owner baseline; independently fail its next read for the instance segment.
    await setLevel3StreamFault(page, 'automation/watchWidgets', true, canary);
    const widgetTabs = page.getByRole('tablist', { name: locale.widgetList });
    await expect(widgetTabs.getByRole('tab').nth(1)).toHaveText(locale.runningUnavailable);
    await widgetTabs.getByRole('tab').nth(1).click();
    const instanceRecovery = page.locator('.widget-sidebar').getByRole('alert');
    await expect(instanceRecovery).toContainText(locale.widgetInstancesLoadFailed);
    await expect(page.getByText(locale.widgetNoRunning)).toHaveCount(0);
    await expect(page.getByText(canary)).toHaveCount(0);
    await setLevel3StreamFault(page, 'automation/watchWidgets', false, canary);
    const instancesRetry = instanceRecovery.getByRole('button', { name: locale.retry });
    await instancesRetry.focus();
    await expect(instancesRetry).toBeFocused();
    await expect(instancesRetry).toBeInViewport();
    await instancesRetry.press('Enter');
    await expect(instanceRecovery).toHaveCount(0);
    await expect(page.getByText(locale.widgetNoRunning)).toBeVisible();

    await setLevel3StreamFault(page, 'ai/watchAi', true, canary);
    await page.getByRole('button', { name: locale.aiInspector, exact: true }).click();
    await page.locator('[data-ai-open-workspace]').click();
    const aiWorkspace = page.getByRole('region', { name: locale.aiChatWorkspace });
    await expect(aiWorkspace).toBeVisible();
    // An unavailable complete AI baseline cannot trigger the old provider-only auto-setup read. Open its existing form explicitly.
    await page.getByRole('button', { name: locale.provider, exact: true }).click();
    const config = page.getByRole('dialog', { name: locale.aiConfig });
    await expect(config).toBeVisible();
    await config.getByRole('button', { name: locale.cancel }).click();
    const historyToggle = aiWorkspace.locator('.ai-chat-header button[aria-pressed]');
    if ((await historyToggle.getAttribute('aria-pressed')) === 'true') await historyToggle.click();
    await historyToggle.click();
    const aiRecovery = page.locator('.ai-history-recovery');
    await expect(aiRecovery).toContainText(locale.aiHistoryLoadFailed);
    await expect(aiWorkspace.getByText(locale.aiNoHistory)).toHaveCount(0);
    await expect(page.getByText(canary)).toHaveCount(0);
    await assertHorizontalBounds(page, '.ai-history-recovery');
    await setLevel3StreamFault(page, 'ai/watchAi', false, canary);
    const aiRetry = aiRecovery.getByRole('button', { name: locale.retry });
    await aiRetry.focus();
    await expect(aiRetry).toBeFocused();
    await expect(aiRetry).toBeInViewport();
    await aiRetry.press('Enter');
    await expect(aiRecovery).toHaveCount(0);
    await expect(config).toHaveCount(0);
    await expect(aiWorkspace.getByText(locale.aiNoHistory)).toBeVisible();
    await expect(aiWorkspace.getByText(locale.aiEmptyConversation)).toBeVisible();
    expect(await level3StreamOpens(page, 'ai/watchAi')).toBeGreaterThan(1);
  }
}
