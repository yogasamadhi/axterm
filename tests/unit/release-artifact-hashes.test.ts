import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseArtifactHashManifest } from '../../scripts/commercialization/generate-release-artifact-hashes.mjs';
import { verifyAppImageRuntimeArtifact } from '../../scripts/commercialization/verify-appimage-runtime-artifact.mjs';
import {
  releaseArtifactVerificationReceipt,
  verifyReleaseArtifactHashManifest,
} from '../../scripts/commercialization/verify-release-artifact-hashes.mjs';

const directories: string[] = [];

async function releaseDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-release-hashes-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('release artifact hash manifest', () => {
  it('records only the expected current-product artifacts for one platform', async () => {
    const directory = await releaseDirectory();
    await writeFile(join(directory, 'Axterm-0.10.0-arm64.dmg'), 'dmg bytes');
    await writeFile(join(directory, 'Axterm-0.10.0-arm64-mac.zip'), 'zip bytes');
    await writeFile(join(directory, 'Axterm-0.10.0-arm64.dmg.blockmap'), 'sidecar');
    await writeFile(join(directory, 'Axoterm-0.10.0-arm64.dmg'), 'wrong product');
    await writeFile(join(directory, 'Axterm-0.10.0-arm64.AppImage'), 'wrong platform');

    const manifest = releaseArtifactHashManifest(directory, 'macos-arm64', {
      name: 'Axterm',
      version: '0.10.0',
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      product: { name: 'Axterm', version: '0.10.0' },
      platform: 'macos-arm64',
      artifacts: [
        { path: 'Axterm-0.10.0-arm64-mac.zip', bytes: 9 },
        { path: 'Axterm-0.10.0-arm64.dmg', bytes: 9 },
      ],
    });
    expect(manifest.artifacts.map(({ sha256 }) => sha256)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/u),
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    ]);
  });

  it('rejects a missing or incompatible platform artifact set', async () => {
    const directory = await releaseDirectory();
    await writeFile(join(directory, 'Axterm-0.10.0-arm64.dmg'), 'dmg bytes');

    expect(() =>
      releaseArtifactHashManifest(directory, 'windows-x64', { name: 'Axterm', version: '0.10.0' }),
    ).toThrow(/No windows-x64 Axterm artifacts/u);
    expect(() =>
      releaseArtifactHashManifest(directory, 'unknown', { name: 'Axterm', version: '0.10.0' }),
    ).toThrow(/Unsupported release platform/u);
  });

  it('verifies that the post-test artifacts still match the generated manifest', async () => {
    const directory = await releaseDirectory();
    const manifestPath = join(directory, 'AXTERM_RELEASE_ARTIFACTS.linux-x64.json');
    await writeFile(join(directory, 'Axterm-0.10.0.AppImage'), 'app image bytes');
    await writeFile(join(directory, 'axterm_0.10.0_amd64.deb'), 'deb bytes');
    const product = { name: 'axterm', version: '0.10.0' };
    const manifest = releaseArtifactHashManifest(directory, 'linux-x64', product);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(
      verifyReleaseArtifactHashManifest(directory, manifestPath, 'linux-x64', product),
    ).toEqual(manifest);
  });

  it('binds a launched AppImage copy to the exact Linux release artifact bytes', async () => {
    const directory = await releaseDirectory();
    await writeFile(join(directory, 'Axterm-0.10.0.AppImage'), 'app image bytes');
    await writeFile(join(directory, 'axterm_0.10.0_amd64.deb'), 'deb bytes');
    const manifest = releaseArtifactHashManifest(directory, 'linux-x64', {
      name: 'axterm',
      version: '0.10.0',
    });
    const observed = {
      name: 'Axterm-0.10.0.AppImage',
      bytes: 15,
      sha256: createHash('sha256').update('app image bytes').digest('hex'),
    };
    const appImage = manifest.artifacts.find(({ path }) => path.endsWith('.AppImage'))!;
    expect(verifyAppImageRuntimeArtifact(manifest, '0.10.0', observed)).toEqual(appImage);
    for (const changed of [
      { ...observed, name: 'other.AppImage' },
      { ...observed, bytes: observed.bytes - 1 },
      { ...observed, sha256: '0'.repeat(64) },
    ]) {
      expect(() => verifyAppImageRuntimeArtifact(manifest, '0.10.0', changed)).toThrow(
        /executed AppImage bytes do not match/u,
      );
    }
    expect(() => verifyAppImageRuntimeArtifact(manifest, '0.10.1', observed)).toThrow(
      /wrong product, version or platform/u,
    );
    expect(() =>
      verifyAppImageRuntimeArtifact({ ...manifest, platform: 'macos-arm64' }, '0.10.0', observed),
    ).toThrow(/wrong product, version or platform/u);
    expect(() =>
      verifyAppImageRuntimeArtifact(
        { ...manifest, artifacts: [...manifest.artifacts, appImage] },
        '0.10.0',
        observed,
      ),
    ).toThrow(/Expected one AppImage/u);
  });

  it('writes a deterministic receipt only after downloaded bytes match the manifest', async () => {
    const directory = await releaseDirectory();
    const manifestPath = join(directory, 'AXTERM_RELEASE_ARTIFACTS.linux-x64.json');
    const receiptPath = join(directory, 'AXTERM_UPLOAD_ROUNDTRIP.linux-x64.json');
    const appImagePath = join(directory, 'Axterm-0.10.0.AppImage');
    await writeFile(appImagePath, 'app image bytes');
    await writeFile(join(directory, 'axterm_0.10.0_amd64.deb'), 'deb bytes');
    const product = { name: 'axterm', version: '0.10.0' };
    const manifest = releaseArtifactHashManifest(directory, 'linux-x64', product);
    const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestPath, manifestContents);

    expect(releaseArtifactVerificationReceipt(manifestPath, manifest)).toMatchObject({
      schemaVersion: 1,
      verification: 'release-artifact-byte-verification',
      product,
      platform: 'linux-x64',
      manifest: {
        path: 'AXTERM_RELEASE_ARTIFACTS.linux-x64.json',
        bytes: Buffer.byteLength(manifestContents),
        sha256: createHash('sha256').update(manifestContents).digest('hex'),
      },
      artifacts: manifest.artifacts,
    });

    const output = execFileSync(
      process.execPath,
      [
        resolve('scripts/commercialization/verify-release-artifact-hashes.mjs'),
        directory,
        '--platform',
        'linux-x64',
        '--manifest',
        manifestPath,
        '--receipt',
        receiptPath,
      ],
      { encoding: 'utf8' },
    );
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>;
    expect(output).toContain('Wrote release artifact verification receipt:');
    expect(receipt).toEqual(releaseArtifactVerificationReceipt(manifestPath, manifest));

    for (const protectedPath of [manifestPath, appImagePath]) {
      expect(() =>
        execFileSync(
          process.execPath,
          [
            resolve('scripts/commercialization/verify-release-artifact-hashes.mjs'),
            directory,
            '--platform',
            'linux-x64',
            '--manifest',
            manifestPath,
            '--receipt',
            protectedPath,
          ],
          { stdio: 'pipe' },
        ),
      ).toThrow();
    }
  });

  it('rejects changed, added or policy-tampered artifact manifests', async () => {
    const directory = await releaseDirectory();
    const manifestPath = join(directory, 'AXTERM_RELEASE_ARTIFACTS.macos-arm64.json');
    const dmgPath = join(directory, 'Axterm-0.10.0-arm64.dmg');
    const product = { name: 'Axterm', version: '0.10.0' };
    await writeFile(dmgPath, 'original dmg bytes');
    const manifest = releaseArtifactHashManifest(directory, 'macos-arm64', product);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await writeFile(dmgPath, 'changed dmg bytes');
    expect(() =>
      verifyReleaseArtifactHashManifest(directory, manifestPath, 'macos-arm64', product),
    ).toThrow(/byte count[\s\S]*SHA-256/u);

    await writeFile(dmgPath, 'original dmg bytes');
    const lateZipPath = join(directory, 'Axterm-0.10.0-arm64-mac.zip');
    await writeFile(lateZipPath, 'late zip bytes');
    expect(() =>
      verifyReleaseArtifactHashManifest(directory, manifestPath, 'macos-arm64', product),
    ).toThrow(/artifact is missing from manifest: Axterm-0.10.0-arm64-mac.zip/u);

    await rm(lateZipPath);
    const tamperedManifest = {
      ...manifest,
      platform: 'windows-x64',
      artifacts: manifest.artifacts.map((artifact, index) =>
        index === 0 ? { ...artifact, assertedBy: 'unreviewed' } : artifact,
      ),
      extraApproval: true,
    };
    await writeFile(manifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`);
    expect(() =>
      verifyReleaseArtifactHashManifest(directory, manifestPath, 'macos-arm64', product),
    ).toThrow(/platform[\s\S]*unexpected field: assertedBy[\s\S]*unexpected field: extraApproval/u);
  });
});
