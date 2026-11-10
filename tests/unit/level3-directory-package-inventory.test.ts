import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { inventoryDirectoryApplication } from '../../scripts/commercialization/directory-application-inventory.mjs';
import { inventoryPackagedResources } from '../../scripts/commercialization/packaged-license-inventory.mjs';
import {
  packagedArtifactSbomFromInventory,
  serializePackagedArtifactSbom,
} from '../../scripts/commercialization/generate-packaged-artifact-sbom.mjs';
import {
  verifyPackagedArtifactSbomFromInventory,
  packagedArtifactVerificationReceipt,
} from '../../scripts/commercialization/verify-packaged-artifact-sbom.mjs';

it('inventories a linked new package once and byte-verifies its physical JS, notices and native addon without an invented ASAR', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-l3-directory-inventory-'));
  const resources = join(root, 'resources');
  const app = join(resources, 'app');
  const physical = join(app, 'node_modules/.axterm/identity/package');
  try {
    await mkdir(join(physical, 'lib'), { recursive: true });
    await writeFile(
      join(physical, 'package.json'),
      JSON.stringify({ name: 'physical-fixture', version: '1.0.0', license: 'MIT' }),
    );
    await writeFile(join(physical, 'LICENSE'), 'Copyright physical fixture');
    await writeFile(join(physical, 'lib/client.js'), 'export const fixture = true;');
    await writeFile(join(physical, 'lib/addon.node'), Buffer.from([0, 1, 255]));
    await symlink(
      physical,
      join(app, 'node_modules/fixture'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(join(root, 'LICENSE.axterm'), 'application fixture');
    const first = inventoryDirectoryApplication(app);
    expect(first.files).toHaveLength(4);
    expect(first.links).toHaveLength(1);
    expect(inventoryDirectoryApplication(app).sha256).toBe(first.sha256);
    const inventory = inventoryPackagedResources(resources);
    expect(inventory).not.toHaveProperty('archiveSha256');
    expect(inventory.packageInstances).toBe(1);
    expect(inventory.packages[0]).toMatchObject({
      name: 'physical-fixture',
      version: '1.0.0',
      license: 'MIT',
    });
    expect(inventory.externalLegalFiles).toHaveLength(1);
    const product = { name: 'axterm', version: '0.10.0' };
    const sbom = packagedArtifactSbomFromInventory(inventory, product, 'test-platform');
    expect(
      sbom.files.some((file: { fileName: string }) => file.fileName.endsWith('/lib/addon.node')),
    ).toBe(true);
    expect(sbom.files.some((file: { fileName: string }) => /app\.asar/.test(file.fileName))).toBe(
      false,
    );
    const sidecar = await serializePackagedArtifactSbom(sbom);
    const result = await verifyPackagedArtifactSbomFromInventory(
      inventory,
      product,
      'test-platform',
      sidecar,
    );
    expect(result.applicationDirectorySha256).toBe(first.sha256);
    const receipt = packagedArtifactVerificationReceipt(
      'fixture.spdx.json',
      sidecar,
      result,
      product,
      'test-platform',
    );
    expect(receipt).toMatchObject({ appDirectoryInventorySha256: first.sha256 });
    expect(receipt).not.toHaveProperty('appAsarSha256');
    await writeFile(join(physical, 'lib/client.js'), 'tampered');
    expect(inventoryDirectoryApplication(app).sha256).not.toBe(first.sha256);
    await expect(
      verifyPackagedArtifactSbomFromInventory(
        inventoryPackagedResources(resources),
        product,
        'test-platform',
        sidecar,
      ),
    ).rejects.toThrow('does not match');
    expect(await readFile(join(physical, 'LICENSE'), 'utf8')).toBe('Copyright physical fixture');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses an escaping link, broken alias and linked root rather than omitting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-l3-directory-refusal-'));
  try {
    const app = join(root, 'app');
    await mkdir(app);
    await writeFile(join(root, 'private'), 'outside');
    await symlink(join(root, 'private'), join(app, 'escape'));
    expect(() => inventoryDirectoryApplication(app)).toThrow('escapes');
    await rm(join(app, 'escape'));
    await symlink(join(root, 'missing'), join(app, 'broken'));
    expect(() => inventoryDirectoryApplication(app)).toThrow();
    await rm(join(app, 'broken'));
    await symlink(app, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => inventoryDirectoryApplication(join(root, 'alias'))).toThrow('root must not');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('detects native foreign prebuilds inside the hashed physical store rather than only traditional node_modules names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-l3-native-prebuild-inventory-'));
  try {
    const physical = join(root, 'resources/app/node_modules/.axterm/native/package');
    await mkdir(join(physical, 'prebuilds/foreign'), { recursive: true });
    await writeFile(
      join(physical, 'package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.1.0', license: 'MIT' }),
    );
    await writeFile(join(physical, 'prebuilds/foreign/pty.node'), 'foreign fixture');
    const report = inventoryPackagedResources(join(root, 'resources'));
    if (!('nativePrebuildFiles' in report)) throw new Error('Expected directory inventory');
    expect(report.nativePrebuildFiles).toEqual([
      '/node_modules/.axterm/native/package/prebuilds/foreign/pty.node',
    ]);
    expect(report.archivedPrebuildFiles).toEqual(report.nativePrebuildFiles);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
