import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { Generation2Database as ProductDatabase } from '../fixtures/migration/generation2-database.ts';
import { Generation2Vault as CredentialVault } from '../fixtures/migration/generation2-vault.ts';
import { closeLevel3Desktop } from '../fixtures/level3-desktop-launch.ts';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'axterm-copy-desktop-')),
    source = join(root, 'current'),
    home = join(root, 'new'),
    bootstrap = join(root, 'bootstrap');
  await mkdir(join(source, 'data-v2'), { recursive: true });
  await mkdir(bootstrap);
  const database = await ProductDatabase.open(join(source, 'data-v2/axterm.sqlite'));
  database.close();
  const vault = new CredentialVault(join(source, 'vault-v2'));
  await vault.open();
  const ref = await vault.put({
    kind: 'password',
    label: 'Fixture',
    secret: 'EMBEDDED_COPY_SECRET',
  });
  vault.close();
  return { root, source, home, bootstrap, ref: ref.ref };
}
async function launch(root: string, script: string): Promise<ElectronApplication> {
  const entry = join(root, 'launch.cjs');
  await writeFile(entry, script);
  return electron.launch({
    executablePath: createRequire(resolve('apps/desktop/package.json'))('electron') as string,
    args: [entry],
    env: { ...process.env, HOME: root, AXTERM_HOME: root },
    timeout: 10_000,
  });
}
function coordinator(f: Awaited<ReturnType<typeof fixture>>, response = 0, stopOnError = false) {
  return `const{app,dialog}=require('electron');app.setPath('userData',${JSON.stringify(f.bootstrap)});globalThis.prompts=[];globalThis.details=[];app.getPreferredSystemLanguages=()=>['en'];dialog.showMessageBox=async input=>{globalThis.prompts.push({type:input.type,buttons:input.buttons.length});globalThis.details.push(input.detail||'');return{response:${stopOnError ? "input.type==='error'?1:0" : response}};};globalThis.copyResult=(async()=>{const{prepareShellHome}=await import(${JSON.stringify(pathToFileURL(resolve('apps/desktop/lib/shell/data-copy.js')).href)});return prepareShellHome({home:${JSON.stringify(f.home)},source:${JSON.stringify(f.source)},bootstrap:${JSON.stringify(f.bootstrap)},entry:${JSON.stringify(resolve('apps/desktop-host/lib/index.js'))},environment:{...process.env,PATH:'/nonexistent',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:''}});})();`;
}
it('holds the legacy singleton and copies through the actual embedded RunAsNode worker without system Node/pnpm', async () => {
  const f = await fixture();
  let app: ElectronApplication | undefined;
  const original = createHash('sha256')
    .update(await readFile(join(f.source, 'data-v2/axterm.sqlite')))
    .digest('hex');
  try {
    app = await launch(f.root, coordinator(f));
    const copied = await app.evaluate(
      async () => await (globalThis as unknown as { copyResult: Promise<boolean> }).copyResult,
    );
    expect(copied).toBe(true);
    expect(
      createHash('sha256')
        .update(await readFile(join(f.source, 'data-v2/axterm.sqlite')))
        .digest('hex'),
    ).toBe(original);
    expect(await readFile(join(f.home, 'vault-v2/master.key'))).toEqual(
      await readFile(join(f.source, 'vault-v2/master.key')),
    );
    expect(await readFile(join(f.home, 'vault-v2', f.ref + '.bin'))).toEqual(
      await readFile(join(f.source, 'vault-v2', f.ref + '.bin')),
    );
    const database = new DatabaseSync(join(f.home, 'data-v2/axterm.sqlite'), { readOnly: true });
    try {
      expect(
        database.prepare("SELECT value FROM app_meta WHERE key='migration:55'").get(),
      ).toBeDefined();
    } finally {
      database.close();
    }
    expect(JSON.parse(await readFile(join(f.home, 'level3-data-copy.json'), 'utf8')).state).toBe(
      'committed',
    );
  } finally {
    await app?.close();
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);
it('refuses copying while the previous Electron instance owns the source singleton', async () => {
  const f = await fixture();
  let previous: ElectronApplication | undefined, app: ElectronApplication | undefined;
  try {
    const oldRoot = join(f.root, 'old-launch');
    await mkdir(oldRoot);
    previous = await launch(
      oldRoot,
      `const{app}=require('electron');app.setPath('userData',${JSON.stringify(f.source)});globalThis.locked=app.requestSingleInstanceLock();`,
    );
    expect(
      await previous.evaluate(() => (globalThis as unknown as { locked: boolean }).locked),
    ).toBe(true);
    app = await launch(f.root, coordinator(f, 1));
    expect(
      await app.evaluate(
        async () => await (globalThis as unknown as { copyResult: Promise<boolean> }).copyResult,
      ),
    ).toBe(false);
    expect(
      await app.evaluate(() => (globalThis as unknown as { prompts: unknown[] }).prompts),
    ).toEqual([{ type: 'warning', buttons: 2 }]);
    await expect(readFile(join(f.home, 'data-v2/axterm.sqlite'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await app?.close();
    await previous?.close();
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

it('keeps corrupt Vault media unpublished and shows only the redacted recovery reason', async () => {
  const f = await fixture();
  let app: ElectronApplication | undefined;
  try {
    await writeFile(join(f.source, 'vault-v2', f.ref + '.bin'), 'PRIVATE_FAULT_FIXTURE');
    app = await launch(f.root, coordinator(f, 0, true));
    expect(
      await app.evaluate(
        async () => await (globalThis as unknown as { copyResult: Promise<boolean> }).copyResult,
      ),
    ).toBe(false);
    const details = await app.evaluate(
      () => (globalThis as unknown as { details: string[] }).details,
    );
    expect(details.join(' ')).toContain('complete original Vault backup');
    expect(details.join(' ')).not.toContain('PRIVATE_FAULT_FIXTURE');
    await expect(readFile(join(f.home, 'data-v2/axterm.sqlite'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await app?.close();
    await rm(f.root, { recursive: true, force: true });
  }
}, 30000);

const packageResult = process.env.AXTERM_LEVEL3_PACKAGE_RESULT;
it.skipIf(!packageResult || process.platform !== 'darwin')(
  'copies generation-two media with the shipped worker and boots the source-free app from the committed new home',
  async () => {
    const f = await fixture();
    let worker: ChildProcess | undefined;
    let application: ElectronApplication | undefined;
    const digest = async (file: string) =>
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
    const original = await digest(join(f.source, 'data-v2/axterm.sqlite'));
    try {
      const record: { app: string } = JSON.parse(await readFile(resolve(packageResult!), 'utf8'));
      const appRoot = dirname(dirname(dirname(record.app)));
      const [binaryName] = await readdir(join(appRoot, 'Contents/MacOS'));
      const binary = join(appRoot, 'Contents/MacOS', binaryName!);
      const environment = {
        ...process.env,
        AXTERM_HOME: f.home,
        AXTERM_LEGACY_HOME: join(f.home, 'absent-legacy-source'),
        PATH: '/usr/bin:/bin',
        NODE_OPTIONS: '',
        NODE_PATH: '',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
      };
      worker = spawn(
        binary,
        [
          '--expose-internals',
          createRequire(join(record.app, 'package.json')).resolve('@axterm/desktop-host'),
          '--data-copy',
        ],
        {
          cwd: f.root,
          env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      const exit = once(worker, 'exit');
      const message = once(worker, 'message', { signal: AbortSignal.timeout(15_000) });
      worker.send({
        kind: 'axterm-home-copy',
        version: 1,
        source: f.source,
        home: f.home,
        action: 'copy',
      });
      expect((await message)[0]).toMatchObject({
        kind: 'axterm-home-copy-result',
        version: 1,
        ok: true,
      });
      expect((await exit)[0]).toBe(0);
      expect(await digest(join(f.source, 'data-v2/axterm.sqlite'))).toBe(original);
      expect(await readFile(join(f.home, 'vault-v2/master.key'))).toEqual(
        await readFile(join(f.source, 'vault-v2/master.key')),
      );
      expect(await readFile(join(f.home, 'vault-v2', f.ref + '.bin'))).toEqual(
        await readFile(join(f.source, 'vault-v2', f.ref + '.bin')),
      );
      expect(JSON.parse(await readFile(join(f.home, 'level3-data-copy.json'), 'utf8')).state).toBe(
        'committed',
      );
      application = await electron.launch({
        executablePath: binary,
        args: [],
        cwd: f.root,
        env: environment,
        timeout: 15_000,
      });
      const page = await application.firstWindow({ timeout: 15_000 });
      await page
        .locator('[data-axterm-product-workspace][data-workspace-presentation=ready]')
        .waitFor({ timeout: 15_000 });
      expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
      expect(await page.locator('body').innerText()).not.toContain('Failed to load plugins');
      await closeLevel3Desktop(application);
      application = undefined;
      expect(await digest(join(f.source, 'data-v2/axterm.sqlite'))).toBe(original);
    } finally {
      if (worker?.exitCode === null) worker.kill('SIGKILL');
      if (application) await closeLevel3Desktop(application);
      await rm(f.root, { recursive: true, force: true });
    }
  },
  45_000,
);
