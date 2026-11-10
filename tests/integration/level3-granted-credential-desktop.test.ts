import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { expect, it } from 'vitest';
import { EncryptedVault } from '@axterm/infra-credential-vault';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
const packageResult = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
for (const mode of ['shell', 'package'] as const)
  it.skipIf(process.platform !== 'darwin' || (mode === 'package' && !packageResult))(
    `uses selected public actions and actual ${mode} file authority/Vault without exposing key bytes to the page`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'axterm-granted-key-desktop-'));
      let browser: ElectronApplication | undefined;
      const secret = 'PRIVATE_NATIVE_GRANTED_KEY_CANARY';
      try {
        const keyFile = join(home, 'selected-private-key.pem');
        await writeFile(keyFile, secret, { mode: 0o600 });
        const profile = join(home, 'profiles/desktop'),
          fixture = join(profile, 'node_modules/@fixture/granted-key');
        await mkdir(fixture, { recursive: true });
        await writeFile(
          join(profile, 'package.json'),
          JSON.stringify({
            name: 'granted-key-profile',
            private: true,
            dependencies: { '@fixture/granted-key': '1.0.0' },
            axterm: {
              profile: { bundles: [...PROFILE_TEMPLATES.desktop!.bundles, '@fixture/granted-key'] },
            },
          }),
        );
        await writeFile(
          join(fixture, 'package.json'),
          JSON.stringify({
            name: '@fixture/granted-key',
            version: '1.0.0',
            type: 'module',
            engines: { axterm: '^0.10.0' },
            exports: {
              '.': './index.js',
              './client': { browser: './client.browser.js', default: './client.browser.js' },
            },
            axterm: {
              bundle: { patch: './patch.yml' },
              client: { platform: 'web', immediately: true, external: ['@axterm/ui/controls'] },
            },
          }),
        );
        await writeFile(
          join(fixture, 'patch.yml'),
          '- insert:\n    - id: granted-key-probe\n      name: "@fixture/granted-key"\n',
        );
        await writeFile(join(fixture, 'index.js'), 'export function apply(){}');
        await writeFile(
          join(fixture, 'client.browser.js'),
          `window.__ModuleLoader__.load({id:'@fixture/granted-key',factory(require){const React=require('react');const{Button}=require('@axterm/ui/controls');return{inject:['slots','fileGrantActions','savedCredentialActions'],apply(ctx){const lifetime=new AbortController();let pending,accepting=true;ctx.effect(()=>async()=>{accepting=false;lifetime.abort();await pending;});ctx.slots.inject('workspace.toolbar',function*(){yield ctx.slots.register({name:'workspace.toolbar',id:'granted-key-probe',order:999},function Probe(){const[state,setState]=React.useState('idle');const[ref,setRef]=React.useState('');const mounted=React.useRef(true);React.useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);return React.createElement('div',{'data-key-probe':'','data-state':state,'data-ref':ref},React.createElement(Button,{onClick(){if(!accepting||pending)return;setState('reading');pending=(async()=>{let grant;try{grant=await ctx.fileGrantActions.create({kind:'open-file'},lifetime.signal);if(!grant)throw new Error('Canceled');const submission=ctx.savedCredentialActions.submitFromGrant({kind:'privateKey',label:'Native selected SSH key',grantId:grant.grantId},lifetime.signal);const receipt=await submission.result;if(receipt.status!=='completed')throw new Error('Unconfirmed');await ctx.fileGrantActions.revoke(grant.grantId);grant=undefined;if(mounted.current){setRef(receipt.ref);setState('completed');}}catch{if(mounted.current)setState('failed');}finally{if(grant)await ctx.fileGrantActions.revoke(grant.grantId);}})();}},'Import controlled key'));});});}};}});`,
        );
        let chooserModule = resolve('apps/desktop/lib/shell/file-chooser.js');
        let executablePath = createRequire(resolve('apps/desktop/package.json'))(
            'electron',
          ) as string,
          args = [resolve('apps/desktop/lib/shell/main.js')];
        if (mode === 'package') {
          const record = JSON.parse(await readFile(packageResult!, 'utf8')),
            root = dirname(dirname(dirname(record.app)));
          executablePath = join(
            root,
            'Contents/MacOS',
            (await readdir(join(root, 'Contents/MacOS')))[0]!,
          );
          chooserModule = join(record.app, 'lib/shell/file-chooser.js');
          args = [];
        }
        browser = await electron.launch({
          executablePath,
          args,
          cwd: home,
          env: {
            ...process.env,
            AXTERM_HOME: home,
            AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
            AXTERM_E2E_HIDDEN_WINDOW: '1',
            PATH: mode === 'package' ? '/usr/bin:/bin' : process.env.PATH!,
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            ALL_PROXY: '',
          },
          timeout: 20000,
        });
        // Selection is an isolated Main decision adapter; authority/read/Vault are real.
        await browser.evaluate(
          (_, { modulePath, path }) => {
            const module = process.getBuiltinModule('node:module');
            const { ElectronFileChooser } = module.createRequire(modulePath)(modulePath);
            ElectronFileChooser.prototype.choose = async function (
              kind: string,
              signal: AbortSignal,
            ) {
              signal.throwIfAborted();
              if (kind !== 'open-file') throw new Error('Unexpected native selection');
              return path;
            };
          },
          { modulePath: chooserModule, path: keyFile },
        );
        const page = await browser.firstWindow();
        page.setDefaultTimeout(15000);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page
          .locator('[data-key-probe]')
          .getByRole('button', { name: 'Import controlled key', exact: true })
          .click();
        await expect
          .poll(() => page.locator('[data-key-probe]').getAttribute('data-state'), {
            timeout: 15000,
          })
          .toBe('completed');
        const ref = (await page.locator('[data-key-probe]').getAttribute('data-ref'))!;
        expect(ref).toMatch(/^cred_/u);
        expect(await page.locator('body').innerText()).not.toContain(secret);
        expect(await page.content()).not.toContain(secret);
        expect(errors).toEqual([]);
        const closed = browser.waitForEvent('close', { timeout: 15000 });
        await browser.evaluate(({ app, dialog }) => {
          dialog.showMessageBox = ((options: Electron.MessageBoxOptions) => {
            if (
              options.message !== 'Active tasks may be interrupted.' ||
              options.buttons?.join(',') !== 'Cancel,Quit'
            )
              throw new Error('Unexpected exit dialog');
            return Promise.resolve({ response: 1, checkboxChecked: false });
          }) as typeof dialog.showMessageBox;
          app.quit();
        });
        await closed;
        browser = undefined;
        const vault = new EncryptedVault(join(home, 'vault-v2'));
        try {
          await vault.open();
          expect(await vault.get(ref)).toBe(secret);
          expect((await vault.list()).map((value) => value.ref)).toEqual([ref]);
        } finally {
          await vault.close();
        }
      } finally {
        if (browser) {
          browser.process().kill('SIGKILL');
          await browser.close().catch(() => {});
        }
        await rm(home, { recursive: true, force: true });
      }
    },
    60000,
  );
