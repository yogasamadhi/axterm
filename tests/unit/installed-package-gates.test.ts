import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const linuxGatePath = resolve('scripts/test-linux-deb.sh');
const linuxAppImageRuntimePath = resolve('scripts/test-linux-appimage.sh');
const macosGatePath = resolve('scripts/test-macos-dmg.sh');
const desktopPackagePath = resolve('scripts/package-desktop.mjs');
const windowsGatePath = resolve('scripts/test-windows-nsis.ps1');
const linuxGate = readFileSync(linuxGatePath, 'utf8');
const linuxAppImageRuntime = readFileSync(linuxAppImageRuntimePath, 'utf8');
const macosGate = readFileSync(macosGatePath, 'utf8');
const windowsGate = readFileSync(windowsGatePath, 'utf8');
const workflow = readFileSync(resolve('.github/workflows/check.yml'), 'utf8');
const packaging = readFileSync(resolve('apps/desktop/electron-builder.yml'), 'utf8');
const packagedSuite = readFileSync(resolve('tests/e2e/packaged.spec.ts'), 'utf8');
const rootPackage = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('installed package gates', () => {
  it('rejects unsafe isolated desktop package output before rebuilding native modules', () => {
    for (const args of [
      ['--output'],
      ['--output', 'release'],
      ['--output', resolve('.')],
      ['--output', resolve('.'), '--output', resolve('.')],
    ]) {
      const result = spawnSync(process.execPath, [desktopPackagePath, ...args], {
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Package output|Unknown or repeated package option/u);
      expect(result.stdout).not.toContain('electron-builder');
    }
  });

  it('installs the sole Linux x64 DEB, tests /opt/Axterm and removes only axterm', () => {
    execFileSync('sh', ['-n', linuxGatePath]);
    expect(linuxGate).toContain('dpkg --print-architecture');
    expect(linuxGate).toContain('for required_command in curl xvfb-run python3');
    expect(linuxGate).toContain('The DEB installation gate requires Python GI with GTK 3');
    expect(linuxGate).toContain('Refusing to replace a pre-existing installed axterm package.');
    expect(linuxGate).toContain('apt-get install -y --no-install-recommends "$deb_path"');
    expect(linuxGate).toContain('installed_root=/opt/Axterm');
    expect(linuxGate).toContain(
      'AXTERM_DEB_PATH="$deb_path" AXTERM_PACKAGED_APP="$installed_root"',
    );
    expect(linuxGate).toContain('AXTERM_PACKAGED_APP="$installed_root"');
    expect(linuxGate).toContain('apt-get remove -y axterm');
    expect(packagedSuite).toContain(
      "process.env.AXTERM_DEB_PATH ?? 'release/axterm_0.10.0_amd64.deb'",
    );
    expect(packaging).toMatch(/^ {4}- udev$/mu);
  });

  it('compares every installed app with its packaged SPDX sidecar before journeys', () => {
    execFileSync('sh', ['-n', macosGatePath]);
    execFileSync('sh', ['-n', linuxGatePath]);
    expect(macosGate).toContain('AXTERM_PACKAGED_ARTIFACTS.macos-arm64.spdx.json');
    expect(macosGate).toContain(
      'sbom:packaged:check -- "$installed_app/Contents/Resources" --platform macos-arm64',
    );
    expect(linuxGate).toContain('AXTERM_PACKAGED_ARTIFACTS.linux-x64.spdx.json');
    expect(linuxGate).toContain(
      'sbom:packaged:check -- "$installed_root/resources" --platform linux-x64',
    );
    expect(windowsGate).toContain('AXTERM_PACKAGED_ARTIFACTS.windows-x64.spdx.json');
    expect(windowsGate).toContain(
      'sbom:packaged:check -- $installedResources --platform windows-x64',
    );
    for (const gate of [macosGate, linuxGate, windowsGate]) {
      expect(gate.indexOf('sbom:packaged:check')).toBeLessThan(gate.indexOf('test:packaged'));
    }
  });

  it('uses a validated temporary Windows directory and exercises the installed NSIS app', () => {
    expect(windowsGate).toContain('if (-not $IsWindows)');
    expect(windowsGate).toContain('Refusing unsafe NSIS installation directory');
    expect(windowsGate).toContain("Join-Path $installDirectory 'Axterm.exe'");
    expect(windowsGate).toContain("-Filter 'Uninstall*.exe'");
    expect(windowsGate).toContain('$env:AXTERM_PACKAGED_APP = $installDirectory');
    expect(windowsGate).toContain('& bun run test:packaged');
    expect(windowsGate).toContain('Remove-Item -LiteralPath $installDirectory -Recurse -Force');
  });

  it('routes Linux and Windows CI through their real installer gates', () => {
    expect(rootPackage.scripts['test:deb:linux']).toBe('sh scripts/test-linux-deb.sh');
    expect(rootPackage.scripts['test:appimage:linux']).toBe(
      'node scripts/commercialization/verify-linux-appimage.mjs',
    );
    expect(rootPackage.scripts['test:appimage:linux:runtime']).toBe(
      'sh scripts/test-linux-appimage.sh',
    );
    expect(rootPackage.scripts['test:nsis:windows']).toBe(
      'pwsh -NoProfile -File scripts/test-windows-nsis.ps1',
    );
    expect(workflow).toContain('run: bun run test:deb:linux');
    expect(workflow).toContain('run: bun run test:appimage:linux');
    expect(workflow).toContain(
      'sudo apt-get install -y curl xvfb x11-utils python3-gi gir1.2-gtk-3.0 squashfs-tools',
    );
    expect(workflow).toContain('run: bun run test:nsis:windows');
  });

  it('checks the AppImage payload before upload and again after download', () => {
    const firstCheck = workflow.indexOf('run: bun run test:appimage:linux');
    const upload = workflow.indexOf('uses: actions/upload-artifact');
    const downloadedCheck = workflow.indexOf(
      'run: bun run test:appimage:linux -- --artifact-dir downloaded-release',
    );
    const download = workflow.indexOf('name: Download uploaded SPDX sidecar for byte verification');
    expect(firstCheck).toBeGreaterThan(workflow.indexOf('run: bun run package'));
    expect(firstCheck).toBeLessThan(upload);
    expect(downloadedCheck).toBeGreaterThan(download);
    expect(workflow.match(/run: bun run test:appimage:linux(?:$| --)/gmu)).toHaveLength(2);
  });

  it('runs the real AppImage under Linux x64 before upload and after download', () => {
    execFileSync('sh', ['-n', linuxAppImageRuntimePath]);
    expect(linuxAppImageRuntime).toContain('"$(uname -s)" != \'Linux\'');
    expect(linuxAppImageRuntime).toContain('"$(uname -m)" != \'x86_64\'');
    expect(linuxAppImageRuntime).toContain('"$#" -ne 1');
    expect(linuxAppImageRuntime).toContain('[ -L "$1" ]');
    expect(linuxAppImageRuntime).toContain('AXTERM_APPIMAGE_PATH="$artifact_path"');
    expect(linuxAppImageRuntime).toContain('AXTERM_APPIMAGE_RUNTIME_RECEIPT=');
    expect(linuxAppImageRuntime).toContain('APPIMAGE_EXTRACT_AND_RUN=1');
    expect(linuxAppImageRuntime).toContain('xvfb-run -a');
    expect(packagedSuite).toContain('await copyFile(resolve(appImagePath!), copiedAppImage)');
    expect(packagedSuite).toContain('await chmod(copiedAppImage, 0o755)');
    expect(packagedSuite).toContain('executablePath: copiedAppImage');
    expect(packagedSuite).toContain('electronApp.getVersion()');
    expect(packagedSuite).toContain("toHaveAttribute('data-state', 'ready')");
    expect(packagedSuite).toContain('createReadStream(copiedAppImage)');
    expect(packagedSuite).toContain('verifyAppImageRuntimeArtifact(');
    const firstRuntime = workflow.indexOf('run: bun run test:appimage:linux:runtime');
    const firstStatic = workflow.indexOf('run: bun run test:appimage:linux\n');
    const upload = workflow.indexOf('uses: actions/upload-artifact');
    const downloadedRuntime = workflow.indexOf(
      'run: bun run test:appimage:linux:runtime -- --artifact-dir downloaded-release',
    );
    const downloadedStatic = workflow.indexOf(
      'run: bun run test:appimage:linux -- --artifact-dir downloaded-release',
    );
    expect(firstRuntime).toBeGreaterThan(firstStatic);
    expect(firstRuntime).toBeLessThan(upload);
    expect(downloadedRuntime).toBeGreaterThan(downloadedStatic);
    expect(workflow.match(/run: bun run test:appimage:linux:runtime/gmu)).toHaveLength(2);
    expect(workflow).toContain('downloaded-release/AXTERM_APPIMAGE_RUNTIME.*.json');
  });

  it('retains the opt-in historical-package upgrade and retired-format rejection gates', () => {
    expect(packagedSuite).toContain('AXTERM_PREVIOUS_AXOTERM_APP');
    expect(packagedSuite).toContain('AXTERM_PREVIOUS_PACKAGED_APP');
    expect(packagedSuite).toContain(
      'current Mac package rejects a portable file produced by the preserved Axoterm package',
    );
    expect(packagedSuite).toContain(
      'current packaged app upgrades data produced by a historical packaged release',
    );
    expect(packagedSuite).toContain('`${databasePath}.pre-migration-34.bak`');
    expect(packagedSuite).toContain('oldPortableRejectedWithoutWrites: true');
    expect(packagedSuite).toContain('coldBackupPreserved: true');
    expect(packagedSuite).toContain('localVaultPreserved: true');
    expect(packagedSuite).toContain('oldSyncProfileInert: true');
  });

  it('rechecks distributable bytes after installed tests and before artifact upload', () => {
    expect(rootPackage.scripts['release:hashes:check']).toBe(
      'node scripts/commercialization/verify-release-artifact-hashes.mjs',
    );
    for (const [platform, manifest] of [
      ['macos-arm64', 'AXTERM_RELEASE_ARTIFACTS.macos-arm64.json'],
      ['windows-x64', 'AXTERM_RELEASE_ARTIFACTS.windows-x64.json'],
      ['linux-x64', 'AXTERM_RELEASE_ARTIFACTS.linux-x64.json'],
    ]) {
      expect(workflow).toContain(
        `bun run release:hashes:check -- release --platform ${platform} --manifest release/${manifest}`,
      );
    }
    expect(workflow.indexOf('bun run release:hashes:check')).toBeGreaterThan(
      workflow.indexOf('run: bun run test:dmg:macos'),
    );
    expect(workflow.indexOf('bun run release:hashes:check')).toBeLessThan(
      workflow.indexOf('uses: actions/upload-artifact'),
    );
  });

  it('downloads uploaded installers, hashes and SPDX; verifies their bytes and retains receipts', () => {
    const downloadAction =
      'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0';
    expect(workflow.match(new RegExp(downloadAction, 'gu'))).toHaveLength(3);
    expect(workflow).toContain('name: packaged-installers-${{ matrix.os }}');
    expect(workflow).toContain('name: packaged-artifact-hashes-${{ matrix.os }}');
    expect(workflow).toContain('name: packaged-sbom-${{ matrix.os }}');
    for (const [platform, manifest] of [
      ['macos-arm64', 'AXTERM_RELEASE_ARTIFACTS.macos-arm64.json'],
      ['windows-x64', 'AXTERM_RELEASE_ARTIFACTS.windows-x64.json'],
      ['linux-x64', 'AXTERM_RELEASE_ARTIFACTS.linux-x64.json'],
    ]) {
      expect(workflow).toContain(
        `bun run release:hashes:check -- downloaded-release --platform ${platform} --manifest downloaded-release/${manifest} --receipt downloaded-release/AXTERM_UPLOAD_ROUNDTRIP.${platform}.json`,
      );
      expect(workflow).toContain(
        `--platform ${platform} --sidecar downloaded-release/AXTERM_PACKAGED_ARTIFACTS.${platform}.spdx.json --receipt downloaded-release/AXTERM_SPDX_UPLOAD_ROUNDTRIP.${platform}.json`,
      );
    }

    const downloadIndex = workflow.indexOf('uses: actions/download-artifact');
    const downloadedVerificationIndex = workflow.indexOf(
      'bun run release:hashes:check -- downloaded-release',
    );
    const downloadedSpdxVerificationIndex = workflow.indexOf(
      '--sidecar downloaded-release/AXTERM_PACKAGED_ARTIFACTS.',
    );
    const receiptUploadIndex = workflow.indexOf('name: packaged-upload-roundtrip-${{ matrix.os }}');
    expect(downloadIndex).toBeGreaterThan(
      workflow.indexOf('name: packaged-artifact-hashes-${{ matrix.os }}'),
    );
    expect(downloadedVerificationIndex).toBeGreaterThan(downloadIndex);
    expect(downloadedSpdxVerificationIndex).toBeGreaterThan(downloadedVerificationIndex);
    expect(receiptUploadIndex).toBeGreaterThan(downloadedSpdxVerificationIndex);
    expect(workflow).toContain('downloaded-release/AXTERM_UPLOAD_ROUNDTRIP.*.json');
    expect(workflow).toContain('downloaded-release/AXTERM_SPDX_UPLOAD_ROUNDTRIP.*.json');
  });
});
