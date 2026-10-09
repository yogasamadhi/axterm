import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const outputPath = resolve(repositoryRoot, 'compliance/AXTERM_PRODUCT_ASSETS.json');

const firstPartyAssetDefinitions = [
  {
    path: 'apps/desktop/build/icon.svg',
    role: 'Editable Axterm application-mark source',
    distribution: 'Source tree',
  },
  {
    path: 'apps/desktop/build/icon.png',
    role: '1024px application-mark raster and Linux extra resource',
    distribution: 'Linux package resource and source tree',
  },
  {
    path: 'apps/desktop/build/icon-512.png',
    role: 'Linux package application icon',
    distribution: 'Linux package metadata and source tree',
  },
  {
    path: 'apps/desktop/build/icon.ico',
    role: 'Windows application icon set',
    distribution: 'Windows executable metadata and source tree',
  },
  {
    path: 'apps/desktop/build/icon.icns',
    role: 'macOS application icon set',
    distribution: 'macOS application resource and source tree',
  },
];

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Produces a content inventory for the first-party product-mark files named in
 * PRODUCT_ASSET_PROVENANCE.md. It intentionally does not make authorship,
 * trademark, license or derivative-work determinations from matching bytes.
 */
export function productAssetInventoryFromContents(contentsByPath) {
  const assets = firstPartyAssetDefinitions.map((definition) => {
    const content = contentsByPath.get(definition.path);
    if (!content) throw new Error(`Missing product asset: ${definition.path}`);
    return {
      ...definition,
      bytes: content.byteLength,
      sha256: sha256(content),
    };
  });
  return {
    schemaVersion: 1,
    source: 'First-party product-mark paths enumerated by Axterm',
    scope: 'Content inventory for current first-party application-mark files.',
    limitations: [
      'Matching bytes do not prove authorship, copyright ownership, trademark availability or freedom from third-party claims.',
      'This does not inventory third-party fonts, renderer bundles, Electron/Chromium, native binaries or package-managed assets.',
      'This inventory does not replace a human review of each retained product-mark asset.',
    ],
    assets,
  };
}

export function serializeProductAssetInventory(inventory) {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

export function installedProductAssetInventory(root = repositoryRoot) {
  const contents = new Map(
    firstPartyAssetDefinitions.map((definition) => [
      definition.path,
      readFileSync(resolve(root, definition.path)),
    ]),
  );
  return productAssetInventoryFromContents(contents);
}

function currentInventoryText() {
  return serializeProductAssetInventory(installedProductAssetInventory());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === '--generate') {
    writeFileSync(outputPath, currentInventoryText());
    console.log(`Updated ${outputPath}`);
  } else if (mode === '--check') {
    const expected = currentInventoryText();
    if (readFileSync(outputPath, 'utf8') !== expected) {
      console.error('Product asset inventory is stale; run bun run assets:generate');
      process.exitCode = 1;
    } else {
      console.log('Product asset inventory matches first-party asset bytes.');
    }
  } else {
    console.error(
      'Usage: node scripts/commercialization/generate-product-asset-inventory.mjs --generate|--check',
    );
    process.exitCode = 2;
  }
}
