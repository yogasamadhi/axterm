import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRequire = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));

function loadAsar() {
  // electron-builder owns the ASAR format used by every packaged desktop build.
  const builderRequire = createRequire(appRequire.resolve('electron-builder'));
  return builderRequire('@electron/asar');
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function packageDirectory(file) {
  const parts = file.split('/').filter(Boolean);
  if (parts.at(-1) !== 'package.json') return null;
  const moduleIndex = parts.lastIndexOf('node_modules');
  if (moduleIndex < 0) return null;
  const tail = parts.slice(moduleIndex + 1);
  if (tail[0]?.startsWith('@') ? tail.length !== 3 : tail.length !== 2) {
    return null;
  }
  return `/${parts.slice(0, -1).join('/')}`;
}

function licenseMetadata(manifest) {
  if (typeof manifest.license === 'string' && manifest.license.trim()) {
    return {
      license: manifest.license.trim(),
      licenseSource: 'license',
      licenseDeclarations: [manifest.license.trim()],
    };
  }
  const legacy = Array.isArray(manifest.licenses)
    ? manifest.licenses
        .map((entry) => (typeof entry?.type === 'string' ? entry.type.trim() : ''))
        .filter(Boolean)
    : [];
  if (legacy.length > 0) {
    return {
      license: legacy.length === 1 ? legacy[0] : null,
      licenseSource: 'licenses',
      licenseDeclarations: legacy,
    };
  }
  return { license: null, licenseSource: null, licenseDeclarations: [] };
}

export function inventoryAsarFiles(files, readArchivedFile) {
  const rendererAssets = files.filter((file) => file.startsWith('/out/renderer/assets/')).sort();
  const rendererProvenanceFiles = files
    .filter((file) =>
      [
        '/out/renderer/axterm-novnc-bundle-provenance.json',
        '/out/renderer/axterm-spice-client-bundle-provenance.json',
      ].includes(file),
    )
    .sort();
  const packages = files
    .flatMap((manifestPath) => {
      const directory = packageDirectory(manifestPath);
      if (!directory) return [];
      const manifest = JSON.parse(readArchivedFile(manifestPath).toString());
      const declaredLicense = licenseMetadata(manifest);
      const licenseFiles = files
        .filter((file) => {
          if (!file.startsWith(`${directory}/`)) return false;
          const relative = file.slice(directory.length + 1);
          return (
            !relative.includes('/') && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(relative)
          );
        })
        .sort()
        .map((file) => ({ path: file, sha256: hash(readArchivedFile(file)) }));
      return [
        {
          name: manifest.name ?? null,
          version: manifest.version ?? null,
          ...declaredLicense,
          manifestPath,
          licenseFiles,
        },
      ];
    })
    .sort((a, b) => a.manifestPath.localeCompare(b.manifestPath));

  return {
    packageInstances: packages.length,
    uniquePackages: new Set(packages.map(({ name, version }) => `${name}@${version}`)).size,
    missingLicenseMetadata: packages
      .filter(({ name, licenseSource }) => !name?.startsWith('@workspace/') && !licenseSource)
      .map(({ manifestPath }) => manifestPath),
    missingRootLicenseFiles: packages
      .filter(
        ({ name, licenseFiles }) => !name?.startsWith('@workspace/') && licenseFiles.length === 0,
      )
      .map(({ manifestPath }) => manifestPath),
    rendererAssets,
    rendererAssetFiles: rendererAssets.map((path) => ({
      path,
      sha256: hash(readArchivedFile(path)),
    })),
    rendererProvenanceFiles: rendererProvenanceFiles.map((path) => ({
      path,
      sha256: hash(readArchivedFile(path)),
    })),
    archivedPrebuildFiles: files
      .filter((file) =>
        /\/node_modules\/(?:node-pty|@serialport\/bindings-cpp)\/prebuilds\//.test(file),
      )
      .sort(),
    packages,
  };
}

export function inventoryExternalLegalFiles(resourcesDirectory, artifactDirectory) {
  return [
    'LICENSE.axterm',
    'THIRD_PARTY_NOTICES.txt',
    'THIRD_PARTY_COMPONENTS.json',
    'AXTERM_PRODUCTION_DEPENDENCIES.spdx.json',
    'THIRD_PARTY_LICENSE_TEXTS.json',
    'licenses',
  ]
    .flatMap((name) => {
      const path = join(resourcesDirectory, name);
      if (!existsSync(path)) return [];
      const entries =
        name === 'licenses'
          ? readdirSync(path, { withFileTypes: true })
              .filter((entry) => entry.isFile())
              .map((entry) => `licenses/${entry.name}`)
          : [name];
      return entries.map((relativePath) => ({
        path: relativePath,
        artifactPath: relative(
          artifactDirectory,
          join(resourcesDirectory, relativePath),
        ).replaceAll('\\', '/'),
        sha256: hash(readFileSync(join(resourcesDirectory, relativePath))),
      }));
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

const electronRuntimeLegalNames = [
  { packagedName: 'LICENSE.electron.txt', sourceName: 'LICENSE' },
  { packagedName: 'LICENSES.chromium.html', sourceName: 'LICENSES.chromium.html' },
];

/**
 * Electron-builder preserves the Electron and Chromium legal files as part of
 * the platform runtime rather than Axterm's `extraResources`. They live below
 * `Resources` on macOS and beside or near the resources directory on other
 * targets, so treat them as runtime materials rather than source legal files.
 */
export function inventoryElectronRuntimeLegalFiles(resourcesDirectory, artifactDirectory) {
  const seen = new Set();
  return electronRuntimeLegalNames
    .flatMap(({ packagedName, sourceName }) => {
      const path = [resourcesDirectory, artifactDirectory]
        .map((directory) => join(directory, packagedName))
        .find((candidate) => existsSync(candidate));
      if (!path || seen.has(path)) return [];
      seen.add(path);
      const artifactPath = relative(artifactDirectory, path).replaceAll('\\', '/');
      if (!artifactPath || artifactPath === '..' || artifactPath.startsWith('../'))
        throw new Error(`Electron runtime legal file escapes artifact: ${path}`);
      return [
        {
          path: artifactPath,
          sourceName,
          sha256: hash(readFileSync(path)),
        },
      ];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function unpackedFiles(directory, relative = '') {
  if (!existsSync(directory)) return [];
  return readdirSync(join(directory, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) return unpackedFiles(directory, path);
      return entry.isFile()
        ? [{ path: path.replaceAll('\\', '/'), sha256: hash(readFileSync(join(directory, path))) }]
        : [];
    })
    .sort();
}

export function inventoryPackagedResources(resourcesDirectory) {
  const archivePath = join(resourcesDirectory, 'app.asar');
  const artifactDirectory = dirname(resourcesDirectory);
  // electron-builder's extraFiles live at the platform artifact root: Contents
  // on macOS and beside resources/ on Linux and Windows.
  const legalDirectory = artifactDirectory;
  const asar = loadAsar();
  const files = asar.listPackage(archivePath);
  const archiveArtifactPath = relative(artifactDirectory, archivePath).replaceAll('\\', '/');
  const unpackedDirectory = join(resourcesDirectory, 'app.asar.unpacked');
  const unpackedArtifactPrefix = relative(artifactDirectory, unpackedDirectory).replaceAll(
    '\\',
    '/',
  );
  const unpacked = unpackedFiles(unpackedDirectory).map((file) => ({
    ...file,
    artifactPath: `${unpackedArtifactPrefix}/${file.path}`,
  }));
  return {
    schemaVersion: 1,
    artifact: resolve(resourcesDirectory),
    archiveSha256: hash(readFileSync(archivePath)),
    archiveArtifactPath,
    ...inventoryAsarFiles(files, (file) => asar.extractFile(archivePath, file.slice(1))),
    externalLegalFiles: inventoryExternalLegalFiles(legalDirectory, artifactDirectory),
    electronRuntimeLegalFiles: inventoryElectronRuntimeLegalFiles(
      resourcesDirectory,
      artifactDirectory,
    ),
    unpackedFiles: unpacked,
    limitations: [
      'Package manifests and root notices do not prove every bundled file has the declared license.',
      'Electron and Chromium runtime license files are hashed when present, but their presence does not map every framework or bundled file to source.',
      'Bundled JavaScript, Electron/Chromium, native binaries, WASM, fonts and other assets still require a source-to-binary and rights review.',
      'This report is not a complete SBOM or legal clearance.',
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const resourcesDirectory = process.argv[2];
  if (!resourcesDirectory) {
    console.error(
      'Usage: node scripts/commercialization/packaged-license-inventory.mjs <Resources directory containing app.asar>',
    );
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(inventoryPackagedResources(resolve(resourcesDirectory)), null, 2));
  }
}
