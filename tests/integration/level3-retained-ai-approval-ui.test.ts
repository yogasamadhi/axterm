import type {} from '@axterm/plugin-api';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, access, rm, writeFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { expect as ui, type ElectronApplication } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';
import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { piSseCommand, piSseText, piSseEnd } from '../fixtures/pi-sse.ts';
for (const decision of ['complete', 'cancel'] as const) {
  it(`runs full-access work without command approval and preserves workspace binding on ${decision}`, async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'axterm-approval-ui-')));
    const windows = process.platform === 'win32';
    const alternateDirectory = join(home, 'changed workspace');
    const otherDirectory = join(home, 'other terminal');
    await mkdir(alternateDirectory);
    await mkdir(otherDirectory);
    await writeFile(join(alternateDirectory, 'approval-marker'), 'Keep alternate marker');
    const commands = [
      'whoami',
      windows ? 'powershell -NoProfile -NonInteractive -Command "Get-Location"' : 'hostname',
      windows ? 'dir' : 'pwd',
      windows
        ? "powershell -NoProfile -NonInteractive -Command \"Set-Content -LiteralPath 'approval-marker' -Value 'approved' -Encoding UTF8\""
        : 'echo approved>approval-marker',
      windows ? 'del approval-marker' : 'rm approval-marker',
    ];
    const bodies: string[] = [];
    let turns = 0,
      releaseDanger!: () => void;
    const dangerGate = new Promise<void>((done) => {
      releaseDanger = done;
    });
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.once('end', () => {
        bodies.push(body);
        const reviewing = String(JSON.parse(body).messages[0]?.content).startsWith(
          'You review one command',
        );
        const command = commands[turns];
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = () =>
          response.end(
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
    if (!address || typeof address === 'string') throw Error('Missing model listener');
    let app: ElectronApplication | undefined;
    try {
      app = await launchLevel3Desktop({
        executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
        args: [resolve('apps/desktop'), `--user-data-dir=${home}`],
        env: { ...process.env },
        timeout: 12000,
      });
      const page = await app.firstWindow();
      page.setDefaultTimeout(8000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.locator('[data-terminal-channel=ready]').waitFor();
      const originalTab = (await page.locator('.terminal-tab.active').getAttribute('data-tab-id'))!;
      await openLevel3Settings(page);
      await page.getByTestId('application-language').click();
      await page.getByRole('option', { name: 'English', exact: true }).click();
      await page.getByRole('button', { name: 'Close settings', exact: true }).click();
      await page.locator('[data-ai-sidebar-toggle]').click();
      const assistant = page.locator('.ai-panel-embedded:visible');
      await assistant
        .locator('.ai-embedded-toolbar')
        .getByRole('button', { name: 'Provider', exact: true })
        .click();
      const config = page.getByRole('dialog', { name: 'AI Config', exact: true });
      await config.locator('[name=name]').fill('Full access UI work');
      await config.locator('[name=baseUrl]').fill(`http://127.0.0.1:${address.port}/v1`);
      await config.locator('[name=model]').fill('fixture-model');
      await config.locator('[name=apiKey]').fill('UI_REVIEW_SECRET_CANARY');
      await config.getByRole('button', { name: 'Save configuration', exact: true }).click();
      await config.waitFor({ state: 'hidden' });
      const targetChoice = assistant.locator('select[name=aiTerminal]');
      await ui(targetChoice).toHaveValue('');
      await page
        .locator('.tabbar')
        .getByRole('button', { name: 'New terminal', exact: true })
        .click();
      await ui
        .poll(async () => {
          const id = await page.locator('.terminal-tab.active').getAttribute('data-tab-id');
          return !!id && id !== originalTab;
        })
        .toBe(true);
      const otherTab = (await page.locator('.terminal-tab.active').getAttribute('data-tab-id'))!;
      expect(otherTab).not.toBe(originalTab);
      if (!windows) {
        const otherInput = page.locator(
          '[data-terminal-channel=ready]:visible .xterm-helper-textarea',
        );
        await otherInput.click();
        await otherInput.pressSequentially(
          'cd ' + "'" + otherDirectory.replaceAll("'", "'\"'\"'") + "'",
        );
        await otherInput.press('Enter');
        await ui(assistant.locator('.ai-workspace-context code')).toHaveText(otherDirectory);
      }
      await targetChoice.selectOption(originalTab);
      await ui(assistant.locator('.ai-workspace-context code')).toHaveText(home);
      await ui(page.locator('.terminal-tab.active')).toHaveAttribute('data-tab-id', otherTab);
      await page.locator('.terminal-tab[data-tab-id=' + JSON.stringify(originalTab) + ']').click();
      await assistant.locator('select[name=mode]').selectOption('work');
      await assistant
        .locator('textarea[name=prompt]')
        .fill('Inspect directory and host, create approval-marker and then remove it and finish.');
      await assistant.getByRole('button', { name: 'Send message', exact: true }).click();
      await ui(assistant.locator('.agent-tool-card.state-succeeded')).toHaveCount(4);
      await ui(
        assistant.locator('.ai-chat-messages .ai-tool-timeline .agent-tool-card'),
      ).toHaveCount(4);
      await ui(assistant.locator('.agent-tool-list')).toHaveCount(0);
      await ui(assistant.locator('.ai-chat-message.user button')).toHaveCount(0);
      await ui(assistant.getByText('Agent tool activity', { exact: true })).toHaveCount(0);
      await ui(assistant.locator('.agent-tool-card').first()).toContainText('whoami');
      expect(
        await assistant.locator('.agent-tool-card .ai-tool-output').first().innerText(),
      ).not.toBe('');
      await ui(page.locator('.ai-command-approval')).toHaveCount(0);
      await access(join(home, 'approval-marker'));
      if (decision === 'complete' && !windows) {
        const input = page.locator('[data-terminal-channel=ready]:visible .xterm-helper-textarea');
        await input.click();
        await input.pressSequentially(
          'cd ' + "'" + alternateDirectory.replaceAll("'", "'\"'\"'") + "'",
        );
        await input.press('Enter');
        await ui(assistant.locator('.ai-workspace-context code')).toHaveText(alternateDirectory);
        await page.locator('.terminal-tab[data-tab-id=' + JSON.stringify(otherTab) + ']').click();
        await ui(targetChoice).toHaveValue(originalTab);
        await ui(assistant.locator('.ai-workspace-context code')).toHaveText(alternateDirectory);
      }
      if (decision === 'cancel') {
        await assistant.getByRole('button', { name: 'Cancel', exact: true }).click();
        await ui(assistant.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
      }
      releaseDanger();
      await ui(page.locator('.ai-command-approval, .ai-approval-reminder')).toHaveCount(0);
      await ui(page.getByRole('button', { name: 'Run once', exact: true })).toHaveCount(0);
      if (decision === 'cancel') {
        await access(join(home, 'approval-marker'));
        await ui(assistant.locator('.agent-tool-card.state-succeeded')).toHaveCount(4);
      } else {
        await ui(assistant.locator('.ai-chat-message.assistant')).toContainText('连续任务已完成');
        await ui(assistant.locator('.agent-tool-card.state-succeeded')).toHaveCount(5);
        if (!windows) {
          expect((await readFile(join(home, 'approval-marker'), 'utf8')).trim()).toBe('approved');
          await expect(access(join(alternateDirectory, 'approval-marker'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        } else
          await expect(access(join(home, 'approval-marker'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        // A later chat turn must retain the preceding work's commands exactly once.
        await assistant.locator('select[name=mode]').selectOption('chat');
        await assistant.locator('textarea[name=prompt]').fill('Summarize the completed task.');
        await assistant.getByRole('button', { name: 'Send message', exact: true }).click();
        await ui(assistant.locator('.ai-chat-message.assistant')).toHaveCount(2);
        await ui(assistant.locator('.ai-chat-messages .agent-tool-card')).toHaveCount(5);
        await ui
          .poll(() =>
            assistant
              .locator('.ai-chat-messages')
              .evaluate(
                (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
              ),
          )
          .toBeLessThan(48);
        const ids = await assistant
          .locator('.agent-tool-card')
          .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-tool-id')));
        expect(new Set(ids).size).toBe(5);
        expect(JSON.parse(bodies.at(-1)!).tools ?? []).toEqual([]);
        await page.screenshot({ path: 'out/pi-reuse/inline-tools-conversation.png' });
      }
      if (decision !== 'complete' || windows)
        expect(await readFile(join(alternateDirectory, 'approval-marker'), 'utf8')).toBe(
          'Keep alternate marker',
        );
      await targetChoice.selectOption('');
      if (!windows)
        await ui(assistant.locator('.ai-workspace-context code')).toHaveText(
          decision === 'complete' ? otherDirectory : home,
        );
      // Read-only acceptance witness; every write above belongs to the real application owners.
      const database = new DatabaseSync(join(home, 'data-v2/axterm.sqlite'), { readOnly: true });
      try {
        expect(
          database
            .prepare('SELECT approval_source FROM ai_tool_calls ORDER BY rowid')
            .all()
            .map((row) => row.approval_source ?? undefined),
        ).toEqual(Array.from({ length: decision === 'complete' ? 5 : 4 }, () => undefined));
        expect(database.prepare('SELECT * FROM ai_approvals').all()).toEqual([]);
        const run = database.prepare('SELECT state FROM ai_runs ORDER BY rowid DESC LIMIT 1').get();
        expect(run?.state).toBe(decision === 'complete' ? 'succeeded' : 'canceled');
      } finally {
        database.close();
      }
      expect(bodies.join('')).not.toContain('UI_REVIEW_SECRET_CANARY');
      expect(
        bodies.some((body) =>
          String(JSON.parse(body).messages[0]?.content).startsWith('You review one command'),
        ),
      ).toBe(false);
      expect(await assistant.innerText()).not.toContain('UI_REVIEW_SECRET_CANARY');
      expect(errors).toEqual([]);
      expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(
        Boolean(process.env.AXTERM_LOCAL_OPTIMIZATION_APP),
      );
    } finally {
      releaseDanger();
      if (app) await closeLevel3Desktop(app);
      const closed = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await closed;
      await rm(home, { recursive: true, force: true });
    }
  }, 30000);
}
