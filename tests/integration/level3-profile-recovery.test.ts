import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import {
  prepareProfileRecovery,
  clearProfileRecovery,
  profileRecoveryActive,
  PROFILE_RECOVERY_MARKER,
} from '../../packages/infra/profile-recovery/src/index.ts';
import { withFileLock } from '../../packages/infra/atomic-write/src/index.ts';
import { parsePluginInvocation, runPluginCommand } from '../../apps/cli/src/plugin-command.ts';
const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'axterm-recovery-'));
  roots.push(home);
  const dir = join(home, 'profiles/web');
  await mkdir(dir, { recursive: true });
  return { home, dir };
}
it('backs up malformed patches without evaluating them, preserves packages/data and requires explicit offline clearing', async () => {
  const { home, dir } = await fixture();
  const patch = 'invalid: [yaml\n!!js throw new Error("NEVER_EVALUATE")';
  await writeFile(join(dir, 'cordis.patch.yml'), patch);
  await writeFile(join(dir, 'package.json'), 'malformed manifest');
  await writeFile(join(dir, 'user-data'), 'preserved');
  await prepareProfileRecovery(home, 'web');
  expect(profileRecoveryActive(home, 'web')).toBe(true);
  const marker = JSON.parse(await readFile(join(dir, PROFILE_RECOVERY_MARKER), 'utf8'));
  expect(marker.phase).toBe('ready');
  expect(await readFile(join(dir, marker.backup), 'utf8')).toBe(patch);
  await expect(access(join(dir, 'cordis.patch.yml'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(clearProfileRecovery(home, 'web', false)).rejects.toThrow('CONFIRMATION');
  expect(profileRecoveryActive(home, 'web')).toBe(true);
  expect(await runPluginCommand(['--profile', 'web', 'recovery', 'status'], home)).toMatchObject({
    recovery: true,
  });
  await runPluginCommand(['--profile', 'web', 'recovery', 'clear', '--confirm'], home);
  expect(profileRecoveryActive(home, 'web')).toBe(false);
  expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe('malformed manifest');
  expect(await readFile(join(dir, 'user-data'), 'utf8')).toBe('preserved');
  expect(await readFile(join(dir, marker.backup), 'utf8')).toBe(patch);
  expect(() => parsePluginInvocation(['--profile', 'web', 'recovery', 'clear'])).toThrow();
  expect(() =>
    parsePluginInvocation(['--profile', 'web', 'recovery', 'status', '--confirm']),
  ).toThrow();
});
it('excludes a running Profile from recovery preparation and clearing', async () => {
  const { home, dir } = await fixture();
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const running = withFileLock(join(dir, 'profile-runtime'), async () => {
    held.resolve();
    await release.promise;
  });
  await held.promise;
  try {
    await expect(prepareProfileRecovery(home, 'web')).rejects.toThrow();
    await expect(clearProfileRecovery(home, 'web', true)).rejects.toThrow();
    expect(profileRecoveryActive(home, 'web')).toBe(false);
  } finally {
    release.resolve();
    await running;
  }
});
for (const damagedManifest of [false, true])
  it(`boots only installation code despite ${damagedManifest ? 'malformed' : 'application-scoped external'} Profile metadata, executable home patch and interrupted marker`, async () => {
    const { home, dir } = await fixture();
    const external = join(dir, 'node_modules/@axterm/external-recovery-fixture');
    await mkdir(external, { recursive: true });
    const canary = join(home, 'external-executed');
    const manifest = JSON.stringify({
      name: 'recovery-fixture',
      dependencies: { '@axterm/external-recovery-fixture': '1.0.0' },
      axterm: { profile: { bundles: ['@axterm/external-recovery-fixture'] } },
    });
    await writeFile(join(dir, 'package.json'), damagedManifest ? 'invalid json' : manifest);
    await writeFile(
      join(external, 'package.json'),
      JSON.stringify({
        name: '@axterm/external-recovery-fixture',
        version: '1.0.0',
        type: 'module',
        exports: './index.js',
        axterm: { bundle: { patch: './patch.yml' } },
      }),
    );
    await writeFile(
      join(external, 'index.js'),
      `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(canary)},'executed');throw new Error('EXTERNAL_RECOVERY_CODE_RAN');`,
    );
    await writeFile(
      join(external, 'patch.yml'),
      '- insert:\n    - id: external-recovery-fixture\n      name: "@axterm/external-recovery-fixture"\n',
    );
    await writeFile(join(dir, 'cordis.patch.yml'), 'invalid: [profile yaml');
    await writeFile(
      join(home, 'cordis.patch.yml'),
      `- id: storage\n  disabled: !!js "(()=>{process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(canary).replaceAll('"', '\\"')},'executed');return true;})()"\n`,
    );
    // A crash after committing an intent, even a damaged intent, cannot re-enable code.
    await writeFile(join(dir, PROFILE_RECOVERY_MARKER), '');
    const launcher = join(home, 'launch.mjs');
    await writeFile(
      launcher,
      `import{runProfile}from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-boot.js')).href)};
const app=await runProfile({profile:'web',home:${JSON.stringify(home)},installAnchor:${JSON.stringify(resolve('apps/cli/package.json'))},templates:{web:{bundles:['@axterm/bundle-base','@axterm/bundle-plugins']}},patchFiles:['/missing/NEVER_READ.yml'],args:[],requiredServices:['storageDomain']});
const r=app.ctx.pluginPackages.resolution;
console.log(JSON.stringify({recovery:app.ctx.runtimeIdentity.recoveryMode,entries:r.entries.every(e=>e.scope==='installation'),locals:r.localPackageNames.length,links:r.linkedRoots.length,hmr:!!app.ctx.get('hmr'),manager:!!app.ctx.get('pluginManager')}));
await app.shutdown.shutdown(0);`,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await execute(process.execPath, ['--expose-internals', launcher], {
        cwd: home,
        env: { ...process.env, AXTERM_HOME: home, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' },
        timeout: 15000,
      });
      expect(result.stdout.trim()).toBe(
        JSON.stringify({
          recovery: true,
          entries: true,
          locals: 0,
          links: 0,
          hmr: false,
          manager: false,
        }),
      );
      await expect(access(canary)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        (await readdir(join(home, 'profiles'))).filter((x) => x.startsWith('.recovery-')),
      ).toEqual([]);
    }
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(
      damagedManifest ? 'invalid json' : manifest,
    );
    expect(profileRecoveryActive(home, 'web')).toBe(true);
  }, 35000);
