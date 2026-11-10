import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { ironRdpArtifactViolations } from '../../scripts/commercialization/ironrdp-wasm-source-scope.mjs';
import { packagedBinary } from '../../scripts/commercialization/verify-fs-safe-macos-provenance.mjs';

it('requires the actual unique owned RDP factory in a directory package, preserving all original legal and vendor-identity checks', async () => {
  const names = [
    'IronRDP-RUST-ROOT-LICENSES.txt',
    'IronRDP-MISSING-CRATE-ROOT-LICENSES.txt',
    'tracing-core-spin-LICENSE.txt',
    'IronRDP-SOURCE-HEADER-ATTRIBUTIONS.txt',
    'IronRDP-LICENSE-APACHE.txt',
  ];
  const externalLegalFiles = await Promise.all(
    names.map(async (name) => ({
      path: 'licenses/' + name,
      sha256: createHash('sha256')
        .update(await readFile(resolve('licenses', name)))
        .digest('hex'),
    })),
  );
  const owner = {
    name: '@axterm/plugin-remote-desktop',
    version: '0.10.0',
    manifestPath: '/node_modules/.axterm/' + 'a'.repeat(24) + '/package/package.json',
  };
  const factory = owner.manifestPath.replace('package.json', 'lib/client.browser.js');
  const packaged = {
    applicationDirectory: { sha256: 'b'.repeat(64) },
    packages: [
      {
        name: '@devolutions/iron-remote-desktop-rdp',
        version: '0.7.0',
        manifestPath: '/vendor/package.json',
      },
      owner,
    ],
    externalLegalFiles,
    rendererAssetFiles: [{ path: factory, sha256: 'c'.repeat(64) }],
  };
  expect(ironRdpArtifactViolations(packaged)).toEqual([]);
  expect(
    ironRdpArtifactViolations({
      ...packaged,
      rendererAssetFiles: [
        { path: '/out/renderer/assets/iron-remote-desktop-rdp-old.js', sha256: 'c'.repeat(64) },
      ],
    }),
  ).toContain('Expected one packaged IronRDP Renderer bundle');
  expect(
    ironRdpArtifactViolations({ ...packaged, packages: [...packaged.packages, owner] }),
  ).toContain('Expected one packaged IronRDP Renderer bundle');
  expect(
    ironRdpArtifactViolations({
      ...packaged,
      rendererAssetFiles: [...packaged.rendererAssetFiles, ...packaged.rendererAssetFiles],
    }),
  ).toContain('Expected one packaged IronRDP Renderer bundle');
  expect(ironRdpArtifactViolations({ ...packaged, externalLegalFiles: [] })).toContain(
    'Packaged IronRDP Rust root legal texts differ',
  );
  expect(ironRdpArtifactViolations({ ...packaged, packages: [owner] })).toContain(
    'Packaged IronRDP npm identity is missing',
  );
});

it('reads the exact native helper from the new physical closure and rejects mismatched platform package versions', async () => {
  const app = await mkdtemp(join(tmpdir(), 'axterm-l3-native-audit-reader-'));
  const directory = join(app, 'Contents/Resources/app');
  const id = 'd'.repeat(24),
    name = '@openclaw/fs-safe-darwin-arm64';
  const physical = join(directory, 'node_modules/.axterm', id, 'package');
  try {
    await mkdir(physical, { recursive: true });
    const marker = (version: string) =>
      Promise.all([
        writeFile(
          join(directory, 'LEVEL3_PACKAGE.json'),
          JSON.stringify({
            purpose: 'migration-validation',
            productCutover: false,
            packages: [{ name, version, id }],
          }),
        ),
        writeFile(join(physical, 'package.json'), JSON.stringify({ name, version })),
      ]);
    const bytes = Buffer.from('fixture reader bytes; not a native execution claim');
    await writeFile(join(physical, 'fs-safe-native.node'), bytes);
    await marker('0.13.1');
    expect(await packagedBinary(app)).toEqual(bytes);
    await marker('0.13.2');
    await expect(packagedBinary(app)).rejects.toThrow('identity mismatch');
  } finally {
    await rm(app, { recursive: true, force: true });
  }
});
