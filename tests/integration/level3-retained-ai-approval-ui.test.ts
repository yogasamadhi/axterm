import type {} from '@axterm/plugin-api';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, access, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { expect as ui, type ElectronApplication } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';
import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { piSseCommand, piSseText, piSseEnd } from '../fixtures/pi-sse.ts';
for (const decision of ['approve_once', 'reject'] as const) {
  it(`retains actual automatic command review and keyboard-safe approval dialog for ${decision}`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'axterm-approval-ui-'));
    const windows = process.platform === 'win32';
    const alternateDirectory = join(home, 'changed workspace');
    await mkdir(alternateDirectory);
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
      await config.locator('[name=name]').fill('Automatic UI review');
      await config.locator('[name=baseUrl]').fill(`http://127.0.0.1:${address.port}/v1`);
      await config.locator('[name=model]').fill('fixture-model');
      await config.locator('[name=apiKey]').fill('UI_REVIEW_SECRET_CANARY');
      await config.getByRole('button', { name: 'Save configuration', exact: true }).click();
      await config.waitFor({ state: 'hidden' });
      await assistant.locator('select[name=mode]').selectOption('work');
      await assistant
        .locator('textarea[name=prompt]')
        .fill('Inspect directory and host, create approval-marker and then remove it and finish.');
      await assistant.getByRole('button', { name: 'Send message', exact: true }).click();
      await ui(assistant.locator('.agent-tool-card.state-succeeded')).toHaveCount(4);
      await ui(page.locator('.ai-command-approval')).toHaveCount(0);
      releaseDanger();
      const danger = assistant.locator('.agent-tool-card.state-waiting_approval');
      await ui(danger).toHaveCount(1);
      await ui(assistant.locator('.agent-tool-card.state-succeeded')).toHaveCount(4);
      await ui(page.getByRole('button', { name: 'Run once', exact: true })).toHaveCount(1);
      const displayed = JSON.parse(await danger.locator('pre').first().innerText());
      expect(displayed.workspace.commandDirectory).toBe(home);
      await access(join(home, 'approval-marker'));
      const dialog = page.getByRole('dialog', {
        name: 'Terminal operation requiring approval',
        exact: true,
      });
      await ui(dialog).toBeVisible();
      await ui(dialog.getByLabel('Enter a command for review')).toHaveText(commands[4]!);
      await ui(dialog).toContainText(home);
      await ui(dialog.getByRole('button', { name: 'Reject', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await ui(dialog).toBeHidden();
      if (decision === 'approve_once' && !windows) {
        const input = page.locator('[data-terminal-channel=ready]:visible .xterm-helper-textarea');
        await input.click();
        await input.pressSequentially(
          'cd ' + "'" + alternateDirectory.replaceAll("'", "'\"'\"'") + "'",
        );
        await input.press('Enter');
        await ui(assistant.locator('.ai-workspace-context code')).toHaveText(alternateDirectory);
      }
      await danger.locator('.agent-tool-card-header').click();
      await ui(dialog).toBeVisible();
      await ui(dialog.getByRole('button', { name: 'Reject', exact: true })).toBeFocused();
      await ui(dialog).toContainText(home);
      await ui(dialog.getByLabel('Enter a command for review')).toHaveText(commands[4]!);
      await page.keyboard.press('Tab');
      await ui(dialog.getByRole('button', { name: 'Run once', exact: true })).toBeFocused();
      await dialog
        .getByRole('button', {
          name: decision === 'approve_once' ? 'Run once' : 'Reject',
          exact: true,
        })
        .click();
      await ui(dialog).toBeHidden();
      await ui(page.locator('.ai-approval-reminder')).toHaveCount(0);
      if (decision === 'reject') {
        await ui(assistant.locator('.agent-tool-card.state-canceled'))
          .toHaveCount(1)
          .catch(async (error) => {
            const db = new DatabaseSync(join(home, 'data-v2/axterm.sqlite'), { readOnly: true });
            try {
              await writeFile(
                'out/level3-migration/sdk/ai-approval-reject-state.json',
                JSON.stringify(
                  {
                    calls: db
                      .prepare('SELECT state,approval_source FROM ai_tool_calls ORDER BY rowid')
                      .all(),
                    runs: db.prepare('SELECT state,error_code FROM ai_runs ORDER BY rowid').all(),
                    dom: await assistant
                      .locator('.agent-tool-card')
                      .evaluateAll((cards) => cards.map((card) => card.className)),
                    errors,
                  },
                  null,
                  2,
                ),
              );
            } finally {
              db.close();
            }
            throw error;
          });
        await access(join(home, 'approval-marker'));
        expect(turns).toBe(5);
      } else {
        await ui(assistant.locator('.ai-chat-message.assistant')).toContainText('连续任务已完成');
        await ui(assistant.locator('.agent-tool-card.state-succeeded')).toHaveCount(5);
        await ui(assistant.getByRole('button', { name: 'Run once', exact: true })).toHaveCount(0);
        await expect(access(join(home, 'approval-marker'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      expect(await readFile(join(alternateDirectory, 'approval-marker'), 'utf8')).toBe(
        'Keep alternate marker',
      );
      // Read-only acceptance witness; every write above belongs to the real application owners.
      const database = new DatabaseSync(join(home, 'data-v2/axterm.sqlite'), { readOnly: true });
      try {
        expect(
          database
            .prepare('SELECT approval_source FROM ai_tool_calls ORDER BY rowid')
            .all()
            .map((row) => row.approval_source ?? undefined),
        ).toEqual([
          'automatic',
          'automatic',
          'automatic',
          'automatic',
          decision === 'approve_once' ? 'user' : undefined,
        ]);
      } finally {
        database.close();
      }
      expect(bodies.join('')).not.toContain('UI_REVIEW_SECRET_CANARY');
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
