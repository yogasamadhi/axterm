import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { create as createTar } from 'tar';
import { expect, it } from 'vitest';

async function fixture(root: string, version: string, broken = false) {
  const directory = join(root, version),
    source = join(directory, 'package');
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({
      name: '@external/distributed-fixture',
      version,
      type: 'module',
      engines: { axterm: '^0.10.0' },
      exports: { '.': './index.js' },
      scripts: { postinstall: 'node build.js' },
      axterm: { bundle: { patch: './cordis.patch.yml' } },
    }),
  );
  await writeFile(
    join(source, 'cordis.patch.yml'),
    "- insert:\n    - id: external-distributed-fixture\n      name: '@external/distributed-fixture'\n",
  );
  await writeFile(
    join(source, 'build.js'),
    "import{writeFileSync}from'node:fs';writeFileSync('approved-build-runtime',process.execPath);",
  );
  await writeFile(
    join(source, 'index.js'),
    `import{writeFileSync}from'node:fs';import{join}from'node:path';
export const inject=['pluginManager'];
export function apply(ctx){ctx.pluginManager.list();${broken ? "throw new Error('CONTROLLED_DISTRIBUTED_ACTIVATION_FAILURE');" : ''}
const file=join(ctx.profileContext.home,'distributed-plugin-state');writeFileSync(file,'active-${version}');
ctx.provide('distributedFixture',{version:${JSON.stringify(version)}});
ctx.effect(()=>async()=>{await new Promise(done=>setTimeout(done,30));writeFileSync(file,'disposed-${version}');});}
`,
  );
  const archive = join(directory, 'fixture.tgz');
  await createTar({ cwd: directory, file: archive, gzip: true }, ['package']);
  return archive;
}

it.skipIf(process.platform !== 'darwin' || !process.env.AXTERM_LEVEL3_PACKAGE_RESULT)(
  'manages real external packages using distributed pnpm and Electron RunAsNode without system Node or checkout imports',
  async () => {
    const result = JSON.parse(await readFile(process.env.AXTERM_LEVEL3_PACKAGE_RESULT!, 'utf8'));
    const runtime = result.app,
      appRoot = dirname(dirname(dirname(runtime)));
    const binaries = await readdir(join(appRoot, 'Contents/MacOS'));
    const executable = join(appRoot, 'Contents/MacOS', binaries[0]!);
    const hostRequire = createRequire(
      join(runtime, 'node_modules/@axterm/desktop-host/package.json'),
    );
    const boot = hostRequire.resolve('@axterm/cli/profile-boot'),
      cliDirectory = dirname(dirname(boot));
    const cliRequire = createRequire(join(cliDirectory, 'package.json'));
    const manager = cliRequire.resolve('@axterm/infra-plugin-manager');
    const root = await mkdtemp(join(tmpdir(), 'axterm-distributed-plugin-'));
    try {
      const home = join(root, 'home');
      await mkdir(home);
      const file = await fixture(root, '1.0.0'),
        next = await fixture(root, '1.1.0'),
        broken = await fixture(root, '1.2.0', true);
      const env = {
        ...process.env,
        AXTERM_HOME: home,
        AXTERM_LEGACY_HOME: join(home, 'absent-legacy-source'),
        ELECTRON_RUN_AS_NODE: '1',
        PATH: '/usr/bin:/bin',
        NODE_PATH: '',
        NODE_OPTIONS: '',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
      };
      const run = async (...args: string[]) => {
        const { stdout } = await promisify(execFile)(
          executable,
          [join(cliDirectory, 'lib/index.js'), 'plugin', '--profile', 'desktop', ...args],
          { cwd: root, env, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
        );
        return JSON.parse(stdout);
      };
      expect(await run('add', file, '--disabled')).toMatchObject({ application: 'applied' });
      const builds = await run('builds');
      expect(builds).toMatchObject([{ name: '@external/distributed-fixture', version: '1.0.0' }]);
      const marker = join(
        home,
        'profiles/desktop/node_modules/@external/distributed-fixture/approved-build-runtime',
      );
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(run('approve-builds', builds[0].id)).rejects.toThrow();
      expect(await run('approve-builds', builds[0].id, '--confirm')).toMatchObject({
        application: 'applied',
      });
      expect(await readFile(marker, 'utf8')).toBe(executable);
      await expect(access(join(home, 'data-v2'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(home, 'vault-v2'))).rejects.toMatchObject({ code: 'ENOENT' });
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
      const probe = join(root, 'host-probe.mjs');
      await writeFile(
        probe,
        `
import assert from'node:assert/strict';import{readFile,access}from'node:fs/promises';import{join}from'node:path';
import{runProfile}from ${JSON.stringify(pathToFileURL(boot).href)};
import{createPluginManager}from ${JSON.stringify(pathToFileURL(manager).href)};
const home=${JSON.stringify(home)},directory=${JSON.stringify(directory)};
const app=await runProfile({profile:'web',home,installAnchor:${JSON.stringify(join(cliDirectory, 'package.json'))},templates:{},patchFiles:[],args:[],requiredServices:['webStartup'],prepare(ctx){ctx.provide('webAssets',{index:${JSON.stringify(hostRequire.resolve('@axterm/web/dist'))},authenticationPage:${JSON.stringify(join(dirname(hostRequire.resolve('@axterm/web/dist')), 'auth.html'))}});}});
let owner;
try{
 owner=await createPluginManager(app.ctx);
 assert.equal((await owner.install(${JSON.stringify(file)})).application,'applied');assert.equal(app.ctx.get('distributedFixture').version,'1.0.0');
 await assert.rejects(access(join(directory,'node_modules/@external/distributed-fixture/approved-build-runtime')));
 assert.equal((await owner.install(${JSON.stringify(next)},{replace:true})).application,'applied');assert.equal(app.ctx.get('distributedFixture').version,'1.1.0');
 const manifest=await readFile(join(directory,'package.json'),'utf8');
 await assert.rejects(owner.install(${JSON.stringify(broken)},{replace:true}));
 assert.equal(await readFile(join(directory,'package.json'),'utf8'),manifest);assert.equal(app.ctx.get('distributedFixture').version,'1.1.0');
 await owner.remove('@external/distributed-fixture');assert.equal(app.ctx.get('distributedFixture'),undefined);
 assert.equal(await readFile(join(home,'distributed-plugin-state'),'utf8'),'disposed-1.1.0');
 assert.deepEqual(await owner.transactions(),[]);
 console.log('distributed-manager-install-upgrade-rollback-drain-passed');
}finally{try{await owner?.close();}finally{await app.shutdown.shutdown(0);}}
`,
      );
      const { stdout } = await promisify(execFile)(executable, ['--expose-internals', probe], {
        cwd: root,
        env,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      expect(stdout.trim()).toBe('distributed-manager-install-upgrade-rollback-drain-passed');
      await run('remove', '@external/distributed-fixture');
      expect(
        (await run('list')).packages.some(
          (entry: { name: string }) => entry.name === '@external/distributed-fixture',
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
