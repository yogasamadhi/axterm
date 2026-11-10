import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function home() {
  const root = await mkdtemp(join(tmpdir(), 'axterm-profile-template-'));
  directories.push(root);
  return root;
}
for (const profile of ['desktop', 'web', 'headless'])
  it(`records the actual ${profile} application config composition`, async () => {
    const directory = await home();
    const script = `import {dumpProfile} from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-boot.js')).href)};
    import {PROFILE_TEMPLATES} from ${JSON.stringify(pathToFileURL(resolve('apps/cli/lib/profile-templates.js')).href)};
    const home=${JSON.stringify(directory)};
    process.stdout.write(dumpProfile({profile:${JSON.stringify(profile)},home,desktopOwner:true,installAnchor:${JSON.stringify(resolve('apps/cli/package.json'))},templates:PROFILE_TEMPLATES,patchFiles:[],args:[]}).replaceAll(home,'<home>'));`;
    const { stdout } = await execute(
      process.execPath,
      ['--expose-internals', '--input-type=module', '-e', script],
      { timeout: 8000 },
    );
    expect(stdout).toMatchSnapshot();
    expect(stdout).toContain('@axterm/infra-storage-relational');
    expect(stdout.includes('@axterm/infra-web-server')).toBe(profile !== 'headless');
    expect(stdout.includes("name: '@axterm/engine-pi'")).toBe(profile !== 'headless');
    expect(stdout.includes("name: '@axterm/plugin-ai'")).toBe(profile !== 'headless');
    expect(stdout.includes("name: '@axterm/infra-plugin-manager'")).toBe(profile !== 'headless');
    expect(stdout.includes("name: '@axterm/plugin-plugins'")).toBe(profile !== 'headless');
    expect(stdout.includes("name: '@axterm/plugin-market'")).toBe(profile !== 'headless');
    await expect(stat(join(directory, 'data-v2'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
it('runs a real finite headless command, disposes its Profile and mounts no server', async () => {
  const directory = await home();
  const options = {
    timeout: 8000,
    env: { ...process.env, AXTERM_HOME: directory, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '' },
  };
  const command = ['--expose-internals', resolve('apps/cli/lib/index.js'), '--profile', 'headless'];
  const { stdout } = await execute(process.execPath, [...command, '--health'], options);
  expect(JSON.parse(stdout)).toMatchObject({ status: 'ok', mode: 'headless' });
  expect(JSON.parse(stdout).generation).toMatch(/^[0-9a-f-]{36}$/);
  await expect(stat(join(directory, 'profiles/headless/launch'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  // The first invocation released its writer lock and callbacks before the next owns the same Profile.
  const version = await execute(process.execPath, [...command, '--version'], options);
  expect(version.stdout.trim()).toBe('0.10.0');
  await expect(
    execute(process.execPath, [...command, 'unsupported-argument'], options),
  ).rejects.toThrow('PROFILE_REQUIRED_SERVICES_UNAVAILABLE');
});
