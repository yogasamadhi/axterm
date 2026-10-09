import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';
import { verifyFourLocaleEditorConditionalJourney } from './editor-conditional-journey';
import { verifyFourLocaleS3ConditionalJourney } from './s3-conditional-journey';
import { verifyFourLocaleS4ConditionalJourney } from './s4-conditional-journey';
import { verifyFourLocaleS5ShellJourney } from './s5-shell-journey';

import { launchLocalOptimizationApp } from '../fixtures/local-optimization-launch';

const require = createRequire(resolve('apps/desktop/package.json'));
const executablePath = require('electron') as string;
const axeScriptPath = require.resolve('axe-core/axe.min.js');
const viewports = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

async function expectFocusedControl(control: Locator): Promise<void> {
  if (process.env.AXTERM_E2E_HIDDEN_WINDOW === '1') {
    // An intentionally hidden native window has no reliable OS-level focus.
    await control.evaluate((element: HTMLElement) => element.focus());
    await expect
      .poll(() => control.evaluate((element) => element.ownerDocument.activeElement === element))
      .toBe(true);
    return;
  }
  await expect(control).toBeFocused();
}

async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolveFrame) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())),
    );
  });
}

async function assertVisibleChromeWithinViewport(page: Page): Promise<void> {
  const failures = await page.evaluate(() => {
    const selectors = [
      '.activity-bar',
      '.app-sidebar',
      '.app-topbar',
      '[data-activity-item="setting"]',
      '[data-settings-category="terminal"]',
    ];
    return selectors.flatMap((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return [];
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return [];
      return bounds.left < -1 ||
        bounds.top < -1 ||
        bounds.right > innerWidth + 1 ||
        bounds.bottom > innerHeight + 1
        ? [`${selector}: ${JSON.stringify(bounds.toJSON())}`]
        : [];
    });
  });
  expect(failures).toEqual([]);
}

async function assertNoVisibleAccessibilityFailures(page: Page, scene: string): Promise<void> {
  const failures = await page.evaluate(async () => {
    const axe = (
      globalThis as typeof globalThis & {
        axe?: {
          run: (
            context: Document,
            options: { runOnly: { type: 'tag'; values: string[] } },
          ) => Promise<{
            violations: Array<{ id: string; nodes: Array<{ target: string[] }> }>;
          }>;
        };
      }
    ).axe;
    if (!axe) throw new Error('axe-core was not injected');
    const result = await axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
    });
    return result.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target }) => target),
    }));
  });
  expect(failures, `${scene} accessibility`).toEqual([]);
}

