import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { deploymentFileAllowed } from '../../scripts/deployment-files.mjs';
import { inventoryPiBundleComponents, readPiBundleProof } from '../../scripts/pi-bundle.mjs';
import { piCommit } from '../../scripts/pi-source-provenance.mjs';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

it('omits deployment maps and development folders while preserving public types and required provenance', () => {
  const thirdParty = { name: 'fixture' };
  for (const file of [
    'lib/index.js.map',
    'tests/fixture.js',
    'examples/demo.js',
    'docs/readme.md',
    'node_modules/dependency/index.js',
  ])
    expect(deploymentFileAllowed(thirdParty, file, false)).toBe(false);
  for (const file of [
    'lib/index.js',
    'lib/index.d.ts',
    'lib/index.d.mts',
    'src/portable.ts',
    'LICENSE',
    'THIRD_PARTY_NOTICES/typebox-LICENSE',
  ])
    expect(deploymentFileAllowed(thirdParty, file, false)).toBe(true);
  expect(deploymentFileAllowed({ name: 'spice-client' }, 'dist/esm/index.js.map', false)).toBe(
    true,
  );
  expect(deploymentFileAllowed({ name: 'spice-client' }, 'dist/other.js.map', false)).toBe(false);
});

it('rejects a stale Pi output, altered upstream input, undeclared external and DSH source before omitting SDK dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'axterm-pi-proof-'));
  const directory = join(root, 'packages/pi-engine');
  const inputs = [
    'vendor/pi/packages/agent/src/agent-loop.ts',
    'vendor/pi/packages/ai/src/providers/all.ts',
    'scripts/build-pi-engine.mjs',
    'packages/pi-engine/package.json',
  ];
  const manifest = JSON.stringify({
    name: '@axterm/engine-pi-core',
    dependencies: { ws: '8.21.3' },
  });
  try {
    mkdirSync(join(directory, 'dist'), { recursive: true });
    for (const path of inputs) {
      mkdirSync(resolve(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), path.endsWith('package.json') ? manifest : 'fixture');
    }
    writeFileSync(join(directory, 'dist/index.js'), 'bundle');
    const proof = {
      format: 1,
      owner: '@axterm/engine-pi-core',
      sourceRevision: piCommit,
      bundle: { file: 'index.js', sha256: hash('bundle') },
      externals: ['ws'],
      inputs: inputs.map((path) => ({ path, sha256: hash(readFileSync(join(root, path))) })),
      components: [],
    };
    const save = (value = proof) =>
      writeFileSync(join(directory, 'dist/pi-bundle.json'), JSON.stringify(value));
    save();
    expect(readPiBundleProof(root, directory).externals).toEqual(['ws']);
    writeFileSync(join(directory, 'dist/index.js'), 'changed');
    expect(() => readPiBundleProof(root, directory)).toThrow('output differs');
    writeFileSync(join(directory, 'dist/index.js'), 'bundle');
    writeFileSync(join(root, inputs[0]!), 'changed');
    expect(() => readPiBundleProof(root, directory)).toThrow('input changed');
    writeFileSync(join(root, inputs[0]!), 'fixture');
    save({ ...proof, externals: ['ws', 'undeclared'] });
    expect(() => readPiBundleProof(root, directory)).toThrow('Invalid Pi bundle');
    save({
      ...proof,
      inputs: [...proof.inputs, { path: 'vendor/deepseek-harness/ai.ts', sha256: hash('fixture') }],
    });
    expect(() => readPiBundleProof(root, directory)).toThrow('Invalid Pi bundle');
    save({ ...proof, inputs: [...proof.inputs, { path: '../escape', sha256: hash('fixture') }] });
    expect(() => readPiBundleProof(root, directory)).toThrow('escapes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('inventories actual inlined SDK components and refuses changed bundles, notices and escaping paths', () => {
  const directory = '/node_modules/.axterm/' + 'a'.repeat(24) + '/package/';
  const notice = 'bundled-licenses/' + 'b'.repeat(24) + '/LICENSE';
  const files = new Map<string, Buffer>([
    [directory + 'package.json', Buffer.from(JSON.stringify({ name: '@axterm/engine-pi-core' }))],
    [directory + 'dist/index.js', Buffer.from('bundle')],
    [directory + 'dist/' + notice, Buffer.from('exact original notice')],
  ]);
  const component = {
    name: 'inlined-sdk',
    version: '1.2.3',
    license: 'MIT',
    licenseFiles: [{ name: 'LICENSE', path: notice, sha256: hash('exact original notice') }],
  };
  const proof = {
    format: 1,
    owner: '@axterm/engine-pi-core',
    sourceRevision: piCommit,
    bundle: { file: 'index.js', sha256: hash('bundle') },
    components: [component],
  };
  const save = (value = proof) =>
    files.set(directory + 'dist/pi-bundle.json', Buffer.from(JSON.stringify(value)));
  save();
  const inventory = () =>
    inventoryPiBundleComponents([...files.keys()], (name: string) => {
      const bytes = files.get(name);
      if (!bytes) throw new Error('Missing file: ' + name);
      return bytes;
    });
  expect(inventory()).toMatchObject([
    {
      name: 'inlined-sdk',
      version: '1.2.3',
      bundledIn: directory + 'dist/index.js',
      licenseFiles: [{ sha256: hash('exact original notice') }],
    },
  ]);
  files.set(directory + 'dist/index.js', Buffer.from('changed'));
  expect(inventory).toThrow('bundle bytes differ');
  files.set(directory + 'dist/index.js', Buffer.from('bundle'));
  files.set(directory + 'dist/' + notice, Buffer.from('changed notice'));
  expect(inventory).toThrow('license bytes differ');
  save({
    ...proof,
    components: [
      {
        ...component,
        licenseFiles: [
          { name: 'LICENSE', path: '../LICENSE', sha256: hash('exact original notice') },
        ],
      },
    ],
  });
  expect(inventory).toThrow('license path');
});
