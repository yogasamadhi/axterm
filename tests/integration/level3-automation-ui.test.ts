import { openLevel3Section } from '../support/level3-workspace-actions.ts';
import { openLevel3Bookmark, openLevel3Settings } from '../support/level3-workspace-actions.ts';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type * as Ssh2 from 'ssh2';
import {
  _electron as electron,
  type ElectronApplication,
  expect as browserExpect,
} from '@playwright/test';
import { expect, it } from 'vitest';
import type { DesktopShell } from '../../apps/desktop/src/shell/application.ts';
it('uses retained automation editors, sends a captured Quick Command through real SSH, receives typed trigger notifications and admits a native batch file once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-automation-ui-')),
    ssh = createRequire(resolve('packages/plugins/connections/package.json'))(
      'ssh2',
    ) as typeof Ssh2,
    peers = new Set<Ssh2.Connection>(),
    input: string[] = [],
    execs: string[] = [],
    errors: string[] = [];
  const server = new ssh.Server(
    { hostKeys: [ssh.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private] },
    (peer) => {
      peers.add(peer);
      peer.on('error', () => {});
      peer.once('close', () => peers.delete(peer));
      peer.on('authentication', (auth) => {
        if (
          auth.method === 'password' &&
          auth.username === 'operator' &&
          auth.password === 'AUTOMATION_FIXTURE_SECRET'
        )
          auth.accept();
        else auth.reject(['password']);
      });
      peer.on('ready', () =>
        peer.on('session', (accept) => {
          const session = accept();
          session.on('pty', (approve) => approve?.());
          session.on('shell', (approve) => {
            const channel = approve();
            channel.on('error', () => {});
            channel.on('data', (data: Buffer) => {
              input.push(data.toString());
              if (
                Buffer.concat(input.map((value) => Buffer.from(value))).includes(
                  Buffer.from('QUICK_UI\r'),
                )
              )
                channel.write('QUICK_UI_ACK\r\n');
            });
          });
          session.on('exec', (approve, _reject, info) => {
            const probe = info.command.includes('${SHELL:-}');
            if (!probe) execs.push(info.command);
            const channel = approve();
            channel.on('error', () => {});
            channel.exit(0);
            channel.end(probe ? '/bin/sh' : 'BATCH_UI_DONE\n');
          });
        }),
      );
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  let application: ElectronApplication | undefined;
  try {
    await mkdir(join(home, 'desktop'));
    const entry = join(home, 'shell.mjs');
    await writeFile(
      entry,
      `import{app,protocol}from'electron';import{DesktopShell}from${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/application.js')).href)};protocol.registerSchemesAsPrivileged([{scheme:'axterm-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',${JSON.stringify(join(home, 'desktop'))});app.whenReady().then(()=>{globalThis.shell=new DesktopShell({home:${JSON.stringify(home)},webRoot:${JSON.stringify(resolve('apps/web/dist'))},hostEntry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},preload:${JSON.stringify(resolve('apps/desktop/lib/shell/preload.cjs'))},environment:{...process.env},visible:false,confirmQuit:async()=>true,recover:async()=> 'quit'});globalThis.shell.start();});`,
    );
    application = await electron.launch({
      executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
      args: [entry],
      env: {
        ...process.env,
        HOME: home,
        ZDOTDIR: home,
        AXTERM_HOME: home,
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
      },
      timeout: 10000,
    });
    const page = await application.firstWindow();
    page.setDefaultTimeout(7000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.locator('[data-axterm-product-workspace]').waitFor();
    await openLevel3Settings(page);
    await page.getByTestId('application-language').click();
    await page.getByRole('option', { name: 'English', exact: true }).click();
    await page.locator('[data-section-close=left]').click();
    await openLevel3Bookmark(page);
    const editor = page.getByRole('dialog');
    await editor.locator('input[name="name"]').fill('Automation SSH');
    await editor.locator('input[name="hostname"]').fill('127.0.0.1');
    await editor.locator('input[name="username"]').fill('operator');
    await editor.locator('input[name="password"]').fill('AUTOMATION_FIXTURE_SECRET');
    await editor.locator('input[name="port"]').fill(String(port));
    await editor.locator('button[value="save-and-connect"]').click();
    const trust = page.locator('[data-interaction-kind=unknownHostKey]');
    await trust.locator('input[name="remember"]').check();
    await trust.getByRole('button', { name: 'Trust and connect', exact: true }).click();
    await page.locator('[data-terminal-channel=ready]').waitFor();
    await editor.locator('form.host-protocol-form').waitFor({ state: 'hidden' });
    const bookmarkId = await page
      .locator('[data-bookmark-title="Automation SSH"]')
      .getAttribute('data-bookmark-id');
    expect(bookmarkId).toMatch(/^[a-f0-9-]{36}$/);
    await openLevel3Section(page, 'commands');
    const root = page.locator('.automation-root');
    await root.getByRole('button', { name: 'Triggers Beta', exact: true }).click();
    await root.getByRole('button', { name: 'JSON', exact: true }).click();
    await root.getByRole('textbox', { name: 'Trigger JSON', exact: true }).fill(
      JSON.stringify([
        {
          name: 'Automation notice',
          enabled: true,
          match: { type: 'text', value: 'QUICK_UI_ACK', caseSensitive: true },
          action: { type: 'notify', value: '' },
          sendEnter: false,
          mode: 'once',
          cooldownMs: 0,
        },
      ]),
    );
    await root.getByRole('button', { name: 'Apply JSON', exact: true }).click();
    await root.getByText('Automation notice', { exact: true }).first().waitFor();
    await root.getByRole('button', { name: 'Quick commands', exact: true }).click();
    await root
      .locator('.quick-command-toolbar')
      .getByRole('button', { name: 'New quick command', exact: true })
      .click();
    const form = root.locator('.quick-command-form');
    await form.getByLabel('Name', { exact: true }).fill('Wire quick command');
    await form.getByRole('textbox', { name: 'Step 1 command', exact: true }).fill('QUICK_UI');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await root.getByRole('treeitem', { name: /Wire quick command/ }).waitFor();
    await page.locator('[data-section-close=left]').click();
    await page
      .locator('[data-workspace-global-tabs]')
      .getByRole('tab', { name: 'Automation SSH', exact: true })
      .click();
    const popover = page.locator('.quick-command-popover-root');
    await popover.getByRole('button', { name: 'Quick commands', exact: true }).click();
    const command = popover.locator('article').filter({ hasText: 'Wire quick command' });
    await command.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => input.join('')).toContain('QUICK_UI\r');
    await page
      .getByRole('alert')
      .filter({ hasText: 'Trigger notification: Automation notice' })
      .waitFor();
    await popover.getByRole('button', { name: 'Quick commands', exact: true }).click();
    const file = join(home, 'batch.json');
    await writeFile(
      file,
      JSON.stringify({
        name: 'Native batch UI',
        bookmarkIds: [bookmarkId],
        steps: [{ id: crypto.randomUUID(), name: 'Inspect', command: 'printf BATCH_UI' }],
        concurrency: 1,
        connectionTimeoutMs: 1000,
      }),
    );
    await application.evaluate(
      ({ app }, { file, home }) => {
        app.emit('second-instance', {} as Electron.Event, ['-tp', 'local', '-bo', file], home);
      },
      { file, home },
    );
    await expect.poll(() => execs).toEqual(['printf BATCH_UI']);
    await root.getByText('Native batch UI', { exact: true }).first().waitFor();
    await browserExpect(
      root
        .locator('.batch-operation-history')
        .getByRole('button')
        .filter({ hasText: 'Native batch UI' }),
    ).toContainText('Succeeded');
    expect(
      await page
        .locator('[data-workspace-global-tabs]')
        .getByRole('tab', { includeHidden: true })
        .count(),
    ).toBe(1);
    expect(errors).toEqual([]);
  } catch (error) {
    await writeFile(
      'out/level3-migration/sdk/automation-ui-diagnostic.json',
      JSON.stringify(
        {
          errors,
          input,
          execs,
          body: await application
            ?.windows()[0]
            ?.locator('body')
            .innerText()
            .catch(() => '<unavailable>'),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    if (application) {
      await application
        .evaluate(async () => {
          await (globalThis as unknown as { shell: DesktopShell }).shell.stop();
        })
        .catch(() => {});
      await application.close().catch(() => {});
    }
    for (const peer of peers) peer.end();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
}, 20000);
