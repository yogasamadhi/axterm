import { closeLevel3Tab } from '../support/level3-tab-actions.ts';
import { openLevel3AiWorkspace, openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { expect, it } from 'vitest';
import { piSseStart, piSseText, piSseEnd } from '../fixtures/pi-sse.ts';
const electronPath = createRequire(resolve('apps/desktop/package.json'))('electron') as string;
it('uses the retained AI page, actual generated models, native Vault, browser file import and explicit reviewed Pi execution', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-ai-product-ui-'));
  let host: ChildProcess | undefined,
    shell: ElectronApplication | undefined,
    stopped: Promise<unknown> | undefined;
  let requests = 0;
  let reply = 'AI UI visible reply AI_UI_PRIVATE_KEY_CANARY';
  const diagnostics: string[] = [];
  const server = createServer((request, response) => {
    requests++;
    if (request.headers.authorization !== 'Bearer AI_UI_PRIVATE_KEY_CANARY') {
      response.writeHead(401);
      response.end();
      return;
    }
    request.resume();
    request.once('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        piSseStart('openai-chat') + piSseText('openai-chat', reply) + piSseEnd('openai-chat'),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unbound AI UI fixture');
  try {
    const profileDirectory = join(home, 'profiles/web');
    await mkdir(profileDirectory, { recursive: true });
    if (process.platform !== 'win32')
      await writeFile(
        join(profileDirectory, 'cordis.patch.yml'),
        JSON.stringify([
          {
            id: 'terminals',
            config: {
              shell: '/bin/sh',
              shellArgs: ['-f'],
              cwd: home,
              env: { HISTFILE: '/dev/null', ENV: '' },
            },
          },
        ]),
      );
    const launcher = join(home, 'profile.mjs');
    await writeFile(
      launcher,
      `import {runProfile} from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-boot.js')).href)};
import {PROFILE_TEMPLATES} from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-templates.js')).href)};
const application=await runProfile({profile:'web',home:${JSON.stringify(home)},installAnchor:${JSON.stringify(resolve('apps/cli/package.json'))},templates:PROFILE_TEMPLATES,patchFiles:[],args:[],requiredServices:['aiController','webStartup','clientModules'],prepare(ctx){ctx.inject(['engines'],scope=>{scope.engines.register('external-ui',{label:'External UI fixture',capabilities:{cancellation:true,tools:false,resume:false},async openSession(){return {async run(input,execution){if(input.tools)throw new Error('Unexpected tool capability');await execution.emit({type:'delta',text:'Selected external UI response'});await execution.emit({type:'completed'});},async close(){}};}});});ctx.provide('webAssets',{index:${JSON.stringify(resolve('apps/web/dist/index.html'))},authenticationPage:${JSON.stringify(resolve('apps/web/dist/auth.html'))}});}});
process.send({...application.ctx.get('webStartup'),generation:application.ctx.runtimeIdentity.generation});`,
    );
    host = spawn(process.execPath, ['--expose-internals', launcher], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        ZDOTDIR: home,
        AXTERM_HOME: home,
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    host.stdout?.on('data', (chunk) => diagnostics.push(String(chunk)));
    host.stderr?.on('data', (chunk) => diagnostics.push(String(chunk)));
    stopped = new Promise((done) => host!.once('exit', done));
    const startup = await new Promise<{ url: string; tokenFile: string; generation: string }>(
      (done, reject) => {
        const timer = setTimeout(
          () => reject(new Error('AI product Profile startup timeout')),
          10000,
        );
        host!.once('message', (value) => {
          clearTimeout(timer);
          done(value as { url: string; tokenFile: string; generation: string });
        });
        host!.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        host!.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('AI product Profile exited before readiness: ' + diagnostics.join('')));
        });
      },
    );
    const token = (await readFile(startup.tokenFile, 'utf8')).trim();
    const browser = join(home, 'browser.cjs');
    await writeFile(
      browser,
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(home, 'browser'))});app.whenReady().then(()=>{const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.loadURL(process.env.AXTERM_AI_UI_URL);});app.on('window-all-closed',()=>app.quit());`,
    );
    shell = await electron.launch({
      executablePath: electronPath,
      args: [browser],
      env: {
        ...process.env,
        HOME: home,
        ZDOTDIR: home,
        AXTERM_HOME: home,
        AXTERM_AI_UI_URL: startup.url,
      },
    });
    const page = await shell.firstWindow({ timeout: 10000 });
    page.setDefaultTimeout(8000);
    const browserErrors: string[] = [];
    const imports: number[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/files/import') imports.push(response.status());
    });
    page.on('pageerror', (error) =>
      browserErrors.push(error.message.replaceAll(token, '[redacted]')),
    );
    await page.locator('#credential').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('[data-axterm-product-workspace]').waitFor();
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('en');
    await page.keyboard.press('Escape');
    await openLevel3AiWorkspace(page).catch(async (error) => {
      throw new Error(
        JSON.stringify({
          buttons: await page
            .locator('.tabbar button')
            .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
          errors: browserErrors,
        }),
        { cause: error },
      );
    });
    const config = page.getByRole('dialog', { name: 'AI Config', exact: true });
    await config.waitFor();
    await config.locator('[name=name]').fill('UI owned provider');
    await config.locator('[name=baseUrl]').fill(`http://127.0.0.1:${address.port}/v1`);
    await config.locator('[name=model]').fill('ui-fixture-model');
    await config.locator('[name=apiKey]').fill('AI_UI_PRIVATE_KEY_CANARY');
    await config.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await config.waitFor({ state: 'hidden' });
    const composer = page.locator('.ai-chat-composer:visible');
    await expect
      .poll(() => composer.locator('select[name=modelId]').locator('option').count())
      .toBe(1);
    const picker = page.waitForEvent('filechooser');
    await composer
      .locator('button')
      .filter({ has: page.locator('svg.lucide-paperclip') })
      .click();
    await (
      await picker
    ).setFiles({
      name: 'reviewed-context.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Visible file words\nAuthorization: Bearer AI_UI_PRIVATE_KEY_CANARY'),
    });
    await page
      .getByText('reviewed-context.txt', { exact: true })
      .first()
      .waitFor()
      .catch(async (error) => {
        throw new Error(
          JSON.stringify({
            imports,
            alerts: await page.locator('.error-banner').allTextContents(),
            errors: browserErrors,
          }),
          { cause: error },
        );
      });
    await expect
      .poll(async () => readdir(join(home, 'profiles/web/file-imports', startup.generation)))
      .toEqual([]);
    await composer.locator('textarea[name=prompt]').fill('Read the attached visible context');
    await composer
      .getByRole('button', { name: 'Send message', exact: true })
      .click()
      .catch(async (error) => {
        await writeFile(
          'out/level3-migration/sdk/paired-ai-ui-diagnostic.json',
          JSON.stringify(
            {
              errors: browserErrors,
              body: (await page.locator('body').innerText()).replaceAll(
                'AI_UI_PRIVATE_KEY_CANARY',
                '[redacted]',
              ),
              workspace: await page.locator('.ai-workspace-context').allTextContents(),
              prompt: await composer.locator('textarea[name=prompt]').inputValue(),
              modelOptions: await composer.locator('select[name=modelId] option').allTextContents(),
            },
            null,
            2,
          ),
        );
        throw error;
      });
    const review = page.getByRole('dialog', { name: 'Review AI request', exact: true });
    await review.waitFor();
    expect(requests).toBe(0);
    expect(await review.innerText()).not.toContain('AI_UI_PRIVATE_KEY_CANARY');
    await review.getByRole('button', { name: 'Confirm and send', exact: true }).click();
    await page
      .locator('.ai-chat-message.assistant:visible')
      .filter({ hasText: 'AI UI visible reply' })
      .waitFor();
    expect(requests).toBe(1);
    if (process.platform !== 'win32') {
      const marker = 'AXTERM_DRAFT_WAS_EXECUTED';
      const command =
        "printf '" +
        [...marker]
          .map((character) => '\\' + character.charCodeAt(0).toString(8).padStart(3, '0'))
          .join('') +
        "\\n'";
      reply = '```sh\n' + command + '\n```';
      const terminalsBeforeDraft = await page.locator('[data-terminal-id]').count();
      await page
        .locator('.tabbar')
        .getByRole('button', { name: 'New terminal', exact: true })
        .click();
      const terminal = page.locator('[data-terminal-channel="ready"]:visible');
      await terminal.waitFor();
      await terminal
        .locator('.terminal-session-toolbar')
        .getByRole('tab', { name: 'File manager', exact: true })
        .click();
      await terminal.locator('[data-files-workspace]').waitFor();
      await page.getByRole('tab', { name: 'AI Assistant', exact: true }).click();
      await page
        .locator('.ai-chat-composer:visible textarea[name=prompt]')
        .fill('@generate-command Prepare the harmless demonstration command');
      await page
        .locator('.ai-chat-composer:visible')
        .getByRole('button', { name: 'Send message', exact: true })
        .click();
      const commandReview = page.getByRole('dialog', { name: 'Review AI request', exact: true });
      await commandReview.waitFor();
      expect(requests).toBe(1);
      await commandReview.getByRole('button', { name: 'Confirm and send', exact: true }).click();
      const insertion = page.getByRole('button', { name: 'Insert into terminal', exact: true });
      await insertion.waitFor();
      expect(requests).toBe(2);
      await insertion.click();
      await terminal.waitFor();
      const screen = terminal.locator('.xterm-screen');
      await expect.poll(() => screen.innerText()).toContain('printf');
      expect(await screen.innerText()).not.toContain(marker);
      await terminal.locator('.xterm-helper-textarea').press('Enter');
      await expect.poll(() => screen.innerText()).toContain(marker);
      await closeLevel3Tab(page);
      await expect
        .poll(() => page.locator('[data-terminal-id]').count())
        .toBe(terminalsBeforeDraft);
    }
    await page.getByRole('tab', { name: 'AI Assistant', exact: true }).click();
    await page
      .locator('.panel-page:visible')
      .getByRole('button', { name: 'Provider', exact: true })
      .click();
    const externalConfig = page.getByRole('dialog', { name: 'AI Config', exact: true });
    await externalConfig.getByLabel('Engine', { exact: true }).selectOption('external-ui');
    expect(
      await externalConfig.locator('[name=baseUrl], [name=apiKey], [name=piModelsJson]').count(),
    ).toBe(0);
    await externalConfig.locator('[name=name]').fill('Selected external UI provider');
    await externalConfig.locator('[name=model]').fill('external-ui-model');
    await externalConfig.getByRole('button', { name: 'Save configuration', exact: true }).click();
    await externalConfig.waitFor({ state: 'hidden' });
    await page
      .locator('.ai-chat-options select[name=modelId]:visible')
      .selectOption({ label: 'external-ui-model' });
    await page
      .locator('.ai-chat-composer:visible textarea[name=prompt]')
      .fill('Use only the selected external Engine');
    const piRequests = requests;
    await page
      .locator('.ai-chat-composer:visible')
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await page
      .locator('.ai-chat-message.assistant:visible')
      .filter({ hasText: 'Selected external UI response' })
      .waitFor();
    expect(requests).toBe(piRequests);
    expect(await page.locator('body').innerText()).not.toContain('AI_UI_PRIVATE_KEY_CANARY');
    expect(await page.locator('body').innerText()).not.toContain(token);
    expect(
      await page.evaluate(() => ({
        cookie: document.cookie,
        local: { ...localStorage },
        session: { ...sessionStorage },
      })),
    ).toEqual({ cookie: '', local: {}, session: {} });
    const shots = resolve('out/level3-migration/ai-ui-layouts');
    await mkdir(shots, { recursive: true });
    for (const [locale, label, title] of [
      ['en', 'English', 'AI Assistant'],
      ['ja', '日本語', 'AI アシスタント'],
      ['zh-CN', '简体中文', 'AI 助手'],
      ['zh-TW', '繁體中文', 'AI 助理'],
    ]) {
      await openLevel3Settings(page);
      await page.getByTestId('application-language').click();
      await page.getByRole('option', { name: label!, exact: true }).click();
      await expect.poll(() => page.locator('html').getAttribute('lang')).toBe(locale);
      await page.locator('[data-section-close=left]').click();
      await page.locator('[data-configuration-settings]').waitFor({ state: 'hidden' });
      await page.getByRole('tab', { name: title!, exact: true }).waitFor();
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 1440, height: 900 },
        { width: 1920, height: 1080 },
      ]) {
        await page.setViewportSize(viewport);
        for (const zoom of [1, 2]) {
          await shell.evaluate(
            ({ BrowserWindow }, scale) =>
              BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(scale),
            zoom,
          );
          await expect
            .poll(() => page.evaluate(() => Math.round(innerWidth)))
            .toBe(Math.round(viewport.width / zoom));
          const send = page.locator('.ai-chat-composer:visible button[type=submit]');
          await send.scrollIntoViewIfNeeded();
          const buttonBounds = await send.boundingBox();
          const viewportBounds = await page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
          }));
          const promptBounds = await page
            .locator('.ai-chat-composer:visible textarea[name=prompt]')
            .boundingBox();
          expect(promptBounds!.width).toBeGreaterThanOrEqual(160);
          expect(buttonBounds).not.toBeNull();
          expect(buttonBounds!.y).toBeGreaterThanOrEqual(0);
          expect(buttonBounds!.y + buttonBounds!.height).toBeLessThanOrEqual(viewportBounds.height);
          expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(viewportBounds.width);

          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await page.screenshot({ path: join(shots, `${locale}-${viewport.width}-${zoom}x.png`) });
        }
        await shell.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1),
        );
      }
    }
    expect(browserErrors).toEqual([]);
    expect(diagnostics.join('')).not.toContain(token);
    expect(diagnostics.join('')).not.toContain('AI_UI_PRIVATE_KEY_CANARY');
    await shell.close();
    shell = undefined;
    host.kill('SIGTERM');
    expect(await stopped).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await shell?.close();
    if (host && host.exitCode === null) {
      host.kill('SIGKILL');
      await stopped;
    }
    await rm(home, { recursive: true, force: true });
  }
}, 45000);
