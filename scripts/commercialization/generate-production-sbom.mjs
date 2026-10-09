import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { componentIndexFromBunReport } from './generate-component-index.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const outputPath = resolve(repositoryRoot, 'compliance/AXTERM_PRODUCTION_DEPENDENCIES.spdx.json');
const sourceDate = '2026-09-21T00:00:00Z';

function packageId(name, version) {
  return `SPDXRef-Package-${createHash('sha256').update(`${name}\0${version}`).digest('hex')}`;
}

function packagePurl(name, version) {
  const encoded = name
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}

export function productionSbomFromIndex(index, product) {
  const identities = index.components.map(({ name, version }) => `${name}\0${version}`).join('\n');
  const inventoryHash = createHash('sha256').update(identities).digest('hex');
  const namespace = `https://axterm.dev/sbom/${encodeURIComponent(product.version)}/${inventoryHash}`;
  const packages = index.components.map(({ name, version, license }) => ({
    SPDXID: packageId(name, version),
    name,
    versionInfo: version,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
    licenseComments: `Manifest declaration: ${license}`,
    copyrightText: 'NOASSERTION',
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: packagePurl(name, version),
      },
    ],
  }));
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${product.name} production dependency inventory`,
    documentNamespace: namespace,
    creationInfo: {
      created: sourceDate,
      creators: ['Tool: Axterm production SBOM generator'],
      licenseListVersion: '3.23',
      comment:
        'Reproducible source dependency inventory generated from bun pm licenses --json --prod.',
    },
    documentDescribes: packages.map(({ SPDXID }) => SPDXID),
    comment:
      'Scope: installed production dependency graph. This is not an exact platform artifact SBOM, a file-level license inventory, or legal clearance. Electron/Chromium, bundled JavaScript, native binaries, WASM, fonts, copied code and other assets require the artifact-level review recorded in THIRD_PARTY_LICENSE_AUDIT.md.',
    packages,
  };
}

export async function serializeProductionSbom(sbom) {
  return format(JSON.stringify(sbom), { parser: 'json' });
}

async function installedSbom() {
  const report = JSON.parse(
    execFileSync('bun', ['pm', 'licenses', '--json', '--prod'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
  const product = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'));
  return serializeProductionSbom(
    productionSbomFromIndex(componentIndexFromBunReport(report), {
      name: product.name,
      version: product.version,
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === '--generate') {
    writeFileSync(outputPath, await installedSbom());
    console.log(`Updated ${outputPath}`);
  } else if (mode === '--check') {
    if (readFileSync(outputPath, 'utf8') !== (await installedSbom())) {
      console.error('Production SBOM is stale; run bun run sbom:generate');
      process.exitCode = 1;
    } else console.log('Production SPDX SBOM matches the installed Bun graph.');
  } else {
    console.error(
      'Usage: node scripts/commercialization/generate-production-sbom.mjs --generate|--check',
    );
    process.exitCode = 2;
  }
}
