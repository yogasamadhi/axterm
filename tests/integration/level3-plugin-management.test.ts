import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { create as createTar } from 'tar';
import { expect, it } from 'vitest';
import { runPluginCommand, parsePluginInvocation } from '../../apps/cli/src/plugin-command.ts';
import { withProfileManagement } from '../../apps/cli/src/profile-boot.ts';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';

async function archive(
  root: string,
  version = '1.0.0',
  incompatible = false,
  broken = false,
  name = '@external/owned-fixture',
  missingPatch = false,
  failedDisposer = false,
) {
  const directory = join(root, 'fixture-' + version),
    source = join(directory, 'package');
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({
      name,
      version,
      type: 'module',
      engines: { axterm: incompatible ? '>=99' : '^0.10.0' },
      exports: { '.': './index.js' },
      scripts: { postinstall: 'node build.js' },
      axterm: { bundle: { patch: missingPatch ? './missing.yml' : './cordis.patch.yml' } },
    }),
  );
  await writeFile(
    join(source, 'cordis.patch.yml'),
    `- insert:\n    - id: external-owned-fixture\n      name: '${name}'\n`,
  );
  await writeFile(
    join(source, 'build.js'),
    "import {writeFileSync} from 'node:fs';writeFileSync('UNAPPROVED_BUILD_RAN', process.execPath);",
  );
  await writeFile(
    join(source, 'index.js'),
    `import{writeFileSync}from'node:fs';import{join}from'node:path';
export const inject=['pluginManager'];
export function apply(ctx){
 ctx.pluginManager.list();
 ${broken ? "throw new Error('CONTROLLED_EXTERNAL_ACTIVATION_FAILURE');" : ''}
 const file=join(ctx.profileContext.home,'external-fixture-state');
 writeFileSync(file,'active-${version}');
 ctx.provide('externalOwnedFixture',{version:${JSON.stringify(version)}});
 ctx.effect(()=>async()=>{await new Promise(done=>setTimeout(done,30));${failedDisposer ? "throw new Error('CONTROLLED_EXTERNAL_DISPOSAL_FAILURE');" : `writeFileSync(file,'disposed-${version}');`}});
}`,
  );
  const file = join(directory, 'fixture.tgz');
  await createTar({ cwd: directory, file, gzip: true }, ['package']);
  return file;
}
it('strictly parses explicit Profile management and separates exact compatibility risk acceptance', () => {
  expect(
    parsePluginInvocation(['--profile', 'desktop', 'add', '@external/plugin@1.0.0']).command,
  ).toBe('add');
  expect(() => parsePluginInvocation(['add', 'pkg'])).toThrow('PROFILE_REQUIRED');
  expect(() => parsePluginInvocation(['--profile', '../desktop', 'list'])).toThrow();
  expect(() =>
    parsePluginInvocation(['--profile', 'web', 'add', 'pkg', '--accept-risk']),
  ).toThrow();
  expect(() => parsePluginInvocation(['--profile', 'web', 'allow-version', 'pkg@1.0.0'])).toThrow();
  expect(() => parsePluginInvocation(['--profile', 'web', 'list', '--profile', 'web'])).toThrow();
});
it('uses the runner lock for offline Desktop management without loading external Profile code', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-plugin-lock-'));
  try {
    await withProfileManagement(
      { profile: 'desktop', home, templates: PROFILE_TEMPLATES },
      async () => {
        await expect(runPluginCommand(['--profile', 'desktop', 'list'], home)).rejects.toThrow();
      },
    );
    const listed = (await runPluginCommand(['--profile', 'desktop', 'list'], home)) as {
      profile: string;
    };
    expect(listed.profile).toBe('desktop');
    await expect(access(join(home, 'data-v2'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(home, 'vault-v2'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
it('reports a selected broken bundle and refuses enabling it while retaining disable and removal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-plugin-broken-bundle-'));
  try {
    const file = await archive(home, '1.0.0', false, false, '@external/broken-bundle', true);
    const run = (...args: string[]) => runPluginCommand(['--profile', 'desktop', ...args], home);
    await run('add', file, '--disabled');
    const path = join(home, 'profiles/desktop/package.json');
    const before = await readFile(path, 'utf8');
    await expect(run('enable', '@external/broken-bundle')).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(before);
    const manifest = JSON.parse(before);
    manifest.axterm.profile.bundles.push('@external/broken-bundle');
    await writeFile(path, JSON.stringify(manifest));
    const listed = (await run('list')) as {
      packages: { name: string; enabled: boolean; problem?: string }[];
    };
    expect(listed.packages.find((item) => item.name === '@external/broken-bundle')).toMatchObject({
      enabled: true,
      problem: 'invalid',
    });
    await run('disable', '@external/broken-bundle');
    await run('remove', '@external/broken-bundle');
    expect(
      ((await run('list')) as { packages: { name: string }[] }).packages.some(
        (item) => item.name === '@external/broken-bundle',
      ),
    ).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);
it.each(['overlay', 'disposal'] as const)(
  'retains loaded implementation when %s prevents a safe unload',
  async (mode) => {
    const home = await mkdtemp(join(tmpdir(), 'axterm-plugin-unload-' + mode + '-'));
    try {
      const file = await archive(
        home,
        '1.0.0',
        false,
        false,
        '@external/owned-fixture',
        false,
        mode === 'disposal',
      );
      const directory = join(home, 'profiles/web');
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
          private: true,
          type: 'module',
          axterm: { profile: { bundles: ['@axterm/bundle-base', '@axterm/bundle-web'] } },
        }),
      );
      await runPluginCommand(['--profile', 'web', 'add', file], home);
      if (mode === 'overlay') {
        await writeFile(
          join(directory, 'cordis.patch.yml'),
          '- id: external-owned-fixture\n  disabled: true\n',
        );
        await writeFile(
          join(home, 'cordis.patch.yml'),
          "- insert:\n    - id: retained-by-home\n      name: '@external/owned-fixture'\n- id: retained-by-home\n  disabled: false\n",
        );
      }
      const probe = join(home, 'unload.mjs');
      await writeFile(
        probe,
        `
import assert from'node:assert/strict';import{readFile,access}from'node:fs/promises';import{join}from'node:path';
import{runProfile}from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-boot.js')).href)};
import * as Manager from ${JSON.stringify(pathToFileURL(resolve('packages/infra/plugin-manager/lib/index.js')).href)};
const home=${JSON.stringify(home)},mode=${JSON.stringify(mode)};
const app=await runProfile({profile:'web',home,installAnchor:${JSON.stringify(resolve('apps/cli/package.json'))},templates:{},patchFiles:[],args:[],requiredServices:['webStartup'],prepare(ctx){ctx.provide('webAssets',{index:${JSON.stringify(resolve('apps/web/dist/index.html'))},authenticationPage:${JSON.stringify(resolve('apps/web/dist/auth.html'))}});}});
let manager;let removes=0;
try{
 manager=await Manager.createPluginManager(app.ctx);await app.ctx.loader.await();
 assert.equal(app.ctx.get('externalOwnedFixture').version,'1.0.0');
 const spawn=app.ctx.subprocess.spawn.bind(app.ctx.subprocess);
 app.ctx.subprocess.spawn=(spec)=>{if(spec.argv.includes('remove')) removes++;return spawn(spec);};
 if(mode==='overlay'){
  assert.equal((await manager.setPluginEnabled('retained-by-home',false)).application,'overridden');
  await assert.rejects(manager.remove('@external/owned-fixture'),{reason:'permission'});
  assert.equal(app.ctx.get('externalOwnedFixture').version,'1.0.0');
  assert.deepEqual(await manager.transactions(),[]);
 }else{
  await assert.rejects(manager.remove('@external/owned-fixture'));
  assert.equal(manager.inspectTasks(new AbortController().signal).active,true);
  await assert.rejects(manager.setBundleEnabled('@external/owned-fixture',true));
 }
 assert.equal(removes,0);
 await access(join(home,'profiles/web/node_modules/@external/owned-fixture/package.json'));
 assert.equal(await readFile(join(home,'external-fixture-state'),'utf8'),'active-1.0.0');
 console.log('unsafe-unload-preserved-'+mode);
}finally{try{if(mode==='disposal'&&manager) await assert.rejects(manager.close());else await manager?.close();}finally{await app.shutdown.shutdown(0);}}
`,
      );
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--expose-internals', probe],
        {
          cwd: home,
          env: {
            ...process.env,
            AXTERM_HOME: home,
            HTTP_PROXY: '',
            HTTPS_PROXY: '',
            ALL_PROXY: '',
          },
          timeout: 25_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      expect(stdout.trim()).toBe('unsafe-unload-preserved-' + mode);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  35_000,
);
it('requires separate exact build approval and uses the application Node wrapper with a restricted PATH', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-plugin-builds-'));
  try {
    const file = await archive(home),
      next = await archive(home, '1.1.0'),
      other = await archive(join(home, 'other'), '1.0.0', false, false, '@external/other-build');
    const run = (...args: string[]) => runPluginCommand(['--profile', 'desktop', ...args], home);
    await run('add', file, '--disabled');
    const builds = (await run('builds')) as { id: string; name: string; version: string }[];
    expect(builds).toHaveLength(1);
    await run('add', other, '--disabled');
    expect(builds[0]).toMatchObject({ name: '@external/owned-fixture', version: '1.0.0' });
    const marker = join(
      home,
      'profiles/desktop/node_modules/@external/owned-fixture/UNAPPROVED_BUILD_RAN',
    );
    await expect(run('approve-builds', builds[0]!.id)).rejects.toThrow();
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await run('transactions')).toEqual([]);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH =
        process.platform === 'win32'
          ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32')
          : '/usr/bin:/bin';
      expect(await run('approve-builds', builds[0]!.id, '--confirm')).toMatchObject({
        application: 'applied',
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    expect(await readFile(marker, 'utf8')).toBe(process.execPath);
    expect(await run('builds')).toMatchObject([{ name: '@external/other-build' }]);
    await expect(
      access(
        join(home, 'profiles/desktop/node_modules/@external/other-build/UNAPPROVED_BUILD_RAN'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await run('upgrade', next, '--disabled');
    const upgraded = (await run('builds')) as { id: string; name: string; version: string }[];
    const target = upgraded.find((item) => item.name === '@external/owned-fixture')!;
    expect(target.version).toBe('1.1.0');
    expect(target.id).not.toBe(builds[0]!.id);
    await expect(run('approve-builds', builds[0]!.id, '--confirm')).rejects.toThrow();
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await run('transactions')).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);
it('keeps interrupted package transactions visible and repairs only validated Profile backup files without executing scripts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-plugin-repair-'));
  try {
    const run = (...args: string[]) => runPluginCommand(['--profile', 'desktop', ...args], home);
    await run('list');
    const directory = join(home, 'profiles/desktop');
    const files: Record<string, string | null> = {};
    for (const name of [
      'package.json',
      'pnpm-lock.yaml',
      'cordis.patch.yml',
      'pnpm-workspace.yaml',
    ]) {
      try {
        files[name] = await readFile(join(directory, name), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') files[name] = null;
        else throw error;
      }
    }
    const id = randomUUID(),
      backup = join(directory, '.plugin-manager/transactions', id);
    await mkdir(backup, { recursive: true });
    await writeFile(
      join(backup, 'before.json'),
      JSON.stringify({ ...files, '../outside': 'must-not-write' }),
    );
    expect(await run('transactions')).toEqual([id]);
    await expect(run('enable', '@axterm/bundle-catalog')).rejects.toThrow();
    await expect(run('repair', id)).rejects.toThrow();
    await expect(access(join(directory, '../outside'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(directory, 'package.json'), 'utf8')).toBe(files['package.json']);
    await writeFile(join(backup, 'before.json'), JSON.stringify(files));
    await writeFile(
      join(directory, 'package.json'),
      '{"private":true,"scripts":{"postinstall":"node -e process.exit(7)"}}',
    );
    expect(await run('repair', id)).toMatchObject({ application: 'applied' });
    for (const [name, expected] of Object.entries(files)) {
      if (expected === null)
        await expect(access(join(directory, name))).rejects.toMatchObject({ code: 'ENOENT' });
      else expect(await readFile(join(directory, name), 'utf8')).toBe(expected);
    }
    expect(await run('transactions')).toEqual([]);
    await expect(access(join(home, 'data-v2'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);
it('installs a real tarball with bundled pnpm, denies scripts and incompatible versions before activation, and preserves data on removal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-plugin-tarball-'));
  try {
    const file = await archive(home),
      incompatible = await archive(home, '2.0.0', true);
    const run = (...args: string[]) => runPluginCommand(['--profile', 'desktop', ...args], home);
    const inspected = (await run('inspect', file)) as {
      manifest: { name: string; version: string };
    };
    expect(inspected.manifest.name).toBe('@external/owned-fixture');
    expect(await run('add', file)).toMatchObject({ changed: true, application: 'applied' });
    const directory = join(home, 'profiles/desktop');
    const manifest = await readFile(join(directory, 'package.json'), 'utf8');
    const lock = await readFile(join(directory, 'pnpm-lock.yaml'), 'utf8');
    await expect(access(join(home, 'external-fixture-state'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      access(join(directory, 'node_modules/@external/owned-fixture/UNAPPROVED_BUILD_RAN')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(run('upgrade', incompatible)).rejects.toThrow();
    expect(await readFile(join(directory, 'package.json'), 'utf8')).toBe(manifest);
    expect(await readFile(join(directory, 'pnpm-lock.yaml'), 'utf8')).toBe(lock);
    await run('disable', '@external/owned-fixture');
    expect(
      ((await run('list')) as { packages: { name: string; enabled: boolean }[] }).packages.find(
        (p) => p.name === '@external/owned-fixture',
      )?.enabled,
    ).toBe(false);
    await run('enable', '@external/owned-fixture');
    const userData = join(home, 'external-user-data');
    await writeFile(userData, 'retain');
    await run('remove', '@external/owned-fixture');
    expect(await readFile(userData, 'utf8')).toBe('retain');
    expect(
      JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).dependencies ?? {},
    ).not.toHaveProperty('@external/owned-fixture');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);
it('uses a real authenticated registry without public fallback, then installs its exact inspected tarball', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-plugin-registry-'));
  const requests: string[] = [],
    authenticated: boolean[] = [];
  let denied = false,
    base = '';
  const tarball = await readFile(await archive(home));
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url!, 'http://localhost').pathname);
    requests.push(path);
    authenticated.push(request.headers.authorization === 'Bearer REGISTRY_FIXTURE_SECRET');
    if (request.headers.authorization !== 'Bearer REGISTRY_FIXTURE_SECRET') {
      response.writeHead(401);
      response.end();
      return;
    }
    if (denied) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not found"}');
      return;
    }
    if (path === '/fixture.tgz') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(tarball);
      return;
    }
    if (path === '/@external/owned-fixture') {
      const manifest = {
        name: '@external/owned-fixture',
        version: '1.0.0',
        engines: { axterm: '^0.10.0' },
        axterm: { bundle: { patch: './cordis.patch.yml' } },
        dist: {
          tarball: base + 'fixture.tgz',
          integrity: 'sha512-' + createHash('sha512').update(tarball).digest('base64'),
        },
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          name: manifest.name,
          'dist-tags': { latest: manifest.version },
          versions: { [manifest.version]: manifest },
          time: {
            created: '2020-01-01T00:00:00Z',
            modified: '2020-01-01T00:00:00Z',
            '1.0.0': '2020-01-01T00:00:00Z',
          },
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unbound registry');
  base = `http://127.0.0.1:${address.port}/`;
  try {
    const directory = join(home, 'profiles/desktop');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, '.npmrc'),
      `//127.0.0.1:${address.port}/:_authToken=REGISTRY_FIXTURE_SECRET\nfetch-retries=0\n`,
      { mode: 0o600 },
    );
    const run = (...args: string[]) =>
      runPluginCommand(['--profile', 'desktop', '--registry', base, ...args], home);
    const inspected = (await run('inspect', '@external/owned-fixture@1.0.0')) as {
      manifest: { version: string };
      registry: string;
    };
    expect(inspected.manifest.version).toBe('1.0.0');
    expect(inspected.registry).toBe(base);
    expect(requests).not.toContain('/fixture.tgz');
    denied = true;
    await expect(run('add', '@external/owned-fixture@1.0.0')).rejects.toThrow();
    expect(requests).not.toContain('/fixture.tgz');
    expect(
      JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).dependencies ?? {},
    ).not.toHaveProperty('@external/owned-fixture');
    denied = false;
    expect(await run('add', '@external/owned-fixture@1.0.0')).toMatchObject({
      application: 'applied',
    });
    expect(requests).toContain('/fixture.tgz');
    expect(authenticated.every(Boolean)).toBe(true);
    await expect(access(join(home, 'external-fixture-state'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);
it('preserves a running non-HMR composition until exit, then lets the offline CLI remove its implementation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-plugin-no-hmr-'));
  try {
    const file = await archive(home),
      next = await archive(home, '1.1.0'),
      directory = join(home, 'profiles/web');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        axterm: { profile: { bundles: ['@axterm/bundle-base', '@axterm/bundle-web'] } },
      }),
    );
    await runPluginCommand(['--profile', 'web', 'add', file], home);
    await writeFile(join(directory, 'cordis.patch.yml'), '- id: hmr\n  disabled: true\n');
    const probe = join(home, 'no-hmr.mjs');
    await writeFile(
      probe,
      `
import assert from'node:assert/strict';import{readFile,access}from'node:fs/promises';import{join}from'node:path';
import{runProfile}from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-boot.js')).href)};
import * as Manager from ${JSON.stringify(pathToFileURL(resolve('packages/infra/plugin-manager/lib/index.js')).href)};
const home=${JSON.stringify(home)};
const app=await runProfile({profile:'web',home,installAnchor:${JSON.stringify(resolve('apps/cli/package.json'))},templates:{},patchFiles:[],args:[],requiredServices:['webStartup'],prepare(ctx){ctx.provide('webAssets',{index:${JSON.stringify(resolve('apps/web/dist/index.html'))},authenticationPage:${JSON.stringify(resolve('apps/web/dist/auth.html'))}});}});
let manager;
try{
 assert.equal(app.ctx.get('hmr'),undefined);
 manager=await Manager.createPluginManager(app.ctx);await app.ctx.loader.await();
 const manifest=await readFile(join(home,'profiles/web/package.json'),'utf8');
 assert.deepEqual(await manager.install(${JSON.stringify(next)},{replace:true}),{changed:false,application:'restart-required',restartReason:'offline-upgrade-required'});
 assert.equal(await readFile(join(home,'profiles/web/package.json'),'utf8'),manifest);
 assert.equal(JSON.parse(await readFile(join(home,'profiles/web/node_modules/@external/owned-fixture/package.json'),'utf8')).version,'1.0.0');
 assert.equal((await manager.setPluginEnabled('external-owned-fixture',false)).application,'restart-required');
 assert.equal((await manager.remove('@external/owned-fixture')).application,'restart-required');
 assert.equal(app.ctx.get('externalOwnedFixture').version,'1.0.0');
 await access(join(home,'profiles/web/node_modules/@external/owned-fixture/package.json'));
 assert.equal(await readFile(join(home,'external-fixture-state'),'utf8'),'active-1.0.0');
 await assert.rejects(manager.repair('00000000-0000-4000-8000-000000000000'));
}finally{try{await manager?.close();}finally{await app.shutdown.shutdown(0);}}
assert.equal(await readFile(join(home,'external-fixture-state'),'utf8'),'disposed-1.0.0');
console.log('non-hmr-preserves-running-code-until-exit');
`,
    );
    const { stdout } = await promisify(execFile)(process.execPath, ['--expose-internals', probe], {
      cwd: home,
      env: { ...process.env, AXTERM_HOME: home, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' },
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(stdout.trim()).toBe('non-hmr-preserves-running-code-until-exit');
    expect(
      await runPluginCommand(['--profile', 'web', 'remove', '@external/owned-fixture'], home),
    ).toMatchObject({ application: 'applied' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 25_000);
it('awaits actual HMR disposal, upgrades the loaded module and restores a failed replacement in an independent Host', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-plugin-live-'));
  try {
    const file = await archive(home),
      upgraded = await archive(home, '1.1.0'),
      broken = await archive(home, '1.2.0', false, true);
    const directory = join(home, 'profiles/web');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        axterm: { profile: { bundles: ['@axterm/bundle-base', '@axterm/bundle-web'] } },
      }),
    );
    await runPluginCommand(['--profile', 'web', 'add', file], home);
    await writeFile(join(directory, 'cordis.patch.yml'), '# Preserved Profile header\n[]\n');
    const probe = join(home, 'live-manager.mjs');
    await writeFile(
      probe,
      `
import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';import{join}from'node:path';
import{runProfile}from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-boot.js')).href)};
import{runPluginCommand}from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/types/plugin-command.js')).href)};
import * as Manager from ${JSON.stringify(pathToFileURL(resolve('packages/infra/plugin-manager/lib/index.js')).href)};
const home=${JSON.stringify(home)},directory=${JSON.stringify(directory)};
const state=()=>readFile(join(home,'external-fixture-state'),'utf8');
const app=await runProfile({profile:'web',home,installAnchor:${JSON.stringify(resolve('apps/cli/package.json'))},templates:{},patchFiles:[],args:[],requiredServices:['webStartup'],prepare(ctx){ctx.provide('webAssets',{index:${JSON.stringify(resolve('apps/web/dist/index.html'))},authenticationPage:${JSON.stringify(resolve('apps/web/dist/auth.html'))}});}});
let manager;
try{
 manager=await Manager.createPluginManager(app.ctx);await app.ctx.loader.await();
 assert.equal(await state(),'active-1.0.0');
 await assert.rejects(runPluginCommand(['--profile','web','list'],home));
 await manager.setPluginEnabled('external-owned-fixture',false);assert.equal(await state(),'disposed-1.0.0');
 await manager.setPluginEnabled('external-owned-fixture',true);
 const patch=await readFile(join(directory,'cordis.patch.yml'),'utf8');assert.ok(patch.includes('Preserved Profile header'));assert.ok(!patch.includes('disabled:'));
 let expected='disposed-1.0.0';const spawn=app.ctx.subprocess.spawn.bind(app.ctx.subprocess);
 app.ctx.subprocess.spawn=(spec)=>{if(spec.argv.includes('remove')){assert.equal(requireState(),expected);}return spawn(spec);};
 function requireState(){return readFileSync(join(home,'external-fixture-state'),'utf8');}
 const {readFileSync}=await import('node:fs');
 assert.equal((await manager.install(${JSON.stringify(upgraded)},{replace:true})).application,'applied');assert.equal(await state(),'active-1.1.0',JSON.stringify({
 state:await state(),service:app.ctx.get('externalOwnedFixture'),
 resolution:app.ctx.pluginPackages.resolution.entries.filter(row=>row.name==='@external/owned-fixture'),
 local:app.ctx.pluginPackages.resolution.localPackageNames,
 linked:app.ctx.pluginPackages.resolution.linkedRoots,
 installed:await readFile(join(directory,'node_modules/@external/owned-fixture/index.js'),'utf8')
}));expected='disposed-1.1.0';
 const manifest=await readFile(join(directory,'package.json'),'utf8'),lock=await readFile(join(directory,'pnpm-lock.yaml'),'utf8');
 await assert.rejects(manager.install(${JSON.stringify(broken)},{replace:true}));
 assert.equal(await readFile(join(directory,'package.json'),'utf8'),manifest);assert.equal(await readFile(join(directory,'pnpm-lock.yaml'),'utf8'),lock);assert.equal(await state(),'active-1.1.0');
 await manager.remove('@external/owned-fixture');assert.equal(app.ctx.get('externalOwnedFixture'),undefined);assert.equal(await state(),'disposed-1.1.0');
 assert.equal([...Map.prototype.keys.call(app.ctx.loader.internal.loadCache)].filter(url=>url.includes('owned-fixture')).length,0);
 console.log('owned-plugin-upgrade-rollback-drain-passed');
}finally{try{await manager?.close();}finally{await app.shutdown.shutdown(0);}}
`,
    );
    const { stdout } = await promisify(execFile)(process.execPath, ['--expose-internals', probe], {
      cwd: home,
      env: { ...process.env, AXTERM_HOME: home, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' },
      timeout: 40_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(stdout.trim()).toBe('owned-plugin-upgrade-rollback-drain-passed');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 45_000);
