import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const outputPath = resolve(repositoryRoot, 'compliance/THIRD_PARTY_COMPONENTS.json');

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function componentIndexFromBunReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Expected Bun production license groups');
  }
  const byIdentity = new Map();
  for (const [group, records] of Object.entries(report)) {
    if (!Array.isArray(records)) throw new Error(`Invalid Bun license group: ${group}`);
    for (const record of records) {
      if (
        !record ||
        typeof record.name !== 'string' ||
        !Array.isArray(record.versions) ||
        record.versions.length === 0
      ) {
        throw new Error(`Invalid Bun license record in ${group}`);
      }
      const license = typeof record.license === 'string' ? record.license : group;
      if (!license.trim()) throw new Error(`Missing license for ${record.name}`);
      for (const version of record.versions) {
        if (typeof version !== 'string' || !version.trim()) {
          throw new Error(`Invalid version for ${record.name}`);
        }
        const key = `${record.name}\0${version}`;
        const previous = byIdentity.get(key);
        if (previous && previous.license !== license) {
          throw new Error(`Conflicting license declarations for ${record.name}@${version}`);
        }
        byIdentity.set(key, { name: record.name, version, license });
      }
    }
  }
  const components = [...byIdentity.values()].sort(
    (left, right) => compareText(left.name, right.name) || compareText(left.version, right.version),
  );
  return {
    schemaVersion: 1,
    source: 'bun pm licenses --json --prod',
    scope:
      'Installed production dependency graph; may include packages absent from a platform artifact.',
    limitations: [
      'Manifest license metadata is not a complete copyright notice or source-rights review.',
      'Bundled code, Electron/Chromium, native binaries, WASM, fonts and other assets require artifact-level review.',
      'This index is not a complete SBOM or legal clearance.',
    ],
    components,
  };
}

export function serializeComponentIndex(index) {
  return `${JSON.stringify(index, null, 2)}\n`;
}

export function missingPackagedComponents(index, packages) {
  const registered = new Map(
    index.components.map(({ name, version, license }) => [`${name}\0${version}`, license]),
  );
  return packages
    .filter(({ name }) => name && !name.startsWith('@workspace/'))
    .flatMap(({ name, version, license }) => {
      const indexedLicense = registered.get(`${name}\0${version}`);
      return indexedLicense === license
        ? []
        : [`${name}@${version}: ${license} != ${indexedLicense}`];
    })
    .sort(compareText);
}

function installedIndex() {
  const report = JSON.parse(
    execFileSync('bun', ['pm', 'licenses', '--json', '--prod'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
  return serializeComponentIndex(componentIndexFromBunReport(report));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === '--generate') {
    writeFileSync(outputPath, installedIndex());
    console.log(`Updated ${outputPath}`);
  } else if (mode === '--check') {
    const expected = installedIndex();
    if (readFileSync(outputPath, 'utf8') !== expected) {
      console.error(
        'Production component index is stale; run bun run licenses:components:generate',
      );
      process.exitCode = 1;
    } else {
      console.log('Production component index matches the installed Bun graph.');
    }
  } else {
    console.error(
      'Usage: node scripts/commercialization/generate-component-index.mjs --generate|--check',
    );
    process.exitCode = 2;
  }
}
