import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  ownedProtocolRoot,
  verifyNoVncProof,
  verifySpiceProof,
} from '../../scripts/commercialization/owned-protocol-provenance.mjs';
import { buildNoVncSourceNotices } from '../../scripts/commercialization/generate-novnc-source-notices.mjs';
import { buildSpiceClientProvenance } from '../../packages/plugins/remote-desktop/build-client-assets.mjs';
import { buildSpiceSourceNotices } from '../../scripts/commercialization/generate-spice-source-notices.mjs';
const lib = resolve('packages/plugins/remote-desktop/lib');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

it('verifies all52 real noVNC inputs and refuses changed input, wrong identity, tampered bytes and traversal before reading an asset', async () => {
  const { modules } = await buildNoVncSourceNotices();
  const bytes = await readFile(join(lib, 'protocol-assets/novnc-provenance.json'));
  const proof = JSON.parse(bytes.toString());
  const read = (path: string) => readFile(join(lib, 'protocol-assets', path));
  expect(await verifyNoVncProof(bytes, modules, read)).toMatchObject({ sources: 52 });
  await expect(
    verifyNoVncProof(bytes, modules, async () => Buffer.from('tampered')),
  ).rejects.toThrow('differs from build-time hash');
  await expect(
    verifyNoVncProof(encode({ ...proof, package: 'wrong@1.0.0' }), modules, read),
  ).rejects.toThrow('identity');
  await expect(
    verifyNoVncProof(
      bytes,
      modules.map((row, index) => (index ? row : { ...row, sha256: '0'.repeat(64) })),
      read,
    ),
  ).rejects.toThrow('identity');
  let reads = 0;
  await expect(
    verifyNoVncProof(encode({ ...proof, file: '../../private' }), modules, async () => {
      reads++;
      return Buffer.alloc(0);
    }),
  ).rejects.toThrow('asset path');
  expect(reads).toBe(0);
  const legacy = {
    schemaVersion: 1,
    package: proof.package,
    sources: proof.sources.map((source: { path: string; sha256: string }) => ({
      ...source,
      chunks: ['assets/rfb-fixture.js'],
    })),
    chunks: [{ path: 'assets/rfb-fixture.js', sha256: proof.sha256 }],
  };
  expect(
    await verifyNoVncProof(encode(legacy), modules, () => read(proof.file), true),
  ).toMatchObject({ sources: 52 });
  await expect(
    verifyNoVncProof(
      encode({ ...legacy, chunks: [{ ...legacy.chunks[0], path: '../private' }] }),
      modules,
      read,
      true,
    ),
  ).rejects.toThrow('chunk path');
});

it('binds all30 SPICE source-map inputs and the observed entry to the actual factory, rejecting wrong maps, duplicate outputs and traversal', async () => {
  const expected = await buildSpiceSourceNotices();
  const bytes = await readFile(join(lib, 'protocol-assets/spice-provenance.json'));
  const proof = JSON.parse(bytes.toString());
  const read = (path: string) => readFile(join(lib, path));
  expect(await verifySpiceProof(bytes, expected, read)).toMatchObject({ sources: 30 });
  await expect(
    verifySpiceProof(bytes, expected, async () => Buffer.from('tampered')),
  ).rejects.toThrow('differs from build-time hash');
  await expect(
    verifySpiceProof(encode({ ...proof, sourceMapSha256: '0'.repeat(64) }), expected, read),
  ).rejects.toThrow('source-map');
  await expect(
    verifySpiceProof(
      encode({ ...proof, chunks: [...proof.chunks, ...proof.chunks] }),
      expected,
      read,
    ),
  ).rejects.toThrow('factory path');
  let reads = 0;
  await expect(
    verifySpiceProof(
      encode({ ...proof, chunks: [{ ...proof.chunks[0], path: '../private' }] }),
      expected,
      async () => {
        reads++;
        return Buffer.alloc(0);
      },
    ),
  ).rejects.toThrow('factory path');
  expect(reads).toBe(0);
  const legacy = {
    ...proof,
    chunks: [{ ...proof.chunks[0], path: 'assets/spice-client-fixture.js' }],
  };
  expect(
    await verifySpiceProof(encode(legacy), expected, () => read('client.browser.js'), true),
  ).toMatchObject({ sources: 30 });
  await expect(
    verifySpiceProof(
      encode({ ...legacy, chunks: [{ ...legacy.chunks[0], path: '../../private.js' }] }),
      expected,
      read,
      true,
    ),
  ).rejects.toThrow('factory path');
});

it('resolves exactly one physical protocol owner and refuses wrong names, invalid locators and escaping package links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-l3-protocol-owner-'));
  const resources = join(directory, 'resources'),
    app = join(resources, 'app'),
    id = 'a'.repeat(24);
  const physical = join(app, 'node_modules/.axterm', id, 'package');
  const record = { name: '@axterm/plugin-remote-desktop', version: '0.10.0', id };
  const inventory = (
    packages: unknown[],
    mode = { purpose: 'migration-validation', productCutover: false },
  ) => writeFile(join(app, 'LEVEL3_PACKAGE.json'), JSON.stringify({ ...mode, packages }));
  try {
    await mkdir(join(physical, 'lib'), { recursive: true });
    await writeFile(join(physical, 'package.json'), JSON.stringify(record));
    await inventory([record]);
    expect(await ownedProtocolRoot(resources)).toBe(join(physical, 'lib'));
    await inventory([record], { purpose: 'desktop-application', productCutover: true });
    expect(await ownedProtocolRoot(resources)).toBe(join(physical, 'lib'));
    for (const mode of [
      { purpose: 'desktop-application', productCutover: false },
      { purpose: 'migration-validation', productCutover: true },
      { purpose: 'unknown', productCutover: true },
    ]) {
      await inventory([record], mode);
      await expect(ownedProtocolRoot(resources)).rejects.toThrow('Invalid application inventory');
    }
    await inventory([record]);
    await inventory([record, record]);
    await expect(ownedProtocolRoot(resources)).rejects.toThrow('Ambiguous');
    await inventory([{ ...record, id: '../private' }]);
    await expect(ownedProtocolRoot(resources)).rejects.toThrow('Ambiguous');
    await inventory([record]);
    await writeFile(join(physical, 'package.json'), JSON.stringify({ ...record, name: 'wrong' }));
    await expect(ownedProtocolRoot(resources)).rejects.toThrow('identity mismatch');
    await rm(physical, { recursive: true });
    await mkdir(join(directory, 'outside'));
    await symlink(
      join(directory, 'outside'),
      physical,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(ownedProtocolRoot(resources)).rejects.toThrow('escapes');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('refuses a build that did not actually observe the SPICE entry or observed a different package identity', async () => {
  await expect(buildSpiceClientProvenance('/nonexistent-output', [])).rejects.toThrow(
    'ENTRY_MISSING',
  );
  const directory = await mkdtemp(join(tmpdir(), 'axterm-l3-spice-build-refusal-'));
  try {
    const entry = join(directory, 'spice-client/dist/esm/index.js');
    await mkdir(join(directory, 'spice-client/dist/esm'), { recursive: true });
    await writeFile(
      join(directory, 'spice-client/package.json'),
      JSON.stringify({ name: 'spice-client', version: 'wrong' }),
    );
    await expect(buildSpiceClientProvenance(join(directory, 'output'), [entry])).rejects.toThrow(
      'IDENTITY',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
