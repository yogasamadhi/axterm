import { openLevel3AiWorkspace, openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { expect, it } from 'vitest';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
import { piSseStart, piSseText, piSseEnd } from '../fixtures/pi-sse.ts';
const packageResult = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
for (const mode of ['shell', 'package'] as const) {
  it.skipIf(process.platform !== 'darwin' || (mode === 'package' && !packageResult))(
    `runs the retained AI UI with owned Desktop authorization, Vault and reviewed Pi output in the ${mode}`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'axterm-ai-desktop-ui-'));
      let application: ElectronApplication | undefined;
      let requests = 0;
      const server = createServer((request, response) => {
        requests++;
        request.resume();
        request.once('end', () => {
          if (request.headers.authorization !== 'Bearer PRIVATE_DESKTOP_AI_CANARY') {
            response.writeHead(401);
            response.end();
            return;
          }
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(
            piSseStart('openai-chat') +
              piSseText('openai-chat', 'DESKTOP_AI_UI_REPLY PRIVATE_DESKTOP_AI_CANARY') +
              piSseEnd('openai-chat'),
          );
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('AI Desktop fixture is not bound');
      try {
        const profile = join(home, 'profiles/desktop');
        await mkdir(profile, { recursive: true });
        await writeFile(
          join(profile, 'package.json'),
          JSON.stringify({
            name: 'isolated-ai-ui',
            private: true,
            axterm: {
              profile: {
                bundles: [...PROFILE_TEMPLATES.desktop!.bundles],
              },
            },
          }),
        );
        const attachment = join(home, 'desktop-context.txt');
        await writeFile(attachment, 'Visible Desktop context PRIVATE_DESKTOP_AI_CANARY');
        let executablePath: string;
        let args: string[];
        if (mode === 'package') {
          const record = JSON.parse(await readFile(packageResult!, 'utf8'));
          const appRoot = dirname(dirname(dirname(record.app)));
          const [binary] = await readdir(join(appRoot, 'Contents/MacOS'));
          executablePath = join(appRoot, 'Contents/MacOS', binary!);
          args = [];
        } else {
          executablePath = createRequire(resolve('apps/desktop/package.json'))(
            'electron',
          ) as string;
          const entry = join(home, 'desktop.mjs');
          await writeFile(
            entry,
            `import {app,protocol} from 'electron';
import {DesktopShell} from ${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};
protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});
app.whenReady().then(()=>{globalThis.selectionCount=0;globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env},visible:false,fileChooser:()=>({async choose(kind,signal){signal.throwIfAborted();if(kind!=='open-file')throw new Error('Unexpected selection');globalThis.selectionCount++;return ${JSON.stringify(attachment)};},defaultDirectory(){return ${JSON.stringify(home)};},retire(){}})});globalThis.shell.start();});`,
          );
          args = [entry];
        }
        application = await electron.launch({
          executablePath,
          args,
          cwd: home,
          timeout: 15000,
          env: {
            ...process.env,
            AXTERM_HOME: home,
            AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
            PATH: mode === 'package' ? '/usr/bin:/bin' : process.env.PATH!,
            NODE_OPTIONS: '',
            NODE_PATH: '',
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            ALL_PROXY: '',
          },
        });
        const page = await application.firstWindow({ timeout: 15000 });
        page.setDefaultTimeout(8000);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.locator('[data-axterm-product-workspace]').waitFor();
        expect(page.url()).toBe('axterm-app://app/');
        expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(mode === 'package');
        await openLevel3Settings(page);
        await page.getByTestId('application-language').click();
        await page.getByRole('option', { name: 'English', exact: true }).click();
        await expect.poll(() => page.locator('html').getAttribute('lang')).toBe('en');
        await page.locator('[data-section-close=left]').click();
        await openLevel3AiWorkspace(page);
        const config = page.getByRole('dialog', { name: 'AI Config', exact: true });
        await config.locator('[name=name]').fill('Desktop AI fixture');
        await config.locator('[name=baseUrl]').fill(`http://127.0.0.1:${address.port}/v1`);
        await config.locator('[name=model]').fill('desktop-ui-model');
        await config.locator('[name=apiKey]').fill('PRIVATE_DESKTOP_AI_CANARY');
        await config.getByRole('button', { name: 'Save configuration', exact: true }).click();
        await config.waitFor({ state: 'hidden' });
        const composer = page.locator('.ai-chat-composer:visible');
        if (mode === 'shell') {
          await composer.getByRole('button', { name: 'Attach text file', exact: true }).click();
          await expect
            .poll(() =>
              application!.evaluate(
                () => (globalThis as typeof globalThis & { selectionCount: number }).selectionCount,
              ),
            )
            .toBe(1);
        } else {
          // Real DOM File -> Files HTTP streaming -> native managed grant. No dialog result is fabricated.
          const transfer = await page.evaluateHandle(() => {
            const value = new DataTransfer();
            value.items.add(
              new File(
                ['Visible Desktop context PRIVATE_DESKTOP_AI_CANARY'],
                'desktop-context.txt',
                { type: 'text/plain' },
              ),
            );
            return value;
          });
          await composer.dispatchEvent('drop', { dataTransfer: transfer });
          await transfer.dispose();
        }
        await composer.getByText('desktop-context.txt', { exact: true }).waitFor();
        await composer.locator('textarea[name=prompt]').fill('Read the selected Desktop context');
        await composer.getByRole('button', { name: 'Send message', exact: true }).click();
        const review = page.getByRole('dialog', { name: 'Review AI request', exact: true });
        await review.waitFor();
        expect(requests).toBe(0);
        expect(await review.innerText()).not.toContain('PRIVATE_DESKTOP_AI_CANARY');
        await review.getByRole('button', { name: 'Confirm and send', exact: true }).click();
        await page
          .locator('.ai-chat-message.assistant:visible')
          .filter({ hasText: 'DESKTOP_AI_UI_REPLY' })
          .waitFor();
        expect(requests).toBe(1);
        expect(await page.locator('body').innerText()).not.toContain('PRIVATE_DESKTOP_AI_CANARY');
        expect(
          await page.evaluate(() => ({
            cookie: document.cookie,
            local: { ...localStorage },
            session: { ...sessionStorage },
          })),
        ).toEqual({ cookie: '', local: {}, session: {} });
        expect(errors).toEqual([]);
        const closed = application.waitForEvent('close');
        if (mode === 'shell')
          await application.evaluate(async ({ app }) => {
            await (
              globalThis as typeof globalThis & { shell: { stop(): Promise<void> } }
            ).shell.stop();
            app.quit();
          });
        else await application.evaluate(({ app }) => app.quit());
        await closed;
        application = undefined;
        expect(await readFile(join(home, 'vault-v2/master.key'))).toHaveLength(32);
        expect(await readFile(attachment, 'utf8')).toBe(
          'Visible Desktop context PRIVATE_DESKTOP_AI_CANARY',
        );
        expect(await readdir(join(home, 'desktop/crashes')).catch(() => [])).toEqual([]);
      } finally {
        if (application) {
          const process = application.process();
          process.kill('SIGKILL');
          await application.close().catch(() => {});
        }
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        await rm(home, { recursive: true, force: true });
      }
    },
    45000,
  );
}
