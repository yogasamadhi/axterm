import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createRemoteWorkspace } from '../support/level3-remote-workspace.ts';

const execute = promisify(execFile);

it('installs packed generator/SDK and generates in a built worker outside the repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-generator-package-'));
  const fixture = createRemoteWorkspace();
  const pnpm = resolve('node_modules/pnpm/bin/pnpm.cjs');
  try {
    for (const name of [
      '@axterm/remote-generator',
      '@axterm/plugin-api',
      '@deepseek-ai/cordis',
      '@deepseek-ai/cosmokit',
    ])
      await execute(
        process.execPath,
        [pnpm, '--filter', name, 'pack', '--pack-destination', root],
        {
          cwd: resolve('.'),
          timeout: 8000,
          maxBuffer: 256 * 1024,
        },
      );
    const dependencies: Record<string, string> = { zod: '4.4.3' };
    const archives = (await readdir(root)).filter((name) => name.endsWith('.tgz'));
    for (const [name, prefix] of [
      ['@axterm/remote-generator', 'axterm-remote-generator-'],
      ['@axterm/plugin-api', 'axterm-plugin-api-'],
      ['@deepseek-ai/cordis', 'deepseek-ai-cordis-'],
      ['@deepseek-ai/cosmokit', 'deepseek-ai-cosmokit-'],
    ]) {
      const archive = archives.find((name) => name.startsWith(prefix!));
      if (!archive) throw new Error('Missing packed package: ' + name);
      dependencies[name!] = 'file:./' + archive;
    }
    const store = await execute(process.execPath, [pnpm, 'store', 'path'], {
      cwd: resolve('.'),
      timeout: 8000,
    });
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'independent-generator-consumer',
        private: true,
        type: 'module',
        dependencies,
      }),
    );
    await writeFile(
      join(root, 'pnpm-workspace.yaml'),
      JSON.stringify({ packages: [], overrides: dependencies }),
    );
    await execute(
      process.execPath,
      [
        pnpm,
        'install',
        '--offline',
        '--ignore-scripts',
        '--config.auto-install-peers=false',
        '--store-dir',
        resolve(store.stdout.trim(), '..'),
      ],
      {
        cwd: root,
        timeout: 15000,
        maxBuffer: 512 * 1024,
      },
    );
    await cp(join(fixture, 'packages'), join(root, 'packages'), { recursive: true });
    await cp(join(fixture, 'tsconfig.host.json'), join(root, 'tsconfig.host.json'));
    const config = JSON.parse(await readFile(join(fixture, 'tsconfig.base.json'), 'utf8'));
    delete config.compilerOptions.paths['@axterm/plugin-api'];
    delete config.compilerOptions.paths['@deepseek-ai/cordis'];
    await writeFile(join(root, 'tsconfig.base.json'), JSON.stringify(config));
    await writeFile(
      join(root, 'generate.mjs'),
      `
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { WorkspaceTypertGenerator } from '@axterm/remote-generator';
import { typertPlugin } from '@axterm/remote-generator/tsdown';
const root = process.cwd();
await rename(root + '/tsconfig.host.json', root + '/tsconfig.remote-host.json');
const faceOptions = { hostConfig: 'tsconfig.remote-host.json' };
const artifacts = new WorkspaceTypertGenerator(root, faceOptions).generateContributors();
assert.equal(artifacts.length, 1);
const plugin = typertPlugin({ mode: 'workspace', faces: ['host'], ...faceOptions });
plugin.buildStart({ cwd: root });
await plugin.writeBundle({ dir: root + '/packages/remote/lib' });
const generated = await import('./packages/remote/lib/typert.remote-client.js');
assert.equal(generated.TYPERT_REMOTE.descriptors.length, 3);
const create = generated.TYPERT_REMOTE.methods['catalog/create'];
assert.equal(create.input().create().parse({ entryId: 'one', request: { title: 'created' } }).request.title, 'created');
assert.throws(() => create.input().create().parse({ entryId: 'one', request: { title: 42 } }));
assert.equal(await readFile(root + '/packages/remote/lib/typert.remote-client.d.ts', 'utf8'), artifacts[0].remote.dts);
const configPath = root + '/tsconfig.base.json';
const config = JSON.parse(await readFile(configPath, 'utf8'));
config.compilerOptions.paths['@fixture/catalog'] = ['./packages/catalog/lib/types/index.d.ts'];
await mkdir(root + '/packages/catalog/lib/types', { recursive: true });
await writeFile(root + '/packages/catalog/lib/types/index.d.ts', 'export declare class Entry { readonly id: string }');
await writeFile(configPath, JSON.stringify(config));
const failing = typertPlugin({ mode: 'workspace', faces: ['host'], ...faceOptions });
failing.buildStart({ cwd: root });
await assert.rejects(failing.writeBundle({ dir: root + '/packages/remote/lib' }), /build output/);
console.log('independent generator worker and SDK codecs passed');
`,
    );
    const result = await execute(process.execPath, ['generate.mjs'], {
      cwd: root,
      timeout: 12000,
      maxBuffer: 256 * 1024,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
    });
    expect(result.stdout).toContain('independent generator worker and SDK codecs passed');
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
