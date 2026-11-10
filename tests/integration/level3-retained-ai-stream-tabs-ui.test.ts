import type {} from '@axterm/plugin-api';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { expect as ui, type ElectronApplication } from '@playwright/test';
import { launchLevel3Desktop, closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';
import { openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { selectAiSkill } from '../e2e/ai-skill-picker.ts';
import { piSseStart, piSseText, piSseEnd } from '../fixtures/pi-sse.ts';
it('retains actual Pi streaming prefixes across terminal tabs and sidebar remount and preserves canceled partial text', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-ai-stream-tabs-'));
  const responses: ServerResponse[] = [],
    requests: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.once('end', () => {
      requests.push(body);
      responses.push(response);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(piSseStart('openai-chat') + piSseText('openai-chat', '第一段已经显示🙂'));
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
    page.setDefaultTimeout(7000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('[data-terminal-channel=ready]').waitFor();
    const originalTab = await page.locator('.terminal-tab.active').getAttribute('data-tab-id');
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    expect(originalTab).toBeTruthy();
    const toggle = page.locator('[data-ai-sidebar-toggle]');
    await toggle.click();
    await page
      .locator('.ai-embedded-toolbar')
      .getByRole('button', { name: 'Provider', exact: true })
      .click();
    const config = page.getByRole('dialog', { name: 'AI Config', exact: true });
    await config.locator('[name=name]').fill('Retained streaming');
    await config.locator('[name=baseUrl]').fill(`http://127.0.0.1:${address.port}/v1`);
    await config.locator('[name=model]').fill('fixture-model');
    await config.locator('[name=apiKey]').fill('ISOLATED_STREAM_KEY');
    await config.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await config.waitFor({ state: 'hidden' });
    const sidebar = page.locator('.ai-panel-embedded:visible');
    const prompt = sidebar.locator('textarea[name=prompt]');
    const message = sidebar.locator('.ai-chat-message.assistant');
    await prompt.fill('开始流式回复');
    await prompt.press('Enter');
    await ui(message).toContainText('第一段已经显示🙂');
    await ui(message).toHaveAttribute('aria-busy', 'true');
    expect(responses[0]!.writableEnded).toBe(false);
    responses[0]!.write(piSseText('openai-chat', '；第二段继续出现'));
    await ui(message).toContainText('第一段已经显示🙂；第二段继续出现');
    await page
      .locator('.tabbar')
      .getByRole('button', { name: 'New terminal', exact: true })
      .click();
    await ui(message).toHaveCount(0);
    responses[0]!.write(piSseText('openai-chat', '；切换标签时继续生成'));
    await page.locator('.terminal-tab[data-tab-id=' + JSON.stringify(originalTab) + ']').click();
    await ui(message).toContainText('第一段已经显示🙂；第二段继续出现；切换标签时继续生成');
    await toggle.click();
    await ui(sidebar).toHaveCount(0);
    await toggle.click();
    await ui(message).toContainText('第一段已经显示🙂；第二段继续出现；切换标签时继续生成');
    responses[0]!.end(piSseText('openai-chat', '；回复完成') + piSseEnd('openai-chat'));
    await ui(message).toHaveCount(1);
    await ui(message).toContainText(
      '第一段已经显示🙂；第二段继续出现；切换标签时继续生成；回复完成',
    );
    await ui(sidebar.locator('.ai-chat-message.pending')).toHaveCount(0);
    await prompt.fill('取消这个回复');
    await prompt.press('Enter');
    const pending = sidebar.locator('.ai-chat-message.pending');
    await ui(pending).toContainText('第一段已经显示🙂');
    await pending.getByRole('button', { name: 'Cancel', exact: true }).click();
    await ui(sidebar.locator('.ai-chat-message.pending')).toHaveCount(0);
    await ui(message).toHaveCount(2);
    await ui(message.last()).toContainText('第一段已经显示🙂');
    expect(responses).toHaveLength(2);
    const composer = sidebar.locator('.ai-chat-composer');
    await ui(composer.locator('select[name=mode]')).toHaveValue('chat');
    await ui(composer.locator('select[name=mode] option')).toHaveText(['Chat mode', 'Work mode']);
    await ui(composer.locator('[name=useCase]')).toHaveCount(0);
    await selectAiSkill(composer, 'explain-command');
    expect(requests).toHaveLength(2);
    await prompt.fill('ls -la');
    await prompt.press('Enter');
    const review = page.getByRole('dialog', { name: 'Review AI request', exact: true });
    await ui(review).toContainText('<skill name="explain-command">');
    expect(requests).toHaveLength(2);
    await review.getByRole('button', { name: 'Confirm and send', exact: true }).click();
    await ui.poll(() => responses.length).toBe(3);
    expect(requests[2]).toContain('<skill name=');
    expect(JSON.parse(requests[2]!).tools ?? []).toHaveLength(0);
    responses[2]!.end(piSseEnd('openai-chat'));
    await ui(message).toHaveCount(3);
    await ui(sidebar.locator('.ai-chat-message.pending')).toHaveCount(0);
    await composer.getByRole('button', { name: 'Remove skill', exact: true }).click();
    await prompt.fill('留在第一个标签的草稿');
    await page
      .locator('.tabbar')
      .getByRole('button', { name: 'New terminal', exact: true })
      .click();
    await ui(prompt).toHaveValue('');
    await ui(composer.locator('select[name=mode]')).toHaveValue('chat');
    await ui(message).toHaveCount(0);
    await page.locator('.terminal-tab[data-tab-id=' + JSON.stringify(originalTab) + ']').click();
    await ui(message).toHaveCount(3);
    await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .find((entry) => entry.getType() === 'window')
        ?.setZoomFactor(2),
    );
    await prompt.fill('放大后也可以输入');
    await ui(prompt).toHaveValue('放大后也可以输入');
    await prompt.fill('@');
    const options = page.getByRole('listbox').getByRole('option');
    await ui(options).toHaveCount(4);
    await ui(page.getByRole('listbox')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    expect(
      await options.evaluateAll((options) =>
        options.every((option) => {
          const box = option.getBoundingClientRect(),
            hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return !!hit && (hit === option || option.contains(hit));
        }),
      ),
    ).toBe(true);
    const axeSource = await readFile(
      createRequire(resolve('package.json')).resolve('axe-core/axe.min.js'),
      'utf8',
    );
    await page.evaluate((source) => {
      const script = document.createElement('script');
      script.nonce =
        document.querySelector<HTMLMetaElement>('meta[name="axterm-csp-nonce"]')?.content ?? '';
      script.textContent = source;
      document.head.append(script);
    }, axeSource);
    const violations = await sidebar.evaluate(async (element) => {
      const axe = (
        globalThis as typeof globalThis & {
          axe: {
            run(
              context: Element[],
              options: unknown,
            ): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
          };
        }
      ).axe;
      return (
        await axe.run([element, ...document.querySelectorAll('.ai-skill-picker')], {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] },
        })
      ).violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) }));
    });
    expect(violations).toEqual([]);
    await prompt.press('ArrowDown');
    await prompt.press('Enter');
    await ui(composer.locator('.ai-selected-skill')).toContainText('Explain command');
    await composer.getByRole('button', { name: 'Remove skill', exact: true }).click();
    await prompt.fill('@explain-output');
    await ui(options).toHaveCount(1);
    await prompt.press('Escape');
    await ui(page.getByRole('listbox')).toBeHidden();
    await ui(prompt).toHaveValue('@explain-output');
    await prompt.fill('prefix suffix');
    await prompt.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(7, 7));
    await composer.getByRole('button', { name: 'Skills', exact: true }).click();
    await prompt.press('Enter');
    await prompt.pressSequentially('XY');
    await ui(prompt).toHaveValue('prefix XYsuffix');
    await composer.getByRole('button', { name: 'Remove skill', exact: true }).click();
    await prompt.fill('contact user@example.com');
    await ui(page.getByRole('listbox')).toBeHidden();
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
    await ui(prompt).toHaveValue('contact user@example.com');
    expect(requests.join('')).not.toContain('ISOLATED_STREAM_KEY');
    expect(errors).toEqual([]);
    expect(await sidebar.innerText()).not.toContain('ISOLATED_STREAM_KEY');
  } finally {
    for (const response of responses) response.destroy();
    if (app) await closeLevel3Desktop(app);
    const closed = once(server, 'close');
    server.closeAllConnections();
    server.close();
    await closed;
    await rm(home, { recursive: true, force: true });
  }
}, 45000);