test('default workspace, terminal and auxiliary panels use neutral gray backgrounds', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-gray-background-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.context().addInitScript({ path: axeScriptPath });
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(viewports[0]);
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await expect(page.locator('.terminal-host')).toHaveAttribute(
      'data-theme-background',
      '#1e1e1e',
    );
    const expectBackground = async (selector: string, color: string) => {
      const element = page.locator(selector).first();
      await expect(element).toBeVisible();
      await expect
        .poll(() => element.evaluate((node) => getComputedStyle(node).backgroundColor))
        .toBe(color);
    };
    await expectBackground('body', 'rgb(37, 37, 37)');
    await expectBackground('.activity-bar', 'rgb(25, 25, 25)');
    await expectBackground('.workspace-left-rail', 'rgb(25, 25, 25)');
    await expectBackground('.pane-tabbar', 'rgb(25, 25, 25)');
    await expectBackground('.terminal-pane-body', 'rgb(30, 30, 30)');
    await expectBackground('.terminal-session-layer', 'rgb(30, 30, 30)');
    await expectBackground('.terminal-session-layer .terminal-surface', 'rgb(30, 30, 30)');
    await expectBackground('.xterm-scrollable-element', 'rgb(30, 30, 30)');
    if (!(await page.locator('.workspace-sidebar').isVisible()))
      await page.locator('[data-activity-item="bookmarks"]').click();
    await expectBackground('.workspace-sidebar', 'rgb(37, 37, 37)');
    const aiTrigger = page.getByRole('button', { name: 'AI 助手', exact: true });
    await expect(aiTrigger).toHaveAttribute('aria-label', 'AI 助手');
    await aiTrigger.hover();
    await expect(page.getByRole('tooltip')).toHaveText('AI 助手');
    await assertNoVisibleAccessibilityFailures(page, 'activity icon tooltip');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await aiTrigger.click();
    const assistant = page.getByRole('complementary', { name: 'AI 助手', exact: true });
    await expect(assistant.locator('header > span')).toHaveText('AI 助手');
    await expect(
      assistant.getByRole('button', { name: '关闭 AI 助手', exact: true }),
    ).toBeVisible();
    await expectBackground('.ai-inspector', 'rgb(37, 37, 37)');
    await settleLayout(page);
    await assertNoVisibleAccessibilityFailures(page, 'gray terminal and AI assistant');
    await page.screenshot({ path: test.info().outputPath('neutral-gray-workspace.png') });
    await aiTrigger.click();
    await page.locator('.status-information').click();
    await expectBackground('.terminal-information-panel', 'rgb(37, 37, 37)');
    await page.getByRole('button', { name: '关闭终端信息' }).click();
    await page.locator('[data-activity-item="setting"]').click();
    await expectBackground('.workspace-main', 'rgb(37, 37, 37)');
    await expectBackground('.language-settings-panel', 'rgb(30, 30, 30)');
    await settleLayout(page);
    await assertNoVisibleAccessibilityFailures(page, 'gray settings');
    await page.screenshot({ path: test.info().outputPath('neutral-gray-settings.png') });
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('macOS titlebar keeps native buttons clear in workspaces, collapsed sidebars and zoomed windows', async () => {
  test.skip(process.platform !== 'darwin', 'Native macOS window buttons are under test.');
  test.setTimeout(120_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-mac-titlebar-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const nativePosition = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getWindowButtonPosition(),
    );
    expect(nativePosition).toEqual({ x: 9, y: 10 });
    const shell = page.locator('.app-shell');
    await settleLayout(page);
    // Chromium can report the previous outerWidth while a native resize settles.
    // Restore it after several frames without sending another resize event.
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(window, 'outerWidth');
      if (!descriptor?.configurable) throw new Error('Window metrics cannot be simulated');
      Object.defineProperty(window, 'outerWidth', {
        configurable: true,
        value: window.outerWidth * 2,
      });
      window.dispatchEvent(new Event('resize'));
      let remainingFrames = 8;
      const restore = () => {
        if (--remainingFrames > 0) requestAnimationFrame(restore);
        else Object.defineProperty(window, 'outerWidth', descriptor);
      };
      requestAnimationFrame(restore);
    });
    await expect
      .poll(
        () =>
          shell.evaluate((element) =>
            element.style.getPropertyValue('--shell-native-controls-width'),
          ),
        { timeout: 3_000, message: 'Native chrome reconciles delayed window metrics' },
      )
      .toBe('80px');
    const assertNativeButtonsClear = async (zoom: number, scene: string) => {
      await settleLayout(page);
      const overlaps = await page.evaluate((scale) => {
        const selectors = [
          '.explorer-header > div',
          '.explorer-header > button',
          '.ai-inspector > header > span',
          '.ai-inspector > header > button',
          '.section-tab',
          '.terminal-tab',
          '.tab-add',
          '.tab-add-menu',
          '.settings-workspace-tabs',
          '.settings-workspace-close',
        ];
        return selectors.flatMap((selector) =>
          Array.from(document.querySelectorAll<HTMLElement>(selector)).flatMap((element) => {
            const box = element.getBoundingClientRect();
            if (!box.width || !box.height || getComputedStyle(element).visibility === 'hidden')
              return [];
            const overlapsButtons =
              box.left * scale < 79 &&
              box.top * scale < 37 &&
              box.right * scale > 0 &&
              box.bottom * scale > 0;
            return overlapsButtons ? [{ selector, box: box.toJSON() }] : [];
          }),
        );
      }, zoom);
      expect(overlaps, `${scene} native button exclusion area`).toEqual([]);
    };

    for (const viewport of [
      { width: 800, height: 580 },
      { width: 1280, height: 800 },
      { width: 1440, height: 900 },
    ]) {
      for (const zoom of [0.5, 1, 2]) {
        await app.evaluate(
          ({ BrowserWindow }, { width, height, scale }) => {
            const window = BrowserWindow.getAllWindows()[0]!;
            window.setSize(width, height);
            window.webContents.setZoomFactor(scale);
          },
          { ...viewport, scale: zoom },
        );
        await expect
          .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
          .toEqual([viewport.width / zoom, viewport.height / zoom]);
        const scene = `${viewport.width}/${zoom}`;

        if (await shell.evaluate((element) => element.classList.contains('sidebar-collapsed')))
          await page.locator('[data-activity-item="bookmarks"]').click();
        if (await page.locator('.bookmark-manager-back').isVisible())
          await page.locator('.bookmark-manager-back').click();
        await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
        await expect(page.locator('.section-tab')).toHaveCount(0);
        await expect(page.locator('.terminal-workspace')).toBeVisible();
        await assertNativeButtonsClear(zoom, `${scene} workspace`);
        if (zoom === 1 && viewport.width <= 1280)
          await page.screenshot({ path: test.info().outputPath(`hosts-${viewport.width}.png`) });

        if (!(await shell.evaluate((element) => element.classList.contains('sidebar-collapsed'))))
          await page.locator('.explorer-header button').click();
        await expect(shell).toHaveClass(/sidebar-collapsed/);
        await assertNativeButtonsClear(zoom, `${scene} collapsed workspace`);
        await page.locator('.terminal-tab').first().click();
        await expect(page.locator('.terminal-workspace')).toBeVisible();
        await assertNativeButtonsClear(zoom, `${scene} collapsed terminal`);

        await page.locator('[data-activity-item="bookmarks"]').click();
        await expect(page.locator('.workspace-sidebar')).toBeVisible();
        await assertNativeButtonsClear(zoom, `${scene} expanded terminal`);
        const firstPane = page.locator('.terminal-pane').first();
        await expect
          .poll(
            async () => {
              const paneBounds = await firstPane.boundingBox();
              const firstTabBounds = await firstPane.locator('.terminal-tab').first().boundingBox();
              expect(paneBounds!.x).toBe(24);
              return Math.abs(firstTabBounds!.x - 80 / zoom);
            },
            { message: `${scene} native controls spacer` },
          )
          .toBeLessThan(1);

        await page.locator('[data-activity-item="ai"]').click();
        await expect(page.locator('.ai-inspector')).toBeVisible();
        await assertNativeButtonsClear(zoom, `${scene} AI sidebar`);
        await page.locator('[data-activity-item="bookmarks"]').click();
        await expect(page.locator('.explorer-header')).toBeVisible();

        await page.locator('[data-activity-item="setting"]').click();
        await expect(page.locator('.settings-workspace')).toBeVisible();
        await assertNativeButtonsClear(zoom, `${scene} settings`);
        await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
      }
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('activity rail and panels open on the right across expanded, collapsed and narrow workspaces', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-right-sidebar-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    const rail = page.locator('.activity-bar');
    const leftRail = page.locator('.workspace-left-rail');
    const sidebar = page.locator('.workspace-sidebar');
    const main = page.locator('.workspace-main');
    const bookmarks = page.locator('[data-activity-item="bookmarks"]');
    const aiTrigger = rail.locator('nav [data-activity-item="ai"]');
    const startupTerminalId = await page
      .locator('.terminal-tab.active')
      .getAttribute('data-terminal-id');
    await expect(rail.locator('nav > button').first()).toHaveAttribute('data-activity-item', 'ai');
    await expect(rail.getByRole('button', { name: '新建会话', exact: true })).toHaveCount(0);
    await expect(rail.locator('[data-activity-item="newBookmark"]')).toBeVisible();
    const assertRightEdge = async (panel: Locator, gap = 0) => {
      await expect(panel).toBeVisible();
      await settleLayout(page);
      const panelBox = (await panel.boundingBox())!;
      const railBox = (await rail.boundingBox())!;
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(Math.abs(railBox.x + railBox.width - viewport.width)).toBeLessThan(1);
      expect(Math.abs(panelBox.x + panelBox.width + gap - railBox.x)).toBeLessThan(1);
      expect(panelBox.x).toBeGreaterThanOrEqual(0);
      expect(panelBox.y).toBeGreaterThanOrEqual(0);
      expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(viewport.height + 1);
    };
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1000, height: 700 },
      { width: 700, height: 580 },
    ]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(viewport.width);
      if (!(await sidebar.isVisible())) await bookmarks.click();
      await assertRightEdge(sidebar);
      for (const button of await rail.locator('[data-activity-item]').all()) {
        const name = await button.getAttribute('aria-label');
        expect(name).toBeTruthy();
        await button.hover();
        const tooltip = page.getByRole('tooltip');
        await expect(tooltip).toHaveText(name!);
        expect(await tooltip.evaluate((node) => !!node.closest('.activity-bar'))).toBe(true);
        if (viewport.width === 1440 && (await button.getAttribute('data-activity-item')) === 'ai')
          await page.screenshot({ path: test.info().outputPath('activity-tooltip.png') });
        const tooltipBox = (await tooltip.boundingBox())!;
        const buttonBox = (await button.boundingBox())!;
        expect(tooltipBox.x).toBeGreaterThanOrEqual(0);
        expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(buttonBox.x - 1);
        expect(tooltipBox.y).toBeGreaterThanOrEqual(0);
        expect(tooltipBox.y + tooltipBox.height).toBeLessThanOrEqual(viewport.height);
        await tooltip.hover();
        await expect(tooltip).toBeVisible();
        await page.mouse.move(100, 100);
        await expect(page.getByRole('tooltip')).toHaveCount(0);
        await button.hover();
        await expect(tooltip).toHaveText(name!);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('tooltip')).toHaveCount(0);
        await expect(page.locator('.terminal-tab.active')).toHaveAttribute(
          'data-terminal-id',
          startupTerminalId!,
        );
        await expect(page.locator('.section-tab')).toHaveCount(0);
      }
      await page.mouse.move(100, 100);
      await aiTrigger.focus();
      await expect(page.getByRole('tooltip')).toHaveText('AI 助手');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('tooltip')).toHaveCount(0);
      await aiTrigger.evaluate((button: HTMLElement) => button.blur());
      await expect(sidebar.locator('.explorer-header > div')).toHaveText('主机');
      const sidebarBox = (await sidebar.boundingBox())!;
      const mainBox = (await main.boundingBox())!;
      const leftRailBox = (await leftRail.boundingBox())!;
      expect(leftRailBox).toEqual({ x: 0, y: 0, width: 24, height: viewport.height });
      await expect(leftRail).toHaveAttribute('aria-hidden', 'true');
      await expect(leftRail.locator('*')).toHaveCount(0);
      expect(mainBox.x).toBe(leftRailBox.x + leftRailBox.width);
      expect(sidebarBox.width).toBe(viewport.width > 1100 ? 520 : 440);
      const railBox = (await rail.boundingBox())!;
      expect(railBox.width).toBe(40);
      const clippedButtons = await rail.locator('button').evaluateAll((buttons) =>
        buttons.flatMap((button) => {
          const box = button.getBoundingClientRect();
          const rail = button.closest('.activity-bar')!.getBoundingClientRect();
          return box.left < rail.left || box.right > rail.right || box.width < 24 || box.height < 24
            ? [button.getAttribute('aria-label')]
            : [];
        }),
      );
      expect(clippedButtons).toEqual([]);
      if (viewport.width > 760)
        expect(Math.abs(mainBox.x + mainBox.width - sidebarBox.x)).toBeLessThan(1);
      const footerBox = (await page.locator('.app-statusbar').boundingBox())!;
      expect(footerBox.x).toBe(mainBox.x);
      expect(footerBox.width).toBeGreaterThan(0);

      const sessionMenuTrigger = page.locator('.tab-add-menu:visible').first();
      await sessionMenuTrigger.click();
      await assertRightEdge(page.locator('.session-menu'), 4);
      await page.keyboard.press('Escape');
      await expect(page.locator('.session-menu')).toHaveCount(0);
      await expectFocusedControl(sessionMenuTrigger);
      await sidebar.locator('.explorer-header button').click();
      await expect(sidebar).toBeHidden();
      await settleLayout(page);
      const collapsedMain = (await main.boundingBox())!;
      expect(Math.abs(collapsedMain.x + collapsedMain.width - railBox.x)).toBeLessThan(1);
      if (viewport.width <= 760) {
        await page.getByTitle('布局与工作区', { exact: true }).click();
        await assertRightEdge(page.locator('.layout-menu'), 4);
        await page.keyboard.press('Escape');
        await expect(page.locator('.layout-menu')).toHaveCount(0);
      }
      await aiTrigger.click();
      await expect(sidebar).toHaveCount(1);
      await expect(sidebar).toHaveClass(/section-ai/);
      await assertRightEdge(page.locator('.ai-inspector'));
      expect((await page.locator('.ai-inspector').boundingBox())!.width).toBe(sidebarBox.width);
      await aiTrigger.click();
      await expect(page.locator('.ai-inspector')).toHaveCount(0);

      await page.locator('.status-information').click();
      await assertRightEdge(page.locator('.terminal-information-panel'));
      expect((await page.locator('.terminal-information-panel').boundingBox())!.width).toBe(
        viewport.width > 1100 ? 360 : 340,
      );
      await page.getByRole('button', { name: '关闭终端信息' }).click();
      await expect(page.locator('.terminal-information-panel')).toHaveCount(0);

      await bookmarks.click();
      await assertRightEdge(sidebar);
      const activeTab = page.locator('.terminal-pane.active .terminal-tab[aria-selected="true"]');
      const terminalId = await activeTab.getAttribute('data-terminal-id');
      const beforeAiMainBox = (await main.boundingBox())!;
      await aiTrigger.click();
      await expect(sidebar).toHaveCount(1);
      await expect(page.locator('.ai-inspector')).toBeVisible();
      await assertRightEdge(sidebar);
      expect(await sidebar.boundingBox()).toEqual(sidebarBox);
      expect(await main.boundingBox()).toEqual(beforeAiMainBox);
      await expect(activeTab).toHaveAttribute('data-terminal-id', terminalId!);
      await bookmarks.press('Enter');
      await expect(page.locator('.ai-inspector')).toHaveCount(0);
      await expect(sidebar.locator('.explorer-header > div')).toHaveText('主机');
      expect(await sidebar.boundingBox()).toEqual(sidebarBox);
      await aiTrigger.press('Enter');
      await expect(sidebar).toHaveClass(/section-ai/);
      for (const control of [
        sidebar.locator('textarea[name="prompt"]'),
        sidebar.getByRole('button', { name: '发送消息', exact: true }),
      ]) {
        await control.scrollIntoViewIfNeeded();
        await expect(control).toBeInViewport({ ratio: 1 });
      }
      await page.screenshot({ path: test.info().outputPath(`right-panels-${viewport.width}.png`) });
      if (viewport.width <= 760) {
        await rail.locator('[data-activity-item="newBookmark"]').click();
        await expect(page.locator('.host-bookmark-modal')).toBeVisible();
        await page.locator('.host-bookmark-modal [data-bookmark-protocol="ftp"]').click();
        await expect(page.getByRole('dialog', { name: '添加 FTP/FTPS 书签' })).toBeVisible();
        await page.screenshot({ path: test.info().outputPath('right-dialog-700.png') });
        await page.keyboard.press('Escape');
        await expect(page.locator('.modal-backdrop')).toHaveCount(0);
      }
      await aiTrigger.click();
      await page.locator('[data-activity-item="setting"]').click();
      await expect(page.locator('.settings-workspace')).toBeVisible();
      await expect(leftRail).toHaveCount(0);
      expect((await main.boundingBox())!.x).toBe(0);
      await expect(sidebar).toBeHidden();
      await assertRightEdge(main);
      await aiTrigger.click();
      await expect(sidebar).toBeVisible();
      await expect(sidebar).toHaveClass(/section-ai/);
      await expect(page.locator('.settings-workspace')).toBeVisible();
      await assertRightEdge(sidebar);
      await aiTrigger.click();
      await expect(sidebar).toBeHidden();
      await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
      await page.locator('.terminal-tab').first().click();
      await expect(page.locator('.terminal-workspace')).toBeVisible();
      await expect(leftRail).toBeVisible();
      await expect(page.locator('.terminal-host')).toHaveAttribute(
        'data-connection-state',
        'connected',
      );
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('AI model selection displays complete names and preserves native selection in wide and narrow sidebars', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-model-name-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.context().addInitScript({ path: axeScriptPath });
    const page = await app.firstWindow();
    const entity = {
      createdAt: '2026-10-07T00:00:00Z',
      updatedAt: '2026-10-07T00:00:00Z',
      version: 1,
    };
    const providerId = '11111111-1111-4111-8111-111111111111';
    const names = [
      'deepseek-flash',
      'fixture/provider/extended-context-reasoning-model-with-a-complete-name-0123456789-abcdefghijklmnopqrstuvwxyz',
    ];
    const models = names.map((name, index) => ({
      ...entity,
      id: `22222222-2222-4222-8222-22222222222${index}`,
      providerId,
      name,
      model: name,
      capabilities: ['chat', 'tools'],
    }));
    await page.route('**/api/v1/ai/providers', (route) =>
      route.fulfill({
        json: [
          {
            ...entity,
            id: providerId,
            name: 'Model name fixture',
            baseUrl: 'http://127.0.0.1:9/v1',
            apiPath: '/chat/completions',
            protocol: 'openai-chat',
            auth: 'bearer',
            role: 'Fixture',
            proxy: null,
            timeoutMs: 60_000,
            credentialRef: 'fixture-ref',
            enabled: true,
          },
        ],
      }),
    );
    await page.route('**/api/v1/ai/models', (route) => route.fulfill({ json: models }));
    await page.reload();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="ai"]').click();
    const sidebar = page.locator('.ai-inspector');
    const model = sidebar.locator('select[name="modelId"]');
    const value = sidebar.locator('.ai-model-select-value');
    const mode = sidebar.locator('select[name="mode"]');
    await expect(model).toHaveAccessibleName('模型');
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 1000, height: 700 },
      { width: 700, height: 580 },
    ]) {
      await page.setViewportSize(viewport);
      for (const item of models) {
        await model.selectOption(item.id);
        await expect(model).toHaveValue(item.id);
        await expect(value).toHaveText(item.name);
        await value.scrollIntoViewIfNeeded();
        await expect(value).toBeInViewport({ ratio: 1 });
        await expect
          .poll(() =>
            value.evaluate(
              (element) =>
                element.scrollWidth <= element.clientWidth &&
                element.scrollHeight <= element.clientHeight,
            ),
          )
          .toBe(true);
        const modelBox = (await model.boundingBox())!;
        const modeBox = (await mode.boundingBox())!;
        expect(modeBox.y).toBeGreaterThanOrEqual(modelBox.y + modelBox.height);
        expect(
          await model.evaluate((element: HTMLSelectElement) =>
            new FormData(element.form!).get('modelId'),
          ),
        ).toBe(item.id);
        await mode.selectOption('work');
        await expect(model).toHaveValue(item.id);
        await mode.selectOption('chat');
        if (viewport.width === 1440 && item.name === names[0])
          await page.screenshot({
            path: test.info().outputPath('deepseek-flash-full-name.png'),
          });
      }
      await assertNoVisibleAccessibilityFailures(
        page,
        `complete AI model name at ${viewport.width}`,
      );
      await page.screenshot({
        path: test.info().outputPath(`complete-model-${viewport.width}.png`),
      });
    }
    // Native select menus on macOS require a focused native window, even when
    // the other layout scenes intentionally run with their window hidden.
    await app.evaluate(({ app: desktop, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.show();
      desktop.focus({ steal: true });
      window.focus();
      window.webContents.focus();
    });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFocused()),
      )
      .toBe(true);
    await model.focus();
    await expectFocusedControl(model);
    await model.press('d');
    await expect(model).toHaveValue(models[0]!.id);
    await expect(value).toHaveText(names[0]!);
    await mode.focus();
    await model.focus();
    await model.press('f');
    await expect(model).toHaveValue(models[1]!.id);
    await expect(value).toHaveText(names[1]!);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('OP05 common settings group preferences and bound advanced diagnostics in four languages and three viewports', async () => {
  test.setTimeout(180_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-op05-settings-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.context().addInitScript({ path: axeScriptPath });
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    for (const language of ['en', 'zh-CN', 'zh-TW', 'ja']) {
      await page.getByTestId('application-language').selectOption(language);
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        for (const zoom of [1, 2]) {
          await app.evaluate(
            ({ BrowserWindow }, value) =>
              BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(value),
            zoom,
          );
          await expect
            .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
            .toEqual([viewport.width / zoom, viewport.height / zoom]);
          const common = page.locator('.settings-item-common .panel-page');
          await expect(page.locator('.settings-advanced-diagnostics')).not.toHaveAttribute('open');
          await expect(common.locator('.diagnostic-grid')).toHaveCount(0);
          await expect(common.locator('> .language-settings-panel')).toHaveCount(1);
          await expect(common.locator('.settings-preference-group')).toHaveCount(2);
          for (const control of [
            page.getByTestId('application-language'),
            common.locator('.settings-privacy-panel input[type="checkbox"]'),
            common.locator('[aria-labelledby="window-preferences-title"] button[type="submit"]'),
            common.locator('.tab-preferences-panel input[type="checkbox"]').first(),
            common.locator('[aria-labelledby="proxy-settings-title"] button[value="save"]'),
            common.locator('.settings-advanced-diagnostics > summary'),
          ]) {
            await control.scrollIntoViewIfNeeded();
            await expectFocusedControl(control);
            await expect(control).toBeInViewport();
            expect(
              await control.evaluate((element) => {
                const target =
                  element instanceof HTMLInputElement && element.type === 'checkbox'
                    ? (element.closest('label') ?? element)
                    : element;
                const box = target.getBoundingClientRect();
                return (
                  box.left >= -1 &&
                  box.right <= innerWidth + 1 &&
                  box.width >= 24 &&
                  box.height >= 24
                );
              }),
              `${language}/${viewport.width}/${zoom} required control bounds`,
            ).toBe(true);
          }
          const summary = common.locator('.settings-advanced-diagnostics > summary');
          await summary.press('Enter');
          await expect(common.locator('.settings-advanced-diagnostics')).toHaveAttribute(
            'open',
            '',
          );
          await expect(common.locator('.diagnostic-grid')).toBeVisible();
          const exportButton = common.locator('.settings-diagnostics-content > button');
          await exportButton.scrollIntoViewIfNeeded();
          await expectFocusedControl(exportButton);
          await expect(exportButton).toBeInViewport();
          if (viewport.width === 1280 && zoom === 2) {
            await assertNoVisibleAccessibilityFailures(
              page,
              `OP05 ${language} expanded diagnostics`,
            );
            await page.screenshot({
              path: test.info().outputPath(`diagnostics-${language}-zoom2.png`),
            });
          }
          for (const category of ['common', 'terminal', 'shortcuts'] as const) {
            await page.locator(`[data-settings-category="${category}"]`).click();
            const content = page.locator(`.settings-item-${category} .panel-page`);
            const widths = await content.evaluate((element) => ({
              scroll: element.scrollWidth,
              client: element.clientWidth,
              document: document.documentElement.scrollWidth,
              viewport: innerWidth,
            }));
            expect(
              widths.scroll,
              `${language}/${category}/${viewport.width}/${zoom} content width`,
            ).toBeLessThanOrEqual(widths.client + 1);
            expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
          }
          await page.locator('[data-settings-category="common"]').click();
          await page.getByTestId('application-language').scrollIntoViewIfNeeded();
          await page.screenshot({
            path: test.info().outputPath(`settings-${language}-${viewport.width}-zoom${zoom}.png`),
          });
          if (viewport.width === 1280 && zoom === 2) {
            await assertNoVisibleAccessibilityFailures(page, `OP05 ${language} common`);
            const categories = page.locator('.settings-category-sidebar');
            await expectFocusedControl(categories.locator('[data-settings-category="common"]'));
            await categories.locator('[data-settings-category="common"]').press('ArrowDown');
            await expect(categories.locator('[data-settings-category="terminal"]')).toHaveAttribute(
              'aria-current',
              'page',
            );
            await categories.locator('[data-settings-category="terminal"]').press('Home');
            await expect(categories.locator('[data-settings-category="common"]')).toHaveAttribute(
              'aria-current',
              'page',
            );
          }
        }
      }
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('language changes wait for a pending layout save and preserve the selected terminal', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-language-layout-save-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  let releaseLayout!: () => void;
  const layoutResponse = new Promise<void>((resolveResponse) => {
    releaseLayout = resolveResponse;
  });
  try {
    const page = await app.firstWindow();
    let holdLayout = false;
    let committing = false;
    let blocked = false;
    let released = false;
    let settingsSnapshot: APIResponse | undefined;
    await page.route('**/api/v1/settings', async (route) => {
      if (route.request().method() === 'GET') {
        if (!committing || released) settingsSnapshot = await route.fetch();
        if (settingsSnapshot) await route.fulfill({ response: settingsSnapshot });
        else await route.continue();
      } else if (
        holdLayout &&
        !blocked &&
        route.request().method() === 'PATCH' &&
        route.request().postDataJSON()?.workspace?.layout
      ) {
        // Commit the layout revision while its response is delayed. The language
        // writer must wait for that revision instead of sending the old If-Match.
        committing = true;
        const response = await route.fetch();
        blocked = true;
        await layoutResponse;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await expect(page.locator('.terminal-tab')).toHaveCount(1);
    const terminalId = await page.locator('.terminal-tab').getAttribute('data-terminal-id');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    await expect(page.getByTestId('application-language')).toBeEnabled();
    await expect.poll(() => !!settingsSnapshot).toBe(true);
    holdLayout = true;
    await page.locator('[data-activity-item="ai"]').click();
    await expect.poll(() => blocked).toBe(true);
    await page.getByTestId('application-language').selectOption('zh-TW');
    released = true;
    releaseLayout();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
    await expect(page.getByTestId('application-language')).toBeEnabled();
    await expect(page.locator('.language-settings-panel [role="status"]')).toHaveText(
      '語言已更新。',
    );
    await page.getByRole('button', { name: '關閉設定並返回工作區' }).click();
    await expect(page.locator('.terminal-tab.active')).toHaveAttribute(
      'data-terminal-id',
      terminalId!,
    );
  } finally {
    releaseLayout();
    await app.close().catch(() => undefined);
    await rm(userData, { recursive: true, force: true });
  }
});

test('OP05 diagnostics and privacy failures are localized, recoverable and do not expose raw details', async () => {
  test.setTimeout(120_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-op05-settings-recovery-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    let failRead = false;
    let failPrivacy = false;
    let failExport = true;
    let creates = 0;
    let exports = 0;
    let revokes = 0;
    const problem = {
      type: 'about:blank',
      title: 'Fixture failure',
      status: 500,
      detail: 'OP05_SECRET_CANARY_DO_NOT_DISPLAY',
    };
    await page.route('**/api/v1/diagnostics/runtime', async (route) => {
      if (failRead)
        await route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: JSON.stringify(problem),
        });
      else await route.continue();
    });
    await page.route('**/api/v1/settings', async (route) => {
      if (failPrivacy && route.request().method() === 'PATCH')
        await route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: JSON.stringify(problem),
        });
      else await route.continue();
    });
    // Controlled export UI failure fixture; actual Runtime diagnostics below still uses its real route.
    await page.route('**/api/v1/file-grants', async (route) => {
      if (route.request().postDataJSON()?.kind !== 'save-file') {
        await route.continue();
        return;
      }
      creates++;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          grantId: 'op05-controlled-export',
          kind: 'save-target',
          name: 'fixture.json',
          permissions: ['write'],
          createdAt: new Date().toISOString(),
        }),
      });
    });
    await page.route('**/api/v1/file-grants/op05-controlled-export', async (route) => {
      revokes++;
      await route.fulfill({ status: 204 });
    });
    await page.route('**/api/v1/diagnostics/export', async (route) => {
      exports++;
      await route.fulfill({
        status: failExport ? 500 : 200,
        contentType: failExport ? 'application/problem+json' : 'application/json',
        body: JSON.stringify(
          failExport ? problem : { bytes: 1234, createdAt: new Date().toISOString() },
        ),
      });
    });
    const cases = [
      {
        id: 'en',
        read: 'Unable to load diagnostics. Try again.',
        save: 'Unable to save privacy settings. Saved preferences were not changed.',
        exported: 'Unable to export diagnostics. Choose a location and try again.',
      },
      {
        id: 'zh-CN',
        read: '无法读取诊断信息。请重试。',
        save: '无法保存隐私设置。已保存的偏好未更改。',
        exported: '无法导出诊断报告。请选择保存位置后重试。',
      },
      {
        id: 'zh-TW',
        read: '無法載入診斷資訊。請重試。',
        save: '無法儲存隱私設定。已儲存的偏好設定並未變更。',
        exported: '無法匯出診斷報告。請選擇儲存位置後重試。',
      },
      {
        id: 'ja',
        read: '診断情報を読み込めません。もう一度お試しください。',
        save: 'プライバシー設定を保存できません。保存済みの設定は変更されていません。',
        exported: '診断レポートをエクスポートできません。保存先を選択して再試行してください。',
      },
    ];
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    for (const locale of cases) {
      await page.getByTestId('application-language').selectOption(locale.id);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
      const privacy = page.locator('.settings-privacy-panel');
      const checkbox = privacy.getByRole('checkbox');
      const before = await checkbox.isChecked();
      failPrivacy = true;
      await checkbox.click();
      await expect(privacy.getByRole('alert')).toHaveText(locale.save);
      await expect(checkbox).toHaveJSProperty('checked', before);
      failPrivacy = false;
      await checkbox.click();
      await expect(checkbox).toHaveJSProperty('checked', !before);
      await expect(privacy.getByRole('alert')).toHaveCount(0);
      failRead = true;
      const diagnostics = page.locator('.settings-advanced-diagnostics');
      await diagnostics.locator('summary').click();
      await expect(diagnostics.getByRole('alert')).toContainText(locale.read);
      failRead = false;
      await diagnostics.getByRole('alert').getByRole('button').click();
      await expect(diagnostics.getByRole('alert')).toHaveCount(0);
      await expect(diagnostics.locator('.diagnostic-grid')).toBeVisible();
      failExport = true;
      const exportButton = diagnostics.locator('.settings-diagnostics-content > button');
      const exportCount = exports;
      await exportButton.evaluate((element: HTMLButtonElement) => {
        element.click();
        element.click();
      });
      await expect(diagnostics.getByRole('alert')).toHaveText(locale.exported);
      await expect.poll(() => revokes).toBe(exportCount + 1);
      expect(exports).toBe(exportCount + 1);
      expect(creates).toBe(exportCount + 1);
      failExport = false;
      await exportButton.click();
      await expect(diagnostics.getByRole('alert')).toHaveCount(0);
      await expect(diagnostics.getByRole('status')).toHaveCount(1);
      await expect.poll(() => revokes).toBe(exportCount + 2);
      await expect(page.getByText(problem.detail)).toHaveCount(0);
      await page.locator('[data-settings-category="terminal"]').click();
      await page.locator('[data-settings-category="common"]').click();
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('Axterm shell and Settings retain their own three-viewport visual baseline', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-visual-baseline-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addStyleTag({
      content:
        '.terminal-host .xterm-screen, .terminal-host .xterm-cursor-layer { visibility: hidden !important; }',
    });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await expect(page.getByRole('heading', { name: '主机与连接' })).toBeVisible();

    for (const { width, height } of viewports) {
      await page.setViewportSize({ width, height });
      await expect
        .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
        .toEqual([width, height]);
      await expect(page.getByRole('heading', { name: '主机与连接' })).toBeVisible();
      await settleLayout(page);
      await assertVisibleChromeWithinViewport(page);
      await expect(page.locator('.activity-bar')).toBeVisible();
      if (process.platform === 'darwin')
        await expect(page).toHaveScreenshot(`axterm-shell-${width}x${height}.png`, {
          animations: 'disabled',
          caret: 'hide',
          maxDiffPixelRatio: 0.01,
        });

      if (width === 1280) {
        const addHost = page.getByRole('button', { name: '添加主机' });
        await addHost.click();
        const dialog = page.getByRole('dialog', { name: '添加 SSH 主机' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel('名称')).toBeFocused();
        await expect(
          dialog.locator('.host-bookmark-shell-tabs, .host-bookmark-shell-sidebar'),
        ).toHaveCount(0);
        await expect(page.getByText('New Bookmarks', { exact: true })).toHaveCount(0);
        await expect(page.getByText('PrivateKey/Certificate', { exact: true })).toHaveCount(0);
        await settleLayout(page);
        const dialogBounds = await dialog.evaluate((element) => {
          const { bottom, height, left, right, top, width } = element.getBoundingClientRect();
          return {
            bottom,
            height,
            left,
            right,
            top,
            width,
            viewportHeight: globalThis.innerHeight,
            viewportWidth: globalThis.innerWidth,
          };
        });
        expect(dialogBounds.left).toBeGreaterThanOrEqual(0);
        expect(dialogBounds.top).toBeGreaterThanOrEqual(0);
        expect(dialogBounds.right).toBeLessThanOrEqual(dialogBounds.viewportWidth);
        expect(dialogBounds.bottom).toBeLessThanOrEqual(dialogBounds.viewportHeight);
        expect(dialogBounds.width).toBeLessThanOrEqual(922);
        expect(dialogBounds.left).toBeGreaterThan(100);
        await expect
          .poll(() =>
            dialog
              .locator('input[name="save"]')
              .evaluate((element) => getComputedStyle(element).accentColor),
          )
          .toBe('rgb(47, 199, 161)');
        if (process.platform === 'darwin')
          await expect(page).toHaveScreenshot('axterm-host-dialog-1280x800.png', {
            animations: 'disabled',
            caret: 'hide',
            maxDiffPixelRatio: 0.01,
          });
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(addHost).toBeFocused();

        const addRdp = page.getByRole('button', { name: '添加 RDP' });
        await addRdp.click();
        const rdpDialog = page.getByRole('dialog', { name: '添加 RDP 书签' });
        const rdpForm = rdpDialog.locator('form[data-protocol="rdp"]');
        await expect(rdpDialog).toBeVisible();
        await expect(rdpForm).toBeVisible();
        await expect(rdpDialog.getByLabel('名称')).toBeFocused();
        await settleLayout(page);
        const rdpPresentation = await rdpDialog.evaluate((element) => {
          const { bottom, left, right, top, width } = element.getBoundingClientRect();
          const backdrop = element.closest<HTMLElement>('.modal-backdrop');
          const form = element.querySelector<HTMLElement>('.protocol-bookmark-form');
          const checkbox = element.querySelector<HTMLInputElement>('input[name="scaleViewport"]');
          return {
            accentColor: checkbox ? getComputedStyle(checkbox).accentColor : '',
            backdrop: backdrop ? getComputedStyle(backdrop).backgroundColor : '',
            bottom,
            columns: form ? getComputedStyle(form).gridTemplateColumns : '',
            left,
            right,
            top,
            width,
            viewportHeight: globalThis.innerHeight,
            viewportWidth: globalThis.innerWidth,
          };
        });
        expect(rdpPresentation.left).toBeGreaterThan(100);
        expect(rdpPresentation.top).toBeGreaterThanOrEqual(0);
        expect(rdpPresentation.right).toBeLessThanOrEqual(rdpPresentation.viewportWidth);
        expect(rdpPresentation.bottom).toBeLessThanOrEqual(rdpPresentation.viewportHeight);
        expect(rdpPresentation.width).toBeGreaterThanOrEqual(760);
        expect(rdpPresentation.width).toBeLessThanOrEqual(822);
        expect(rdpPresentation.columns.trim().split(/\s+/u)).toHaveLength(2);
        expect(rdpPresentation.accentColor).toBe('rgb(47, 199, 161)');
        expect(rdpPresentation.backdrop).not.toBe('rgba(0, 0, 0, 0)');
        if (process.platform === 'darwin')
          await expect(page).toHaveScreenshot('axterm-rdp-dialog-1280x800.png', {
            animations: 'disabled',
            caret: 'hide',
            maxDiffPixelRatio: 0.01,
          });
        await page.keyboard.press('Escape');
        await expect(rdpDialog).toBeHidden();
        await expect(addRdp).toBeFocused();
      }

      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="terminal"]').click();
      await expect(page.getByRole('region', { name: '终端配置' })).toBeVisible();
      await settleLayout(page);
      await assertVisibleChromeWithinViewport(page);
      if (process.platform === 'darwin')
        await expect(page).toHaveScreenshot(`axterm-settings-${width}x${height}.png`, {
          animations: 'disabled',
          caret: 'hide',
          maxDiffPixelRatio: 0.01,
        });
      await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    }

    await page.setViewportSize(viewports[0]);
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const migrationPanel = page.getByLabel('Axterm 配置快照');
    const configurationExport = migrationPanel.getByRole('button', { name: '导出 Axterm 配置' });
    await configurationExport.scrollIntoViewIfNeeded();
    await expect(configurationExport).toBeInViewport();
    const settingsOption = migrationPanel.locator('.axterm-config-settings-option');
    const settingsCheckbox = settingsOption.getByRole('checkbox', {
      name: /同时保存便携的外观/u,
    });
    const optionLayout = await settingsOption.evaluate((label) => {
      const input = label.querySelector<HTMLInputElement>('input');
      const copy = label.querySelector<HTMLElement>('span');
      if (!input || !copy) throw new Error('Migration settings option is incomplete');
      const inputBounds = input.getBoundingClientRect();
      const copyBounds = copy.getBoundingClientRect();
      return {
        accent: getComputedStyle(input).accentColor,
        copyGap: copyBounds.left - inputBounds.right,
        inputHeight: inputBounds.height,
        inputWidth: inputBounds.width,
      };
    });
    expect(optionLayout.inputWidth).toBe(16);
    expect(optionLayout.inputHeight).toBe(16);
    expect(optionLayout.copyGap).toBeGreaterThanOrEqual(6);
    expect(optionLayout.copyGap).toBeLessThanOrEqual(12);
    expect(optionLayout.accent).toBe('rgb(47, 199, 161)');
    await expect(settingsCheckbox).not.toBeChecked();
    await settleLayout(page);
    await assertVisibleChromeWithinViewport(page);
    if (process.platform === 'darwin')
      await expect(page).toHaveScreenshot('axterm-settings-data-migration-1280x800.png', {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixelRatio: 0.01,
      });

    await page.locator('[data-settings-category="common"]').click();
    await page.getByTestId('application-language').selectOption('en');
    await page.locator('[data-settings-category="sync"]').click();
    const sync = page.getByRole('region', { name: 'Setting sync' });
    await sync.getByRole('tab', { name: 'WebDAV' }).click();
    await sync.getByLabel('Service URL').fill('http://127.0.0.1:47301/storage/');
    await sync.getByLabel('Remote file name').fill('desktop.json');
    await sync.getByLabel('Username').fill('visual-review');
    await sync.getByLabel('WebDAV password').fill('VISUAL_BASELINE_ONLY');
    await sync.getByRole('button', { name: 'Save profile' }).click();
    await expect(
      sync.getByText(
        'Sync profile saved. Credentials are stored only in the application-local Vault.',
      ),
    ).toBeVisible();
    await expect(sync.getByRole('tab', { name: 'Axterm sync format' })).toHaveCount(0);
    await expect(sync.getByRole('button', { name: 'Compare' })).toBeVisible();
    // Saving adds feedback below the form; anchor this scene to the data group
    // instead of inheriting the focused button's automatic scroll position.
    const syncData = sync.getByRole('group', { name: 'Data to sync', exact: true });
    await syncData.evaluate((element) =>
      element.scrollIntoView({ block: 'start', behavior: 'instant' }),
    );
    await expect(syncData).toBeInViewport({ ratio: 1 });
    await settleLayout(page);
    await assertVisibleChromeWithinViewport(page);
    if (process.platform === 'darwin')
      await expect(page).toHaveScreenshot('axterm-settings-sync-axterm-1280x800.png', {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixelRatio: 0.01,
      });
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 keeps language settings bounded in all four supported Axterm languages', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-language-visual-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(viewports[0]);
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const languageSelect = page.getByTestId('application-language');
    const languages = [
      { id: 'en', title: 'Language', eyebrow: 'SETTINGS' },
      { id: 'ja', title: '言語', eyebrow: '設定' },
      { id: 'zh-CN', title: '语言', eyebrow: '设置' },
      { id: 'zh-TW', title: '語言', eyebrow: '設定' },
    ] as const;

    for (const { id, title, eyebrow } of languages) {
      await languageSelect.selectOption(id);
      await expect(languageSelect).toHaveValue(id);
      const languagePanel = page.getByRole('region', { name: title });
      await expect(languagePanel).toBeVisible();
      await expect(languagePanel.locator('header small')).toHaveText(eyebrow);
      await languagePanel.evaluate((panel) =>
        panel.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
      );
      await expect(languageSelect).toBeInViewport();
      await settleLayout(page);
      await assertVisibleChromeWithinViewport(page);
      const clippedLabels = await page
        .locator('.settings-workspace-tabs button')
        .evaluateAll((buttons) =>
          buttons.flatMap((button) =>
            button.scrollWidth > button.clientWidth + 1 ? [button.textContent?.trim()] : [],
          ),
        );
      expect(clippedLabels, `${id} settings navigation labels`).toEqual([]);
      for (const close of await page.locator('.settings-workspace-close').all()) {
        const target = await close.boundingBox();
        expect(target?.width).toBeGreaterThanOrEqual(24);
        expect(target?.height).toBeGreaterThanOrEqual(24);
      }
      const bounds = await languagePanel.evaluate((panel) => {
        const select = panel.querySelector<HTMLElement>('[data-testid="application-language"]');
        if (!select) throw new Error('Language selector is missing');
        const panelBounds = panel.getBoundingClientRect();
        const selectBounds = select.getBoundingClientRect();
        return {
          documentWidth: document.documentElement.scrollWidth,
          panelClientWidth: panel.clientWidth,
          panelScrollWidth: panel.scrollWidth,
          panelTop: panelBounds.top,
          panelRight: panelBounds.right,
          panelBottom: panelBounds.bottom,
          selectTop: selectBounds.top,
          selectRight: selectBounds.right,
          selectBottom: selectBounds.bottom,
          viewportWidth: globalThis.innerWidth,
          viewportHeight: globalThis.innerHeight,
        };
      });
      expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewportWidth);
      expect(bounds.panelScrollWidth).toBeLessThanOrEqual(bounds.panelClientWidth + 1);
      expect(bounds.panelTop).toBeGreaterThanOrEqual(0);
      expect(bounds.panelRight).toBeLessThanOrEqual(bounds.viewportWidth);
      expect(bounds.panelBottom).toBeLessThanOrEqual(bounds.viewportHeight);
      expect(bounds.selectTop).toBeGreaterThanOrEqual(0);
      expect(bounds.selectRight).toBeLessThanOrEqual(bounds.viewportWidth);
      expect(bounds.selectBottom).toBeLessThanOrEqual(bounds.viewportHeight);
      if (process.platform === 'darwin')
        await expect(page).toHaveScreenshot(`axterm-language-${id}-1280x800.png`, {
          animations: 'disabled',
          caret: 'hide',
          maxDiffPixelRatio: 0.01,
        });
    }
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 keeps all four language settings usable at 200% interface zoom', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-language-zoom-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([720, 450]);

    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const languageSelect = page.getByTestId('application-language');
    const languages = [
      { id: 'en', title: 'Language', eyebrow: 'SETTINGS' },
      { id: 'ja', title: '言語', eyebrow: '設定' },
      { id: 'zh-CN', title: '语言', eyebrow: '设置' },
      { id: 'zh-TW', title: '語言', eyebrow: '設定' },
    ] as const;

    for (const { id, title, eyebrow } of languages) {
      await languageSelect.selectOption(id);
      await expect(languageSelect).toHaveValue(id);
      await expect(languageSelect).toBeEnabled();
      const panel = page.getByRole('region', { name: title });
      await expect(panel.locator('header small')).toHaveText(eyebrow);
      await panel.evaluate((element) =>
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }),
      );
      await expect(panel).toBeVisible();
      await expect(languageSelect).toBeInViewport();
      await settleLayout(page);

      const bounds = await panel.evaluate((element) => {
        const select = element.querySelector<HTMLElement>('[data-testid="application-language"]');
        if (!select) throw new Error('Language selector is missing');
        const panelBounds = element.getBoundingClientRect();
        const selectBounds = select.getBoundingClientRect();
        return {
          documentWidth: document.documentElement.scrollWidth,
          panelClientWidth: element.clientWidth,
          panelScrollWidth: element.scrollWidth,
          panelLeft: panelBounds.left,
          panelTop: panelBounds.top,
          panelRight: panelBounds.right,
          panelBottom: panelBounds.bottom,
          selectLeft: selectBounds.left,
          selectTop: selectBounds.top,
          selectRight: selectBounds.right,
          selectBottom: selectBounds.bottom,
          viewportWidth: globalThis.innerWidth,
          viewportHeight: globalThis.innerHeight,
        };
      });
      expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.viewportWidth + 1);
      expect(bounds.panelScrollWidth).toBeLessThanOrEqual(bounds.panelClientWidth + 1);
      expect(bounds.panelLeft).toBeGreaterThanOrEqual(-1);
      expect(bounds.panelTop).toBeGreaterThanOrEqual(-1);
      expect(bounds.panelRight).toBeLessThanOrEqual(bounds.viewportWidth + 1);
      expect(bounds.panelBottom).toBeLessThanOrEqual(bounds.viewportHeight + 1);
      expect(bounds.selectLeft).toBeGreaterThanOrEqual(-1);
      expect(bounds.selectTop).toBeGreaterThanOrEqual(-1);
      expect(bounds.selectRight).toBeLessThanOrEqual(bounds.viewportWidth + 1);
      expect(bounds.selectBottom).toBeLessThanOrEqual(bounds.viewportHeight + 1);

      for (const category of [
        'common',
        'terminal',
        'shortcuts',
        'sync',
        'ai',
        'password',
        'legal',
      ] as const) {
        const button = page.locator(`[data-settings-category="${category}"]`);
        await button.click();
        await expect(button).toHaveAttribute('aria-current', 'page');
        const content = page.locator(`.settings-item-${category} .panel-page`);
        await expect(content).toBeVisible();
        await settleLayout(page);
        const widths = await content.evaluate((element) => ({
          content: element.clientWidth,
          scroll: element.scrollWidth,
          document: document.documentElement.scrollWidth,
          viewport: globalThis.innerWidth,
        }));
        expect(
          widths.scroll,
          `${id}/${category} content overflows at 200% zoom`,
        ).toBeLessThanOrEqual(widths.content + 1);
        expect(
          widths.document,
          `${id}/${category} document overflows at 200% zoom`,
        ).toBeLessThanOrEqual(widths.viewport + 1);
      }
      await page.locator('[data-settings-category="common"]').click();
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 keeps failed language changes localized and preserves the saved choice', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-language-error-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const select = page.getByTestId('application-language');
    const status = page.locator('.language-settings-panel [role="status"]');
    await select.selectOption('en');
    await expect(select).toHaveValue('en');

    let failSave = false;
    await page.route('**/api/v1/settings', async (route) => {
      if (failSave && route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Synthetic failure',
            status: 500,
            detail: 'do-not-show-this-in-ui',
          }),
        });
        return;
      }
      await route.continue();
    });

    const cases = [
      {
        from: 'en',
        to: 'ja',
        failure: 'Unable to save the language. Your previous language is still active; try again.',
      },
      {
        from: 'ja',
        to: 'zh-CN',
        failure:
          '言語を保存できませんでした。以前の言語設定は維持されています。もう一度お試しください。',
      },
      {
        from: 'zh-CN',
        to: 'zh-TW',
        failure: '无法保存语言。原来的语言仍然生效，请重试。',
      },
      {
        from: 'zh-TW',
        to: 'en',
        failure: '無法儲存語言。原本的語言設定仍然有效，請重試。',
      },
    ] as const;

    for (const { from, to, failure } of cases) {
      await expect(page.locator('html')).toHaveAttribute('lang', from);
      failSave = true;
      await select.selectOption(to);
      await expect(status).toHaveText(failure);
      await expect(status).not.toContainText('do-not-show-this-in-ui');
      await expect(select).toHaveValue(from);
      await expect(page.locator('html')).toHaveAttribute('lang', from);

      failSave = false;
      await select.selectOption(to);
      await expect(select).toHaveValue(to);
      await expect(page.locator('html')).toHaveAttribute('lang', to);
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 localizes failed behavior and terminal settings saves without exposing Runtime details', async () => {
  test.setTimeout(120_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-settings-error-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    let failSave = false;
    await page.route('**/api/v1/settings', async (route) => {
      if (failSave && route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Synthetic failure',
            status: 500,
            detail: 'settings-secret-canary-do-not-display',
          }),
        });
        return;
      }
      await route.continue();
    });

    const cases = [
      {
        id: 'en',
        behavior: 'Unable to save the setting.',
        terminal: 'Unable to save terminal-recovery settings.',
        monitor: 'Unable to save terminal-monitor settings.',
      },
      {
        id: 'ja',
        behavior: '設定を保存できませんでした。',
        terminal: 'ターミナル復旧設定を保存できません。',
        monitor: 'ターミナルモニター設定を保存できません。',
      },
      {
        id: 'zh-CN',
        behavior: '无法保存设置。',
        terminal: '无法保存终端恢复设置',
        monitor: '无法保存终端监控设置',
      },
      {
        id: 'zh-TW',
        behavior: '無法儲存設定。',
        terminal: '無法儲存終端機復原設定。',
        monitor: '無法儲存終端機監控設定。',
      },
    ] as const;

    for (const locale of cases) {
      await page.locator('[data-settings-category="common"]').click();
      await page.getByTestId('application-language').selectOption(locale.id);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
      const behavior = page.locator('.behavior-settings');
      const behaviorToggle = behavior.locator('label.check input[type="checkbox"]').first();
      const behaviorBefore = await behaviorToggle.isChecked();
      failSave = true;
      await behaviorToggle.click();
      await expect(behavior.getByRole('alert')).toHaveText(locale.behavior);
      await expect(behaviorToggle).toHaveJSProperty('checked', behaviorBefore);
      await expect(page.getByText('settings-secret-canary-do-not-display')).toHaveCount(0);
      failSave = false;
      await behaviorToggle.click();
      await expect(behaviorToggle).toHaveJSProperty('checked', !behaviorBefore);
      await expect(behavior.getByRole('alert')).toHaveCount(0);

      await page.locator('[data-settings-category="terminal"]').click();
      const recovery = page.locator('.terminal-recovery-settings-panel');
      const terminalToggle = recovery.locator('label.check input[type="checkbox"]').first();
      const terminalBefore = await terminalToggle.isChecked();
      failSave = true;
      await terminalToggle.click();
      await expect(recovery.getByRole('alert')).toHaveText(locale.terminal);
      await expect(terminalToggle).toHaveJSProperty('checked', terminalBefore);
      failSave = false;
      await terminalToggle.click();
      await expect(terminalToggle).toHaveJSProperty('checked', !terminalBefore);
      await expect(recovery.getByRole('alert')).toHaveCount(0);

      const monitorToggle = recovery.locator(
        '.remote-monitor-setting label.check input[type="checkbox"]',
      );
      const monitorBefore = await monitorToggle.isChecked();
      failSave = true;
      await monitorToggle.click();
      await expect(recovery.getByRole('alert')).toHaveText(locale.monitor);
      await expect(monitorToggle).toHaveJSProperty('checked', monitorBefore);
      await expect(page.getByText('settings-secret-canary-do-not-display')).toHaveCount(0);
      failSave = false;
      await monitorToggle.click();
      await expect(monitorToggle).toHaveJSProperty('checked', !monitorBefore);
      await expect(recovery.getByRole('alert')).toHaveCount(0);
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 localizes proxy, tab and window preferences failures with recovery in four languages', async () => {
  test.setTimeout(120_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-preferences-error-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    let rejectSettingsSave = false;
    let rejectWindowLoad = false;
    let rejectWindowSave = false;
    const failureBody = JSON.stringify({
      type: 'about:blank',
      title: 'Synthetic failure',
      status: 500,
      detail: 'preferences-secret-canary-do-not-display',
    });
    await page.route('**/api/v1/settings', async (route) => {
      if (rejectSettingsSave && route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: failureBody,
        });
        return;
      }
      await route.continue();
    });
    await page.route('**/api/v1/desktop/window/preferences', async (route) => {
      if (
        (rejectWindowLoad && route.request().method() === 'GET') ||
        (rejectWindowSave && route.request().method() === 'PATCH')
      ) {
        await route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: failureBody,
        });
        return;
      }
      await route.continue();
    });

    const cases = [
      {
        id: 'en',
        tab: 'Unable to save tab settings.',
        proxy: 'Proxy operation failed.',
        proxyInput: 'A proxy username is required when a proxy password is entered.',
        windowLoad: 'Unable to load window preferences. Try again.',
        windowSave: 'Unable to save window preferences. Try again.',
      },
      {
        id: 'ja',
        tab: 'タブ設定を保存できません。',
        proxy: 'プロキシ操作に失敗しました。',
        proxyInput: 'プロキシパスワードを入力する場合は、プロキシのユーザー名が必要です。',
        windowLoad: 'ウィンドウ設定の読み込みに失敗しました。もう一度お試しください。',
        windowSave: 'ウィンドウ設定の保存に失敗しました。もう一度お試しください。',
      },
      {
        id: 'zh-CN',
        tab: '无法保存标签设置',
        proxy: '代理操作失败。',
        proxyInput: '填写代理密码时也必须填写代理用户名。',
        windowLoad: '无法读取窗口偏好。请重试。',
        windowSave: '无法保存窗口偏好。请重试。',
      },
      {
        id: 'zh-TW',
        tab: '無法儲存分頁設定。',
        proxy: 'Proxy 操作失敗。',
        proxyInput: '輸入 Proxy 密碼時必須提供 Proxy 使用者名稱。',
        windowLoad: '無法載入視窗偏好設定。請重試。',
        windowSave: '無法儲存視窗偏好設定。請重試。',
      },
    ] as const;

    for (const locale of cases) {
      await page.locator('[data-settings-category="common"]').click();
      await page.getByTestId('application-language').selectOption(locale.id);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.id);

      rejectWindowLoad = true;
      await page.locator('[data-settings-category="terminal"]').click();
      await page.locator('[data-settings-category="common"]').click();
      const windowPanel = page.locator('[aria-labelledby="window-preferences-title"]');
      await expect(windowPanel.getByRole('alert')).toHaveText(locale.windowLoad);
      await expect(page.getByText('preferences-secret-canary-do-not-display')).toHaveCount(0);
      rejectWindowLoad = false;
      await windowPanel.getByRole('button').click();
      await expect(windowPanel.locator('form')).toBeVisible();

      rejectWindowSave = true;
      await windowPanel.locator('form button[type="submit"]').click();
      await expect(windowPanel.getByRole('alert')).toHaveText(locale.windowSave);
      await expect(page.getByText('preferences-secret-canary-do-not-display')).toHaveCount(0);
      rejectWindowSave = false;
      await windowPanel.locator('form button[type="submit"]').click();
      await expect(windowPanel.getByRole('alert')).toHaveCount(0);

      const tab = page.locator('.tab-preferences-panel');
      const tabToggle = tab.locator('label.check input[type="checkbox"]').first();
      const tabBefore = await tabToggle.isChecked();
      rejectSettingsSave = true;
      await tabToggle.click();
      await expect(tab.getByRole('alert')).toHaveText(locale.tab);
      await expect(tabToggle).toHaveJSProperty('checked', tabBefore);
      rejectSettingsSave = false;
      await tabToggle.click();
      await expect(tabToggle).toHaveJSProperty('checked', !tabBefore);
      await expect(tab.getByRole('alert')).toHaveCount(0);

      const proxy = page.locator('[aria-labelledby="proxy-settings-title"]');
      rejectSettingsSave = true;
      await proxy.locator('form button[value="save"]').click();
      await expect(proxy.getByRole('alert')).toHaveText(locale.proxy);
      await expect(page.getByText('preferences-secret-canary-do-not-display')).toHaveCount(0);
      rejectSettingsSave = false;
      await proxy.locator('form button[value="save"]').click();
      await expect(proxy.getByRole('alert')).toHaveCount(0);

      await proxy.locator('select[name="proxyMode"]').selectOption('custom');
      await proxy.locator('input[name="proxyUrl"]').fill('http://127.0.0.1:1080');
      await proxy.locator('input[name="proxyPassword"]').fill('test-only-password');
      await proxy.locator('form button[value="save"]').click();
      await expect(proxy.getByRole('alert')).toHaveText(locale.proxyInput);
      await proxy.locator('select[name="proxyMode"]').selectOption('direct');
      await proxy.locator('form button[value="save"]').click();
      await expect(proxy.getByRole('alert')).toHaveCount(0);
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 shows localized Settings load recovery and Runtime outage in four languages', async () => {
  test.setTimeout(150_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-settings-unavailable-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'languages', {
        configurable: true,
        get: () => [window.name || 'en'],
      });
    });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    let rejectSettingsRead = false;
    let rejectRuntimeStatus = false;
    const failureBody = JSON.stringify({
      type: 'about:blank',
      title: 'Synthetic failure',
      status: 500,
      detail: 'outage-secret-canary-do-not-display',
    });
    await page.route('**/api/v1/settings', async (route) => {
      if (rejectSettingsRead && route.request().method() === 'GET') {
        await route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          body: failureBody,
        });
        return;
      }
      await route.continue();
    });
    await page.route('**/api/v1/runtime', async (route) => {
      if (rejectRuntimeStatus && route.request().method() === 'GET') {
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: failureBody,
        });
        return;
      }
      await route.continue();
    });

    const cases = [
      {
        id: 'en',
        ready: 'Runtime Ready',
        degraded: 'Runtime Degraded',
        loadFailed: 'Unable to load settings. Saved preferences were not changed.',
        retry: 'Retry loading settings',
      },
      {
        id: 'ja',
        ready: 'Runtime の準備ができました',
        degraded: 'Runtime への接続が中断されました',
        loadFailed: '設定を読み込めませんでした。保存済みの設定は変更されていません。',
        retry: '設定の読み込みを再試行',
      },
      {
        id: 'zh-CN',
        ready: 'Runtime 已就绪',
        degraded: 'Runtime 连接中断',
        loadFailed: '无法读取设置。已保存的偏好未更改。',
        retry: '重试读取设置',
      },
      {
        id: 'zh-TW',
        ready: 'Runtime 已就緒',
        degraded: 'Runtime 連線中斷',
        loadFailed: '無法載入設定。已儲存的偏好設定並未變更。',
        retry: '重試載入設定',
      },
    ] as const;

    for (const locale of cases) {
      rejectSettingsRead = false;
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      await page.getByTestId('application-language').selectOption(locale.id);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
      await page.evaluate((id) => {
        window.name = id;
      }, locale.id);

      rejectSettingsRead = true;
      await page.reload();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await expect(page.getByTestId('runtime-state')).toHaveText(locale.ready);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.id);
      await page.locator('[data-activity-item="setting"]').click();
      await page.locator('[data-settings-category="common"]').click();
      const loadError = page.locator('.settings-load-error');
      await expect(loadError).toHaveText(`${locale.loadFailed}${locale.retry}`);
      await expect(page.getByTestId('application-language')).toBeDisabled();
      await expect(page.getByText('outage-secret-canary-do-not-display')).toHaveCount(0);
      rejectSettingsRead = false;
      await loadError.getByRole('button', { name: locale.retry }).click();
      await expect(loadError).toHaveCount(0);
      await expect(page.getByTestId('application-language')).toBeEnabled();
      await expect(page.getByTestId('application-language')).toHaveValue(locale.id);

      rejectRuntimeStatus = true;
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'degraded');
      await expect(page.getByTestId('runtime-state')).toHaveText(locale.degraded);
      await expect(page.locator('.runtime-wait h2')).toHaveText(locale.degraded);
      await expect(page.getByText('outage-secret-canary-do-not-display')).toHaveCount(0);
      rejectRuntimeStatus = false;
      await page.locator('.runtime-wait button').click();
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await expect(page.getByTestId('runtime-state')).toHaveText(locale.ready);
    }
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 S2 localizes SSH, FTP and connection editor validation and retry at 200% zoom', async () => {
  test.setTimeout(300_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-editor-s2-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 720, height: 450 });
    await verifyFourLocaleEditorConditionalJourney(page);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 S3 localizes terminal search, file-list recovery and transfer states at 200% zoom', async () => {
  test.skip(process.platform !== 'darwin', 'This Mac engineering cell uses a local POSIX PTY.');
  test.setTimeout(300_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-conditional-s3-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 720, height: 450 });
    await verifyFourLocaleS3ConditionalJourney(page);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 S4 localizes theme, Widget and AI recovery and empty states at 200% zoom', async () => {
  test.skip(process.platform !== 'darwin', 'This Mac engineering cell uses macOS Electron.');
  test.setTimeout(300_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-conditional-s4-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 720, height: 450 });
    await verifyFourLocaleS4ConditionalJourney(page);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 S5 keeps Shell and navigation mutation errors safe and retryable in four languages', async () => {
  test.skip(process.platform !== 'darwin', 'This Mac engineering cell uses macOS Electron.');
  test.setTimeout(300_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-conditional-s5-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
      .toEqual({ width: 720, height: 450 });
    await verifyFourLocaleS5ShellJourney(page);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 keeps Host and protocol editors bounded and operable at 200% interface zoom', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-visual-zoom-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');

    // This is the same BrowserWindow preference applied by the host capability.
    // The UI flow that saves it is covered separately; P-07 needs a stable
    // rendering regression for the resulting text-scaled layout.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() =>
        page.evaluate(() => ({
          height: globalThis.innerHeight,
          width: globalThis.innerWidth,
          zoom: globalThis.devicePixelRatio,
        })),
      )
      .toMatchObject({ width: 720, height: 450 });

    await page.locator('[data-activity-item="bookmarks"]').click();
    await page.locator('.workspace-sidebar').getByRole('button', { name: '管理' }).click();
    await expect(page.locator('.workspace-sidebar')).toBeVisible();
    await expect(page.locator('.section-tab')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '主机与连接' })).toBeVisible();
    const addHost = page.getByRole('button', { name: '添加主机' });
    await expect(addHost).toBeVisible();
    await addHost.scrollIntoViewIfNeeded();
    await expect(addHost).toBeInViewport();
    await addHost.click();
    const dialog = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('名称')).toBeFocused();
    await settleLayout(page);

    const violations = await dialog.evaluate((root) => {
      const viewport = { height: globalThis.innerHeight, width: globalThis.innerWidth };
      const asBounds = (element: Element | null) => {
        if (!element) return null;
        const { bottom, height, left, right, top, width } = element.getBoundingClientRect();
        return { bottom, height, left, right, top, width };
      };
      const outside = (label: string, bounds: ReturnType<typeof asBounds>, minWidth = 0) => {
        if (!bounds) return [`${label} is missing`];
        return bounds.left < -1 ||
          bounds.top < -1 ||
          bounds.right > viewport.width + 1 ||
          bounds.bottom > viewport.height + 1 ||
          bounds.width < minWidth
          ? [`${label}: ${JSON.stringify({ ...bounds, viewport })}`]
          : [];
      };
      return [
        ...outside('dialog', asBounds(root)),
        ...outside('close', asBounds(root.querySelector('header button'))),
        ...outside('input[name=name]', asBounds(root.querySelector('[name="name"]')), 120),
      ];
    });
    expect(violations).toEqual([]);

    const hostAddress = dialog.getByLabel('主机地址');
    const username = dialog.getByLabel('用户名');
    await page.keyboard.press('Tab');
    await expect(hostAddress).toBeFocused();
    await expect(hostAddress).toBeInViewport();
    await page.keyboard.press('Tab');
    await expect(username).toBeFocused();
    await expect(username).toBeInViewport();

    const tabs = dialog.getByRole('tab');
    await tabs.first().press('End');
    await expect(tabs.last()).toBeFocused();
    await expect(tabs.last()).toBeInViewport();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(addHost).toBeFocused();

    const addRdp = page.getByRole('button', { name: '添加 RDP' });
    await addRdp.scrollIntoViewIfNeeded();
    await expect(addRdp).toBeInViewport();
    await addRdp.click();
    const rdpDialog = page.getByRole('dialog', { name: '添加 RDP 书签' });
    const rdpName = rdpDialog.getByLabel('名称');
    await expect(rdpDialog).toBeVisible();
    await expect(rdpName).toBeFocused();
    await settleLayout(page);

    const rdpViolations = await rdpDialog.evaluate((root) => {
      const viewport = { height: globalThis.innerHeight, width: globalThis.innerWidth };
      const bounds = (element: Element | null) => {
        if (!element) return null;
        const { bottom, height, left, right, top, width } = element.getBoundingClientRect();
        return { bottom, height, left, right, top, width };
      };
      const outside = (label: string, value: ReturnType<typeof bounds>, minWidth = 0) => {
        if (!value) return [`${label} is missing`];
        return value.left < -1 ||
          value.top < -1 ||
          value.right > viewport.width + 1 ||
          value.bottom > viewport.height + 1 ||
          value.width < minWidth
          ? [`${label}: ${JSON.stringify({ ...value, viewport })}`]
          : [];
      };
      const form = root.querySelector<HTMLElement>('.protocol-bookmark-form');
      return [
        ...outside('dialog', bounds(root)),
        ...outside('close', bounds(root.querySelector('header button'))),
        ...outside('input[name=name]', bounds(root.querySelector('[name="name"]')), 120),
        ...(form && getComputedStyle(form).gridTemplateColumns.trim().split(/\s+/u).length === 1
          ? []
          : ['protocol form did not collapse to one column']),
      ];
    });
    expect(rdpViolations).toEqual([]);

    const desktopWidth = rdpDialog.getByLabel('桌面宽度');
    await desktopWidth.scrollIntoViewIfNeeded();
    await expect(desktopWidth).toBeInViewport();
    const saveAndConnect = rdpDialog.getByRole('button', { name: '保存并连接' });
    await saveAndConnect.scrollIntoViewIfNeeded();
    await expect(saveAndConnect).toBeVisible();
    await expect(saveAndConnect).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth + 1),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(rdpDialog).toBeHidden();
    await expect(addRdp).toBeFocused();
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 renders terminal tab numbers with the Axterm mint selection token', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-visual-mint-tab-number-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const tabNumber = page.locator('.terminal-tab .tab-number').first();
    await expect(tabNumber).toBeVisible();
    await expect(tabNumber).toHaveText('1');
    expect(
      await page.locator('.terminal-pane.active .tab-add').evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const hitTarget = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        return hitTarget === button || button.contains(hitTarget);
      }),
    ).toBe(true);
    expect(
      await tabNumber.evaluate((element) => {
        const styles = getComputedStyle(element);
        return { backgroundColor: styles.backgroundColor, color: styles.color };
      }),
    ).toEqual({
      backgroundColor: 'rgb(47, 199, 161)',
      color: 'rgb(6, 32, 27)',
    });
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 renders the connection-profile focus boundary with the Axterm mint token', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-visual-mint-profile-focus-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await page.locator('[data-activity-item="setting"]').click();
    await page.getByRole('button', { name: /Profiles|终端配置/ }).click();

    const panel = page.getByRole('region', { name: '连接配置' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('heading', { name: '连接配置' })).toBeVisible();
    await expect(panel.getByRole('button', { name: '连接配置', exact: true })).toBeVisible();
    await expect(panel.getByText('尚无连接配置。保存第一项后会自动设为默认。')).toBeVisible();
    await expect(panel.getByText('Profiles', { exact: true })).toHaveCount(0);
    await expect(panel.getByText(/连接 Profile|Profile 名称/u)).toHaveCount(0);
    await expect(panel.getByText(/ID:\s*PROFILE\d+/u)).toHaveCount(0);
    const profileName = page.getByTestId('connection-profile-form').locator('input[name="name"]');
    await expect(profileName).toBeVisible();
    await expect(profileName).toHaveAttribute('aria-label', '连接配置名称');
    await expect(profileName).toBeFocused();
    const focusBoundary = await profileName.evaluate((element) => {
      const styles = getComputedStyle(element);
      return { borderTopColor: styles.borderTopColor, boxShadow: styles.boxShadow };
    });
    expect(focusBoundary.borderTopColor).toBe('rgb(47, 199, 161)');
    // Chromium may serialize the equivalent color-mix() result either as rgba
    // or as a CSS Color 4 `color(srgb …)` value, depending on its version.
    expect(focusBoundary.boxShadow).toMatch(
      /(?:rgba\(47, 199, 161, 0\.24\)|color\(srgb 0\.184314 0\.780392 0\.631373 \/ 0\.24\)) 0px 0px 0px 2px/u,
    );
    await settleLayout(page);
    if (process.platform === 'darwin')
      await expect(page).toHaveScreenshot('axterm-connection-profiles-1280x800.png', {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixelRatio: 0.01,
      });
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 keeps connection-configuration editing reachable at 200% interface zoom', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-visual-connection-profile-zoom-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([720, 450]);

    await page.locator('[data-activity-item="setting"]').click();
    await page.getByRole('button', { name: '终端配置', exact: true }).click();
    const panel = page.getByRole('region', { name: '连接配置' });
    await expect(panel.getByRole('heading', { name: '连接配置' })).toBeVisible();

    const profileName = panel.getByLabel('连接配置名称');
    await profileName.scrollIntoViewIfNeeded();
    await expect(profileName).toBeVisible();
    await expect(profileName).toBeInViewport();
    const protocols = panel.getByRole('tablist', { name: '配置适用协议' });
    await protocols.getByRole('tab', { name: 'SPICE' }).click();
    await expect(protocols.getByRole('tab', { name: 'SPICE' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    const save = panel.getByRole('button', { name: '保存配置' });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeVisible();
    await expect(save).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth + 1),
    ).toBe(true);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 gives empty panes an Axterm-owned keyboard-operable three-viewport baseline', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-visual-empty-pane-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    await page.getByTitle('布局与工作区').click();
    await page.locator('[data-layout-choice="c2x2"]').click();
    await expect(page.locator('.empty-pane-landing')).toHaveCount(3);
    await expect(page.locator('.empty-pane-sort')).toHaveCount(0);

    for (const { width, height } of viewports) {
      await page.setViewportSize({ width, height });
      await expect
        .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
        .toEqual([width, height]);
      await settleLayout(page);

      const emptyPanes = page.locator('.empty-pane-landing');
      await expect(emptyPanes).toHaveCount(3);
      for (let paneNumber = 2; paneNumber <= 4; paneNumber += 1) {
        await expect(page.getByRole('region', { name: `窗格 ${paneNumber} 会话` })).toHaveCount(1);
      }
      const first = emptyPanes.first();
      await expect(first).toHaveRole('region');
      await expect(first.getByRole('heading', { name: '本地终端', level: 2 })).toBeVisible();
      await expect(first.getByRole('button', { name: '新建终端' })).toBeVisible();
      await expect(first.getByRole('button', { name: '不保存直接连接' })).toBeVisible();
      await expect(first.getByRole('button', { name: '添加已保存连接' })).toBeVisible();
      await expect(first.getByRole('button', { name: '使用 AI 草拟连接' })).toBeVisible();
      await expect(first.getByLabel('为窗格 2 选择已有会话')).toBeVisible();

      const violations = await emptyPanes.evaluateAll((panes) =>
        panes.flatMap((pane, paneIndex) => {
          const paneBounds = pane.getBoundingClientRect();
          return Array.from(pane.querySelectorAll<HTMLElement>('button, select')).flatMap(
            (control) => {
              const bounds = control.getBoundingClientRect();
              return bounds.left < paneBounds.left - 1 ||
                bounds.top < paneBounds.top - 1 ||
                bounds.right > paneBounds.right + 1 ||
                bounds.bottom > paneBounds.bottom + 1 ||
                bounds.width < 24 ||
                bounds.height < 24
                ? [
                    `pane ${paneIndex + 2}: ${control.tagName} ${JSON.stringify({
                      control: bounds.toJSON(),
                      pane: paneBounds.toJSON(),
                    })}`,
                  ]
                : [];
            },
          );
        }),
      );
      expect(violations).toEqual([]);
      expect(
        await first
          .locator('.empty-pane-glyph')
          .evaluate((element) => getComputedStyle(element).color),
      ).toBe('rgb(47, 199, 161)');
      expect(
        await first.getByRole('button', { name: '新建终端' }).evaluate((element) => {
          const styles = getComputedStyle(element);
          return { backgroundColor: styles.backgroundColor, color: styles.color };
        }),
      ).toEqual({ backgroundColor: 'rgb(47, 199, 161)', color: 'rgb(6, 32, 27)' });

      if (process.platform === 'darwin')
        await expect(page).toHaveScreenshot(`axterm-empty-pane-${width}x${height}.png`, {
          animations: 'disabled',
          caret: 'hide',
          maxDiffPixelRatio: 0.01,
        });
    }

    const newTerminal = page
      .locator('.empty-pane-landing')
      .first()
      .getByRole('button', { name: '新建终端' });
    await newTerminal.focus();
    await expect(newTerminal).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.empty-pane-landing')).toHaveCount(2);
    await expect(page.locator('.terminal-host:visible')).toHaveCount(2);
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 keeps Axterm configuration and sync controls reachable at 200% interface zoom', async () => {
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-visual-migration-zoom-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([720, 450]);

    await page.locator('[data-activity-item="setting"]').click();
    await page.locator('[data-settings-category="common"]').click();
    const panel = page.getByLabel('Axterm 配置快照');
    const configurationActions = [
      panel.getByRole('button', { name: '检查 Axterm 文件' }),
      panel.getByRole('button', { name: '导入 Axterm 配置' }),
      panel.getByRole('button', { name: '导出 Axterm 配置' }),
    ];

    await configurationActions[0]!.scrollIntoViewIfNeeded();
    await settleLayout(page);
    for (const action of configurationActions) {
      await expect(action).toBeVisible();
      await expect(action).toBeInViewport();
    }

    await configurationActions[0]!.focus();
    await expect(configurationActions[0]!).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(configurationActions[1]!).toBeFocused();
    await expect(configurationActions[1]!).toBeInViewport();
    await page.keyboard.press('Tab');
    await expect(configurationActions[2]!).toBeFocused();
    await expect(configurationActions[2]!).toBeInViewport();

    const settingsCheckbox = panel.getByRole('checkbox', { name: /同时保存便携的外观/u });
    await settingsCheckbox.scrollIntoViewIfNeeded();
    await expect(settingsCheckbox).toBeInViewport();
    await settingsCheckbox.focus();
    await expect(settingsCheckbox).toBeFocused();
    await page.keyboard.press('Space');
    await expect(settingsCheckbox).toBeChecked();
    await page.keyboard.press('Space');
    await expect(settingsCheckbox).not.toBeChecked();
    await panel.locator('.axterm-config-settings-option span').click();
    await expect(settingsCheckbox).toBeChecked();
    await panel.locator('.axterm-config-settings-option span').click();
    await expect(settingsCheckbox).not.toBeChecked();

    const failures = await panel.evaluate((root) => {
      const actions = Array.from(
        root.querySelectorAll<HTMLElement>('.axterm-config-actions button'),
      );
      return actions.flatMap((action) => {
        const bounds = action.getBoundingClientRect();
        return bounds.left < -1 ||
          bounds.top < -1 ||
          bounds.right > globalThis.innerWidth + 1 ||
          bounds.bottom > globalThis.innerHeight + 1
          ? [`${action.textContent}: ${JSON.stringify(bounds.toJSON())}`]
          : [];
      });
    });
    expect(failures).toEqual([]);

    await page.locator('[data-settings-category="sync"]').click();
    const sync = page.getByRole('region', { name: '设置同步' });
    const webdav = sync.getByRole('tab', { name: 'WebDAV' });
    await webdav.scrollIntoViewIfNeeded();
    await webdav.click();
    await sync.getByLabel('服务地址').fill('http://127.0.0.1:47303/storage/');
    await sync.getByLabel('远程文件名').fill('zoom-review.json');
    await sync.getByLabel('用户名').fill('zoom-review');
    await sync.getByLabel('WebDAV 密码').fill('ZOOM_FIXTURE_ONLY');
    const saveSyncProfile = sync.getByRole('button', { name: '保存配置' });
    await saveSyncProfile.scrollIntoViewIfNeeded();
    await saveSyncProfile.click();
    await expect(sync.getByText('同步配置已保存；凭据只保存在应用本地 Vault。')).toBeVisible();

    await expect(sync.getByRole('tab', { name: '旧版迁移格式' })).toHaveCount(0);
    const compareSyncData = sync.getByRole('button', { name: '比较' });
    await compareSyncData.scrollIntoViewIfNeeded();
    await settleLayout(page);
    await expect(compareSyncData).toBeInViewport();
    expect(
      await sync.evaluate((root) => {
        const action = Array.from(
          root.querySelectorAll<HTMLElement>('.data-sync-actions button'),
        ).find((button) => button.textContent?.includes('比较'));
        const bounds = action?.getBoundingClientRect();
        return {
          horizontalOverflow: root.scrollWidth - root.clientWidth,
          actionOutsideViewport:
            !bounds || bounds.left < -1 || bounds.right > globalThis.innerWidth + 1,
        };
      }),
    ).toEqual({ horizontalOverflow: 0, actionOutsideViewport: false });
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 U1 keeps Shell navigation and empty panes keyboard-reachable at 200% zoom', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-shell-u1-zoom-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.context().addInitScript({ path: axeScriptPath });
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([640, 400]);

    const layout = page.getByTitle('布局与工作区');
    await layout.focus();
    await expectFocusedControl(layout);
    await expect(layout).toBeInViewport();
    await layout.press('Enter');
    const fourPanes = page.locator('[data-layout-choice="c2x2"]');
    await expect(fourPanes).toBeVisible();
    await fourPanes.focus();
    await fourPanes.press('Enter');
    await expect(page.locator('.empty-pane-landing')).toHaveCount(3);

    const firstPane = page.locator('.empty-pane-landing').first();
    for (const control of [
      firstPane.getByRole('button', { name: '新建终端' }),
      firstPane.getByRole('button', { name: '不保存直接连接' }),
      firstPane.getByRole('button', { name: '添加已保存连接' }),
      firstPane.getByRole('button', { name: '使用 AI 草拟连接' }),
      firstPane.getByLabel('为窗格 2 选择已有会话'),
    ]) {
      await control.focus();
      await expectFocusedControl(control);
      await expect(control).toBeInViewport();
    }
    const paneOverflow = await firstPane.evaluate((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(
      paneOverflow.scrollHeight <= paneOverflow.clientHeight + 1 ||
        ['auto', 'scroll'].includes(paneOverflow.overflowY),
      `Empty pane content must be scrollable: ${JSON.stringify(paneOverflow)}`,
    ).toBe(true);
    await assertNoVisibleAccessibilityFailures(page, 'U1 compact empty panes');

    const bookmarks = page.locator('[data-activity-item="bookmarks"]');
    await bookmarks.focus();
    await expectFocusedControl(bookmarks);
    await expect(bookmarks).toBeInViewport();
    await bookmarks.press('Enter');
    await expect(page.locator('.workspace-sidebar')).toBeVisible();
    await expect(page.locator('.bookmark-tree-viewport')).not.toHaveAttribute('role', 'tree');
    await expect(page.locator('.bookmark-tree-empty')).toHaveAttribute('role', 'status');
    await assertNoVisibleAccessibilityFailures(page, 'U1 compact Shell');

    const settings = page.locator('[data-activity-item="setting"]');
    await settings.focus();
    await expectFocusedControl(settings);
    await expect(settings).toBeInViewport();
    await settings.press('Enter');
    await expect(page.getByRole('complementary', { name: '设置项目' })).toBeVisible();
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});

test('P-07 U2 keeps Settings, connection dialogs and transfer controls reachable at 200% zoom', async () => {
  test.setTimeout(120_000);
  const userData = await mkdtemp(resolve(tmpdir(), 'axterm-dialogs-u2-zoom-'));
  const app = await electron.launch({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.context().addInitScript({ path: axeScriptPath });
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(2);
    });
    await expect
      .poll(() => page.evaluate(() => [globalThis.innerWidth, globalThis.innerHeight]))
      .toEqual([640, 400]);

    const settings = page.locator('[data-activity-item="setting"]');
    await settings.focus();
    await settings.press('Enter');
    const categories = page.getByRole('complementary', { name: '设置项目' });
    await expect(categories).toBeVisible();
    const closeSettings = page.getByRole('button', { name: '关闭设置并返回工作区' });
    const closeTarget = await closeSettings.evaluate((element) => {
      const { width, height } = element.getBoundingClientRect();
      return { width, height };
    });
    expect(closeTarget.width).toBeGreaterThanOrEqual(24);
    expect(closeTarget.height).toBeGreaterThanOrEqual(24);
    const settingsTabs = page.locator('.settings-workspace-tabs');
    for (const tab of [
      settingsTabs.locator('button').first(),
      settingsTabs.locator('button').last(),
    ]) {
      await tab.focus();
      await expect(tab).toBeInViewport();
    }
    const tabLayout = await settingsTabs.evaluate((element) => ({
      overflowX: getComputedStyle(element).overflowX,
      buttonOverflow: Array.from(element.querySelectorAll('button')).some(
        (button) => button.scrollHeight > button.clientHeight + 1,
      ),
      right: element.getBoundingClientRect().right,
      closeLeft: document.querySelector('.settings-workspace-close.right')?.getBoundingClientRect()
        .left,
    }));
    expect(tabLayout.overflowX).toBe('auto');
    expect(tabLayout.buttonOverflow).toBe(false);
    expect(tabLayout.right).toBeLessThanOrEqual(tabLayout.closeLeft ?? 0);
    for (const category of ['common', 'terminal', 'legal'] as const) {
      const button = categories.locator(`[data-settings-category="${category}"]`);
      await button.focus();
      await expect(button).toBeFocused();
      await expect(button).toBeInViewport();
      await button.press('Enter');
      await expect(button).toHaveAttribute('aria-current', 'page');
      await assertNoVisibleAccessibilityFailures(page, `U2 Settings ${category}`);
    }

    const terminalCategory = categories.locator('[data-settings-category="terminal"]');
    await terminalCategory.focus();
    await terminalCategory.press('Enter');
    const terminalPanel = page.getByRole('region', { name: '终端配置' });
    await expect(terminalPanel).toBeVisible();
    await expect(page.getByRole('heading', { name: '终端设置', level: 1 })).toHaveCount(1);
    const connectionConfiguration = page.getByRole('button', {
      name: '终端配置',
      exact: true,
    });
    await connectionConfiguration.focus();
    await expect(connectionConfiguration).toBeInViewport();
    await connectionConfiguration.press('Enter');
    const connectionProfile = page.getByRole('region', { name: '连接配置' });
    const profileName = connectionProfile.getByLabel('连接配置名称');
    await expect(profileName).toBeFocused();
    await expect(profileName).toBeInViewport();
    await assertNoVisibleAccessibilityFailures(page, 'U2 connection configuration');

    await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    const hostSidebar = page.locator('.workspace-sidebar.section-hosts');
    if (!(await hostSidebar.isVisible()))
      await page.locator('[data-activity-item="bookmarks"]').click();
    await hostSidebar.getByRole('button', { name: '管理' }).click();
    const addHost = page.getByRole('button', { name: '添加主机' });
    await addHost.focus();
    await expect(addHost).toBeInViewport();
    await addHost.press('Enter');
    const dialog = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('名称')).toBeFocused();
    for (const control of [
      dialog.getByLabel('名称'),
      dialog.getByLabel('主机地址'),
      dialog.getByLabel('用户名'),
      dialog.getByRole('tab').last(),
    ]) {
      await control.focus();
      await expect(control).toBeFocused();
      await expect(control).toBeInViewport();
    }
    await assertNoVisibleAccessibilityFailures(page, 'U2 SSH dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(addHost).toBeFocused();

    const transferButton = page.locator('.status-transfer');
    await transferButton.focus();
    await expect(transferButton).toBeInViewport();
    await transferButton.press('Enter');
    const transferCenter = page.locator('.transfer-center');
    await expect(transferCenter).toBeVisible();
    const transferBounds = await transferCenter.evaluate((element) => {
      const { left, right, top, bottom } = element.getBoundingClientRect();
      return { left, right, top, bottom, width: innerWidth, height: innerHeight };
    });
    expect(transferBounds.left).toBeGreaterThanOrEqual(0);
    expect(transferBounds.right).toBeLessThanOrEqual(transferBounds.width);
    expect(transferBounds.top).toBeGreaterThanOrEqual(0);
    expect(transferBounds.bottom).toBeLessThanOrEqual(transferBounds.height);
    for (const control of await transferCenter.getByRole('button').all()) {
      await control.focus();
      await expect(control).toBeInViewport();
    }
    await assertNoVisibleAccessibilityFailures(page, 'U2 transfer center');
  } finally {
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true });
  }
});
