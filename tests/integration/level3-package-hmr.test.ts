import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
const execute = promisify(execFile);
for (const runtime of ['node', 'electron'])
  it(`invalidates and restores real CJS/ESM package-manifest caches in ${runtime}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-native-manifest-'));
    try {
      const pkg = join(root, 'node_modules/fixture-target');
      await mkdir(pkg, { recursive: true });
      await writeFile(
        join(pkg, 'package.json'),
        JSON.stringify({ name: 'fixture-target', exports: './a.cjs' }),
      );
      await writeFile(join(pkg, 'a.cjs'), 'module.exports="a";');
      await writeFile(join(pkg, 'b.cjs'), 'module.exports="b";');
      const consumer = join(root, 'consumer.mjs');
      await writeFile(
        consumer,
        'export async function read(){return (await import("fixture-target")).default;}',
      );
      const script = `
      import {createRequire} from 'node:module'; import {writeFile} from 'node:fs/promises';
      import {PackageManifests} from ${JSON.stringify(pathToFileURL(resolve('packages/infra/hmr/lib/types/package-manifest.js')).href)};
      const req=createRequire(${JSON.stringify(consumer)});
      const esm=await import(${JSON.stringify(pathToFileURL(consumer).href)});
      const cjs=req('internal/modules/cjs/loader').Module;
      const reader=req('internal/modules/package_json_reader');
      const before={load:cjs._load,nearest:reader.getNearestParentPackageJSON};
      const first=[req('fixture-target'),await esm.read()];
      await writeFile(${JSON.stringify(join(pkg, 'package.json'))},JSON.stringify({name:'fixture-target',exports:'./b.cjs'}));
      const stale=[req('fixture-target'),await esm.read()];
      const manifests=new PackageManifests(); manifests.invalidate(${JSON.stringify(join(pkg, 'package.json'))});
      const changed=[req('fixture-target'),await esm.read()];
      manifests.dispose(); manifests.dispose();
      console.log(JSON.stringify({first,stale,changed,restored:before.load===cjs._load&&before.nearest===reader.getNearestParentPackageJSON}));
    `;
      const executable =
        runtime === 'node'
          ? process.execPath
          : (createRequire(resolve('apps/desktop/package.json'))('electron') as string);
      const { stdout } = await execute(
        executable,
        ['--expose-internals', '--input-type=module', '-e', script],
        {
          timeout: 8000,
          env: { ...process.env, ...(runtime === 'electron' ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
        },
      );
      expect(JSON.parse(stdout.trim())).toEqual({
        first: ['a', 'a'],
        stale: ['a', 'a'],
        changed: ['b', 'b'],
        restored: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
