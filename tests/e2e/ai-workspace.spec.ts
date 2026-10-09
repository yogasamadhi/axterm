import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchLocalOptimizationApp } from '../fixtures/local-optimization-launch';
import { piSseCommand, piSseEnd, piSseText } from '../fixtures/pi-sse';
import { selectAiSkill } from './ai-skill-picker';
import { ProductDatabase } from '../../packages/runtime/src/adapters/sqlite/database';
import {
  ProductRepository,
  etagFor,
} from '../../packages/runtime/src/adapters/sqlite/product-repository';
import type { ServerResponse } from 'node:http';

const executablePath = createRequire(resolve('apps/desktop/package.json'))('electron') as string;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test('default startup opens one connected local terminal and recreates a stale local tab after cold launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-local-startup-'));
  const userData = join(root, 'user-data');
  const launch = () =>
    launchLocalOptimizationApp({
      executablePath,
      args: [resolve('apps/desktop'), `--user-data-dir=${userData}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: '', HOME: root },
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect(page.locator('.terminal-tab')).toHaveCount(1);
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-connection-state', 'connected');
    const oldId = await page.locator('.terminal-tab').getAttribute('data-terminal-id');
    await page.locator('[data-activity-item="setting"]').click();
    await expect(page.locator('.settings-workspace')).toBeVisible();
    // Wait for the normal debounced layout write, then configure restoration through the repository while stopped.
    await expect
      .poll(async () => {
        const database = await ProductDatabase.open(join(userData, 'data-v2', 'axterm.sqlite'));
        try {
          return new ProductRepository(database).getSettings().workspace.layout?.section;
        } finally {
          database.close();
        }
      })
      .toBe('settings');
    await app.close();
    const database = await ProductDatabase.open(join(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const products = new ProductRepository(database);
      products.updateSettings(
        { workspace: { restoreLayout: true } },
        etagFor(products.getSettings().version),
      );
    } finally {
      database.close();
    }
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator('.terminal-tab')).toHaveCount(1);
    await expect(page.locator('.terminal-tab.disconnected')).toHaveCount(0);
    await expect(page.locator('.terminal-tab.active')).not.toHaveAttribute(
      'data-terminal-id',
      oldId!,
    );
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-connection-state', 'connected');
    await expect(page.locator('.settings-workspace')).toBeHidden();
    const liveId = await page.locator('.terminal-tab').getAttribute('data-terminal-id');
    await expect
      .poll(async () => {
        const db = await ProductDatabase.open(join(userData, 'data-v2', 'axterm.sqlite'));
        try {
          return new ProductRepository(db).getSettings().workspace.layout?.activeTerminalId;
        } finally {
          db.close();
        }
      })
      .toBe(liveId);
    const live = await ProductDatabase.open(join(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const products = new ProductRepository(live);
      const current = products.getSettings();
      products.updateSettings(
        {
          workspace: {
            layout: { ...current.workspace.layout!, section: 'hosts', contentSurface: 'section' },
          },
        },
        etagFor(current.version),
      );
    } finally {
      live.close();
    }
    await page.reload();
    await expect(page.locator('.terminal-tab')).toHaveCount(1);
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-connection-state', 'connected');
    await expect(page.locator('.terminal-tab.active')).toHaveAttribute('data-terminal-id', liveId!);
    await expect(page.locator('.section-tab')).toHaveCount(0);
    await app.close();
    const stale = await ProductDatabase.open(join(userData, 'data-v2', 'axterm.sqlite'));
    try {
      const products = new ProductRepository(stale);
      const current = products.getSettings();
      const layout = current.workspace.layout!;
      const local = layout.tabs[0]!;
      products.updateSettings(
        {
          workspace: {
            restoreLayout: true,
            layout: {
              ...layout,
              section: 'hosts',
              contentSurface: 'section',
              split: true,
              layoutMode: 'c2',
              tabs: [
                local,
                {
                  ...local,
                  id: '11111111-1111-4111-8111-111111111111',
                  title: '旧 SSH',
                  kind: 'ssh',
                  paneIndex: 1,
                },
              ],
              paneTerminalIds: [local.id, '11111111-1111-4111-8111-111111111111'],
              secondaryTerminalId: '11111111-1111-4111-8111-111111111111',
            },
          },
        },
        etagFor(current.version),
      );
    } finally {
      stale.close();
    }
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator('.terminal-tab')).toHaveCount(1);
    await expect(page.locator('.terminal-pane')).toHaveCount(1);
    await expect(page.locator('.section-tab')).toHaveCount(0);
    await expect(page.locator('.terminal-tab.disconnected')).toHaveCount(0);
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-connection-state', 'connected');
  } finally {
    await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('activity functions and bookmark dialogs stay in the sidebar while Settings uses the main surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-sidebar-only-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'user-data')}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', HOME: root },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.locator('.terminal-tab')).toHaveCount(1);
    const localId = await page.locator('.terminal-tab').getAttribute('data-terminal-id');
    const assertTerminal = async () => {
      await expect(page.locator('.terminal-tab')).toHaveCount(1);
      await expect(page.locator('.terminal-tab.active')).toHaveAttribute(
        'data-terminal-id',
        localId!,
      );
      await expect(page.locator('.section-tab')).toHaveCount(0);
      await expect(
        page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
      ).toHaveAttribute('data-connection-state', 'connected');
    };
    await page.locator('[data-activity-item="ai"]').click();
    await expect(page.locator('.ai-inspector')).toBeVisible();
    await expect(page.locator('.ai-open-workspace')).toHaveCount(0);
    await assertTerminal();
    await page.locator('[data-activity-item="bookmarks"]').click();
    await expect(page.locator('.ai-inspector')).toHaveCount(0);
    await page
      .locator('.workspace-sidebar')
      .getByRole('button', { name: '管理', exact: true })
      .click();
    await expect(page.locator('.workspace-sidebar .host-manager-toolbar')).toBeVisible();
    await expect(page.locator('.workspace-main .panel-heading:visible')).toHaveCount(0);
    await assertTerminal();
    await page.getByRole('button', { name: '添加 RDP', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '添加 RDP 书签' })).toBeVisible();
    await assertTerminal();
    await page.keyboard.press('Escape');
    await page.locator('[data-activity-item="newBookmark"]').click();
    const editor = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await expect(editor).toBeVisible();
    await assertTerminal();
    await editor.locator('[name="name"]').fill('侧栏书签');
    await editor.locator('[name="hostname"]').fill('sidebar.example.test');
    await editor.locator('[name="username"]').fill('root');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(page.locator('.workspace-sidebar .host-card')).toContainText('侧栏书签');
    await assertTerminal();
    await page.screenshot({ path: test.info().outputPath('host-sidebar-terminal.png') });
    await page.locator('.bookmark-manager-back').click();
    await expect(page.locator('.bookmark-tree-panel')).toContainText('侧栏书签');
    await page.locator('[data-activity-item="setting"]').click();
    await expect(page.locator('.settings-workspace')).toBeVisible();
    await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    await assertTerminal();
    await page.locator('.tab-close-active').first().click();
    await expect(page.locator('.terminal-tab')).toHaveCount(0);
    await page.locator('[data-activity-item="ai"]').click();
    await expect(page.locator('.ai-inspector')).toBeVisible();
    await expect(page.locator('.section-tab')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('adding SSH opens only its dialog, keeps the current sidebar, and supports repeated saves and failure feedback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-dialog-only-'));
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'user-data')}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.terminal-host')).toHaveAttribute(
      'data-connection-state',
      'connected',
    );
    const localId = await page.locator('.terminal-tab.active').getAttribute('data-terminal-id');
    const sidebar = page.locator('.workspace-sidebar');
    const create = page.locator('[data-activity-item="newBookmark"]');
    const editor = page.getByRole('dialog', { name: '添加 SSH 主机' });
    await expect(sidebar).toBeHidden();
    await create.click();
    await expect(editor).toBeVisible();
    await expect(sidebar).toBeHidden();
    await page.screenshot({ path: test.info().outputPath('ssh-dialog-only.png') });
    await editor.locator('[name="name"]').fill('仅弹窗保存');
    await editor.locator('[name="hostname"]').fill('dialog.example.test');
    await editor.locator('[name="username"]').fill('operator');
    await editor.getByRole('button', { name: '保存并新建', exact: true }).click();
    await expect(editor.locator('[name="name"]')).toHaveValue('');
    await expect(editor).toBeVisible();
    await expect(sidebar).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(editor).toBeHidden();
    await expect(sidebar).toBeHidden();

    await page.locator('[data-activity-item="ai"]').click();
    await create.click();
    await expect(editor).toBeVisible();
    await expect(page.locator('.ai-inspector')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.ai-inspector')).toBeVisible();
    await page.locator('[data-activity-item="bookmarks"]').click();
    await expect(page.locator('.bookmark-tree-panel')).toContainText('仅弹窗保存');
    await create.click();
    await expect(editor).toBeVisible();
    await expect(page.locator('.bookmark-tree-panel')).toBeVisible();
    await expect(sidebar.locator('.host-manager-toolbar')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.locator('[data-activity-item="setting"]').click();
    await create.click();
    await expect(editor).toBeVisible();
    await expect(page.locator('.settings-workspace')).toBeVisible();
    await expect(sidebar).toHaveClass(/section-settings/);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '关闭设置并返回工作区' }).click();
    if (await sidebar.isVisible()) await sidebar.locator('.explorer-header button').click();

    await page.route('**/api/v1/ssh-bookmarks', async (route) => {
      if (route.request().method() === 'POST')
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Fixture failure',
            status: 503,
            detail: 'DIALOG_SAVE_FAILURE_CANARY',
          }),
        });
      else await route.continue();
    });
    await create.click();
    await editor.locator('[name="name"]').fill('失败草稿');
    await editor.locator('[name="hostname"]').fill('dialog.example.test');
    await editor.locator('[name="username"]').fill('operator');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect(editor.getByRole('alert')).toHaveText('无法完成 SSH 主机操作，请检查连接后重试。');
    await expect(editor.locator('[name="name"]')).toHaveValue('失败草稿');
    await expect(sidebar).toBeHidden();
    await expect(page.getByText('DIALOG_SAVE_FAILURE_CANARY')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.unroute('**/api/v1/ssh-bookmarks');

    await page.route('**/api/v1/connections', async (route) => {
      if (route.request().method() === 'POST')
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'Fixture failure',
            status: 503,
            detail: 'DIALOG_FAILURE_CANARY',
          }),
        });
      else await route.continue();
    });
    await create.click();
    await editor.locator('[name="name"]').fill('仅弹窗失败反馈');
    await editor.locator('[name="hostname"]').fill('dialog.example.test');
    await editor.locator('[name="username"]').fill('operator');
    await editor.getByRole('button', { name: '保存并连接', exact: true }).click();
    const failure = page.getByRole('dialog', { name: '主机与连接' });
    await expect(failure.getByRole('alert')).toHaveText(
      '无法完成 SSH 主机操作，请检查连接后重试。',
    );
    await expect(sidebar).toBeHidden();
    await expect(page.getByText('DIALOG_FAILURE_CANARY')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.terminal-tab.active')).toHaveAttribute(
      'data-terminal-id',
      localId!,
    );
    await expect(page.locator('.section-tab')).toHaveCount(0);
  } finally {
    await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('AI displays streamed Pi text before completion, restores its prefix across tabs, and preserves canceled text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-ai-stream-ui-'));
  const responses: ServerResponse[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      responses.push(response);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(piSseText('openai-chat', '第一段已经显示🙂'));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing stream listener');
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'user-data')}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', HOME: root },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.locator('.terminal-tab')).toHaveCount(1);
    await expect(
      page.locator('.terminal-session-layer:not([hidden]) .terminal-host'),
    ).toHaveAttribute('data-connection-state', 'connected');
    const originalTab = await page.locator('.terminal-tab.active').getAttribute('data-terminal-id');
    const assistantToggle = page.getByRole('button', { name: 'AI 助手', exact: true });
    await assistantToggle.click();
    const assistant = page.locator('.ai-inspector');
    await assistant.locator('.ai-embedded-toolbar button').click();
    const form = page.locator('.ai-provider-form');
    await form.locator('[name="piModelsJson"]').fill(
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: 'openai-completions',
            apiKey: 'ISOLATED_STREAM_KEY',
            models: [{ id: 'fixture-model' }],
          },
        },
      }),
    );
    await form.getByRole('button', { name: '保存配置' }).click();
    await expect(page.locator('.ai-provider-modal')).toBeHidden();
    const prompt = assistant.locator('textarea[name="prompt"]');
    await prompt.fill('开始流式回复');
    await expect(assistant.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await prompt.press('Enter');
    const message = assistant.locator('.ai-chat-message.assistant');
    await expect(message).toContainText('第一段已经显示🙂');
    await expect(message).toHaveAttribute('aria-busy', 'true');
    expect(responses[0]!.writableEnded).toBe(false);
    responses[0]!.write(piSseText('openai-chat', '；第二段继续出现'));
    await expect(message).toContainText('第一段已经显示🙂；第二段继续出现');
    await page.getByRole('button', { name: '在窗格 1 新建本地终端', exact: true }).click();
    await expect(assistant.locator('.ai-chat-message')).toHaveCount(0);
    responses[0]!.write(piSseText('openai-chat', '；切换标签时继续生成'));
    await page.locator(`.terminal-tab[data-terminal-id="${originalTab}"]`).click();
    await expect(message).toContainText('第一段已经显示🙂；第二段继续出现；切换标签时继续生成');
    await assistantToggle.click();
    await expect(assistant).toBeHidden();
    await assistantToggle.click();
    await expect(message).toContainText('第一段已经显示🙂；第二段继续出现；切换标签时继续生成');
    await page.screenshot({ path: test.info().outputPath('ai-streaming.png') });
    responses[0]!.end(piSseText('openai-chat', '；回复完成') + piSseEnd('openai-chat'));
    await expect(message).toHaveCount(1);
    await expect(message).toContainText(
      '第一段已经显示🙂；第二段继续出现；切换标签时继续生成；回复完成',
    );
    await expect(assistant.locator('.ai-chat-message.pending')).toHaveCount(0);
    await prompt.fill('取消这个回复');
    await prompt.press('Enter');
    const pending = assistant.locator('.ai-chat-message.pending');
    await expect(pending).toContainText('第一段已经显示🙂');
    await pending.getByRole('button', { name: '取消', exact: true }).click();
    await expect(assistant.locator('.ai-chat-message.pending')).toHaveCount(0);
    await expect(message).toHaveCount(2);
    await expect(message.last()).toContainText('第一段已经显示🙂');
    expect(responses).toHaveLength(2);
    expect(errors).toEqual([]);
    expect(await assistant.innerText()).not.toContain('ISOLATED_STREAM_KEY');
  } finally {
    await app.close().catch(() => undefined);
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('AI opens in chat, follows selected local tabs and executes only an approved directory snapshot', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'axterm-ai-workspace-ui-')));
  const first = join(root, 'first workspace');
  const second = join(root, 'second workspace');
  await mkdir(first);
  await mkdir(second);
  const requests: string[] = [];
  let propose = false;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      requests.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        propose
          ? piSseCommand('pwd; printf approved > approval-marker')
          : piSseText('openai-chat', '可以直接聊天') + piSseEnd('openai-chat'),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing model listener');
  const app = await launchLocalOptimizationApp({
    executablePath,
    args: [resolve('apps/desktop'), `--user-data-dir=${join(root, 'user-data')}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', HOME: root },
  });
  try {
    await app.context().addInitScript({
      path: createRequire(resolve('apps/desktop/package.json')).resolve('axe-core/axe.min.js'),
    });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
    const layer = page.locator('.terminal-session-layer:not([hidden])');
    const input = layer.locator('.xterm-helper-textarea');
    const terminal = layer.locator('.terminal-host');
    await expect(terminal).toHaveAttribute('data-connection-state', 'connected');
    const firstTab = await page.locator('.terminal-tab.active').getAttribute('data-terminal-id');
    const changeDirectory = async (path: string) => {
      await input.pressSequentially(`cd ${quote(path)}; printf '\\033]7;file://%s\\007' "$PWD"`);
      await input.press('Enter');
    };
    await changeDirectory(first);
    await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
    const assistant = page.locator('.ai-inspector');
    await expect(assistant.locator('.ai-chat-composer')).toBeVisible();
    await expect(assistant.locator('[name="mode"]')).toHaveValue('chat');
    await expect(assistant.locator('[name="mode"] option')).toHaveText(['聊天模式', '工作模式']);
    await expect(assistant.locator('[name="useCase"]')).toHaveCount(0);
    expect(
      await assistant.locator('.ai-chat-options label:has(select) > span').evaluateAll((labels) =>
        labels.map((label) => {
          const range = document.createRange();
          range.selectNodeContents(label);
          return range.getClientRects().length;
        }),
      ),
    ).toEqual([1, 1]);
    await expect(assistant.locator('.ai-workspace-context code')).toHaveText(first);
    await expect(page.locator('.ai-provider-modal')).toBeHidden();
    await assistant.locator('.ai-embedded-toolbar button').click();
    const form = page.locator('.ai-provider-form');
    await form.locator('[name="piModelsJson"]').fill(
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: 'openai-completions',
            apiKey: 'AI_UI_KEY_CANARY',
            models: [{ id: 'fixture-model' }],
          },
        },
      }),
    );
    await form.getByRole('button', { name: '保存配置' }).click();
    await expect(page.locator('.ai-provider-modal')).toBeHidden();
    const prompt = assistant.locator('textarea[name="prompt"]');
    await prompt.fill('你好 AI_UI_KEY_CANARY');
    await assistant.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.locator('.ai-context-review')).toBeHidden();
    await expect(assistant.locator('.ai-chat-message.assistant')).toContainText('可以直接聊天');
    expect(requests[0]).toContain(first);
    expect(requests.join('')).not.toContain('AI_UI_KEY_CANARY');
    expect(await assistant.innerText()).not.toContain('AI_UI_KEY_CANARY');
    const composer = assistant.locator('.ai-chat-composer');
    await selectAiSkill(composer, 'explain-command');
    expect(requests).toHaveLength(1);
    await prompt.fill('ls -la');
    await prompt.press('Enter');
    const review = page.getByRole('dialog', { name: '检查 AI 请求' });
    await expect(review).toContainText('<skill name="explain-command">');
    await review.getByRole('button', { name: '确认并发送' }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toContain('<skill name=');
    expect(JSON.parse(requests[1]!).tools ?? []).toHaveLength(0);
    await expect(assistant.locator('.ai-chat-message.assistant')).toHaveCount(2);
    await composer.getByRole('button', { name: '移除技能' }).click();
    await assistant.locator('[name="mode"]').selectOption('work');
    propose = true;
    await prompt.fill('查看当前目录');
    await prompt.press('Enter');
    const approval = assistant.locator('.agent-tool-card.state-waiting_approval');
    await expect(approval).toContainText(first);
    await expect(readFile(join(first, 'approval-marker'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await changeDirectory(second);
    await expect(assistant.locator('.ai-workspace-context code')).toHaveText(second);
    await approval.getByRole('button', { name: '仅运行一次' }).click();
    await expect
      .poll(() => readFile(join(first, 'approval-marker'), 'utf8').catch(() => ''))
      .toBe('approved');
    await expect(readFile(join(second, 'approval-marker'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(assistant.locator('.agent-tool-card.state-succeeded')).toBeVisible();
    await assistant.locator('.agent-tool-card.state-succeeded .agent-tool-card-header').click();
    await prompt.fill('@');
    await expect(page.getByRole('listbox')).toBeVisible();
    await expect(page.getByRole('listbox')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const violations = await assistant.evaluate(async (element) => {
      const axe = (
        globalThis as typeof globalThis & {
          axe: {
            run(
              context: Element[],
              options: unknown,
            ): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }>;
          };
        }
      ).axe;
      return (
        await axe.run([element, ...Array.from(document.querySelectorAll('.ai-skill-picker'))], {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] },
        })
      ).violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) }));
    });
    expect(violations).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('ai-modes-skills.png') });
    await prompt.press('Escape');
    await expect(terminal).toHaveAttribute('data-connection-state', 'connected');
    await prompt.fill('留在第一个标签的草稿');
    await page.getByRole('button', { name: '在窗格 1 新建本地终端', exact: true }).click();
    await expect(page.locator('.terminal-tab')).toHaveCount(2);
    await changeDirectory(first);
    await expect(assistant.locator('.ai-workspace-context code')).toHaveText(first);
    await expect(prompt).toHaveValue('');
    await expect(assistant.locator('[name="mode"]')).toHaveValue('chat');
    await expect(assistant.locator('.ai-chat-message')).toHaveCount(0);
    await page.locator(`.terminal-tab[data-terminal-id="${firstTab}"]`).click();
    await expect(assistant.locator('.ai-workspace-context code')).toHaveText(second);
    await expect(assistant.locator('.ai-chat-message.assistant').first()).toContainText(
      '可以直接聊天',
    );
    await app.evaluate(({ webContents }) => {
      webContents
        .getAllWebContents()
        .find((entry) => entry.getType() === 'window')
        ?.setZoomFactor(2);
    });
    await expect(prompt).toBeVisible();
    await prompt.fill('放大后也可以输入');
    await expect(prompt).toHaveValue('放大后也可以输入');
    await prompt.fill('@');
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(4);
    expect(
      await page
        .getByRole('listbox')
        .getByRole('option')
        .evaluateAll((options) =>
          options.every((option) => {
            const box = option.getBoundingClientRect();
            const hit = document.elementFromPoint(
              box.left + box.width / 2,
              box.top + box.height / 2,
            );
            return !!hit && (hit === option || option.contains(hit));
          }),
        ),
    ).toBe(true);
    await prompt.press('ArrowDown');
    await prompt.press('Enter');
    await expect(composer.locator('.ai-selected-skill')).toContainText('解释命令');
    await composer.getByRole('button', { name: '移除技能' }).click();
    await prompt.fill('@解释输出');
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(1);
    await prompt.press('Escape');
    await expect(page.getByRole('listbox')).toBeHidden();
    await expect(prompt).toHaveValue('@解释输出');
    await prompt.fill('prefix suffix');
    await prompt.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(7, 7));
    await composer.getByRole('button', { name: '技能', exact: true }).click();
    await prompt.press('Enter');
    await prompt.pressSequentially('XY');
    await expect(prompt).toHaveValue('prefix XYsuffix');
    await composer.getByRole('button', { name: '移除技能' }).click();
    await prompt.fill('contact user@example.com');
    await expect(page.getByRole('listbox')).toBeHidden();
    const countBeforeComposition = requests.length;
    await prompt.dispatchEvent('compositionstart');
    await prompt.dispatchEvent('keydown', {
      key: 'Enter',
      keyCode: 229,
      isComposing: true,
      bubbles: true,
    });
    await prompt.dispatchEvent('compositionend');
    expect(requests).toHaveLength(countBeforeComposition);
    await expect(prompt).toHaveValue('contact user@example.com');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});
