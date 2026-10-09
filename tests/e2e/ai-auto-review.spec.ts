import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron, test, expect } from '@playwright/test';
import { terminalProfileInputSchema } from '../../packages/contracts/src';
import { ProductDatabase } from '../../packages/runtime/src/adapters/sqlite/database';
import {
  ProductRepository,
  etagFor,
} from '../../packages/runtime/src/adapters/sqlite/product-repository';
import { piSseCommand, piSseEnd, piSseText } from '../fixtures/pi-sse';

for (const decision of ['approve_once', 'reject'] as const) {
  test(`safe commands run continuously and approval dialog handles ${decision}`, async ({
    browserName: _browserName,
  }, info) => {
    const packaged = info.project.name === 'packaged';
    const candidate = process.env.AXTERM_AUTO_REVIEW_APP;
    test.skip(packaged && !candidate, 'An explicit isolated package is required');
    const root = await mkdtemp(join(tmpdir(), 'axterm-auto-review-ui-'));
    const userData = join(root, 'user-data');
    const databasePath = join(userData, 'data-v2', 'axterm.sqlite');
    const seed = await ProductDatabase.open(databasePath);
    try {
      const repository = new ProductRepository(seed);
      const profile = repository.createJson(
        'terminal_profiles',
        terminalProfileInputSchema.parse({
          name: 'isolated review fixture',
          cwd: root,
          shell: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
          loginShell: false,
        }),
        'terminal-profile',
      );
      repository.updateSettings(
        { terminal: { defaultProfileId: profile.id } },
        etagFor(repository.getSettings().version),
      );
    } finally {
      seed.close();
    }
    const commands = [
      'whoami',
      process.platform === 'win32'
        ? 'powershell -NoProfile -NonInteractive -Command "Get-Location"'
        : 'hostname',
      process.platform === 'win32' ? 'dir' : 'pwd',
      process.platform === 'win32'
        ? "powershell -NoProfile -NonInteractive -Command \"Set-Content -LiteralPath 'approval-marker' -Value 'approved' -Encoding UTF8\""
        : 'echo approved>approval-marker',
      process.platform === 'win32' ? 'del approval-marker' : 'rm approval-marker',
    ];
    const bodies: string[] = [];
    let turns = 0;
    let releaseDanger!: () => void;
    const dangerGate = new Promise<void>((resolve) => {
      releaseDanger = resolve;
    });
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        bodies.push(body);
        const reviewing = String(JSON.parse(body).messages[0]?.content).startsWith(
          'You review one command',
        );
        const command = commands[turns];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = () =>
          res.end(
            reviewing
              ? piSseText(
                  'openai-chat',
                  JSON.stringify({
                    outcome: 'allow',
                    risk_level: 'medium',
                    user_authorization: 'high',
                    rationale: 'The user requested this isolated marker file.',
                  }),
                ) + piSseEnd('openai-chat')
              : command
                ? piSseCommand(command).replaceAll('call_workspace', `call_ui_${++turns}`)
                : piSseText('openai-chat', '连续任务已完成') + piSseEnd('openai-chat'),
          );
        if (!reviewing && command === commands[4]) void dangerGate.then(send);
        else send();
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No listener');
    const executablePath = packaged
      ? join(candidate!, process.platform === 'win32' ? 'Axterm.exe' : 'axterm')
      : (createRequire(resolve('apps/desktop/package.json'))('electron') as string);
    const app = await electron.launch({
      executablePath,
      args: [...(packaged ? [] : [resolve('apps/desktop')]), `--user-data-dir=${userData}`],
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        AXTERM_E2E_HIDDEN_WINDOW: '1',
        ...(packaged && process.platform === 'win32'
          ? {
              PATH: [
                join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:/Windows', 'System32'),
                join(
                  process.env.SystemRoot ?? process.env.WINDIR ?? 'C:/Windows',
                  'System32/WindowsPowerShell/v1.0',
                ),
              ].join(';'),
            }
          : {}),
      },
    });
    try {
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await expect(page.getByTestId('runtime-state')).toHaveAttribute('data-state', 'ready');
      await expect(page.locator('.terminal-host').first()).toHaveAttribute(
        'data-connection-state',
        'connected',
      );
      await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
      const assistant = page.locator('.ai-inspector');
      await assistant.locator('.ai-embedded-toolbar button').click();
      const form = page.locator('.ai-provider-form');
      await form.locator('[name="piModelsJson"]').fill(
        JSON.stringify({
          providers: {
            fixture: {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: 'openai-completions',
              apiKey: 'UI_REVIEW_SECRET_CANARY',
              models: [{ id: 'fixture-model' }],
            },
          },
        }),
      );
      await form.getByRole('button', { name: '保存配置' }).click();
      await expect(page.locator('.ai-provider-modal')).toBeHidden();
      await assistant.locator('[name="mode"]').selectOption('work');
      await assistant
        .locator('textarea[name="prompt"]')
        .fill('查看目录和主机，写入 approval-marker 后删除它，完成任务。');
      await assistant.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(assistant.locator('.agent-tool-card.state-succeeded')).toHaveCount(4);
      await expect(page.locator('.ai-command-approval')).toHaveCount(0);
      releaseDanger();
      const danger = assistant.locator('.agent-tool-card.state-waiting_approval');
      await expect(danger).toHaveCount(1);
      await expect(assistant.locator('.agent-tool-card.state-succeeded')).toHaveCount(4);
      await expect(assistant.getByRole('button', { name: '仅运行一次', exact: true })).toHaveCount(
        1,
      );
      const displayedArgs = JSON.parse(await danger.locator('pre').first().innerText());
      expect(displayedArgs.workspace.commandDirectory).toBe(root);
      await access(join(root, 'approval-marker'));
      const dialog = page.getByRole('dialog', { name: '需要审批的终端操作' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('输入待审核命令')).toHaveText(commands[4]!);
      await expect(dialog).toContainText(root);
      await page.screenshot({ path: `out/ai-approval-${info.project.name}-${decision}.png` });
      await expect(dialog.getByRole('button', { name: '拒绝', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await danger.locator('.agent-tool-card-header').click();
      await expect(danger.locator('.agent-tool-card-header')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await page.locator('.ai-approval-reminder').click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: '拒绝', exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: '仅运行一次' })).toBeFocused();
      await dialog
        .getByRole('button', {
          name: decision === 'approve_once' ? '仅运行一次' : '拒绝',
          exact: true,
        })
        .click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('.ai-approval-reminder')).toHaveCount(0);
      if (decision === 'reject') {
        await expect(assistant.locator('.agent-tool-card.state-canceled')).toHaveCount(1);
        await access(join(root, 'approval-marker'));
        expect(turns).toBe(5);
      } else {
        await expect(assistant.locator('.ai-chat-message.assistant')).toContainText(
          '连续任务已完成',
        );
        await expect(assistant.locator('.agent-tool-card.state-succeeded')).toHaveCount(5);
        await expect(
          assistant.getByRole('button', { name: '仅运行一次', exact: true }),
        ).toHaveCount(0);
        await expect(access(join(root, 'approval-marker'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      const db = await ProductDatabase.open(databasePath);
      try {
        const repository = new ProductRepository(db);
        const rows = db.all<{ run_id: string }>('SELECT run_id FROM ai_tool_calls LIMIT 1');
        expect(
          repository.listToolCalls(rows[0]!.run_id).map((call) => call.approvalSource),
        ).toEqual([
          'automatic',
          'automatic',
          'automatic',
          'automatic',
          decision === 'approve_once' ? 'user' : undefined,
        ]);
      } finally {
        db.close();
      }
      expect(bodies.join('')).not.toContain('UI_REVIEW_SECRET_CANARY');
      expect(await assistant.innerText()).not.toContain('UI_REVIEW_SECRET_CANARY');
      expect(errors).toEqual([]);
      expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(packaged);
    } finally {
      releaseDanger();
      await app.close();
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  });
}
