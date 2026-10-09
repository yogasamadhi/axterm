import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'packages/pi-engine/source-manifest.json');
function digest(file) {
  return createHash('sha256')
    .update(readFileSync(path.join(root, file)))
    .digest('hex');
}
function sourceFiles(directory) {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith('.ts') ? [file] : [];
  });
}
export function checkPiSource() {
  const review = JSON.parse(
    readFileSync(path.join(root, 'vendor/pi-auto-review/PROVENANCE.json'), 'utf8'),
  );
  const reviewFiles = [
    'LICENSE',
    'src/path-surfaces.ts',
    'src/policy.ts',
    'src/review/shell-text.ts',
  ];
  if (
    review.repository !== 'https://github.com/erichll/pi-packages' ||
    review.revision !== '6eb4d9668f6d23fb6793029d5d145b8ae0fcd0ad' ||
    review.license !== 'MIT' ||
    JSON.stringify(review.files?.map((file) => file.path)) !== JSON.stringify(reviewFiles)
  )
    throw new Error('Auto-review source pin or scope differs');
  for (const file of review.files)
    if (digest(`vendor/pi-auto-review/${file.path}`) !== file.sha256)
      throw new Error(`Pinned auto-review source differs: ${file.path}`);
  if (digest('licenses/pi-auto-review-LICENSE.txt') !== digest('vendor/pi-auto-review/LICENSE'))
    throw new Error('Packaged auto-review license differs');
  const manifest = JSON.parse(readFileSync(output, 'utf8'));
  for (const file of manifest.files)
    if (digest(file.path) !== file.sha256)
      throw new Error(`Pinned Pi source differs: ${file.path}`);
  const catalog = JSON.parse(
    readFileSync(path.join(root, 'packages/pi-engine/catalog/provenance.json'), 'utf8'),
  );
  const upstreamPin = JSON.parse(
    readFileSync(path.join(root, 'vendor/pi/nix/model-catalog.json'), 'utf8'),
  );
  if (
    catalog.sourceRevision !== manifest.sourceRevision ||
    catalog.catalogRevision !== upstreamPin.revision ||
    `sha256-${digest('packages/pi-engine/catalog/models.all.json')}` !== catalog.catalogRevision
  )
    throw new Error('Pi catalog/source provenance differs from its pinned inputs');
}
if (process.argv[2] === '--generate-auto-review') {
  const file = path.join(root, 'vendor/pi-auto-review/PROVENANCE.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  manifest.files = [
    'LICENSE',
    'src/path-surfaces.ts',
    'src/policy.ts',
    'src/review/shell-text.ts',
  ].map((file) => ({ path: file, sha256: digest(`vendor/pi-auto-review/${file}`) }));
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}
if (process.argv[2] === '--generate') {
  const files = [
    ...['ai', 'agent', 'telemetry'].flatMap((pkg) => sourceFiles(`vendor/pi/packages/${pkg}/src`)),
    'vendor/pi/packages/ai/scripts/hydrate-model-catalog.ts',
    'vendor/pi/packages/ai/scripts/model-data.ts',
    'vendor/pi/packages/coding-agent/src/core/skills.ts',
    'vendor/pi/packages/coding-agent/src/core/source-info.ts',
    'vendor/pi/packages/coding-agent/src/core/diagnostics.ts',
    'vendor/pi/packages/coding-agent/src/config.ts',
    ...['frontmatter', 'text', 'paths', 'child-process'].map(
      (name) => `vendor/pi/packages/coding-agent/src/utils/${name}.ts`,
    ),
    'vendor/pi/LICENSE',
    'vendor/pi/nix/model-catalog.json',
  ].sort();
  writeFileSync(
    output,
    JSON.stringify(
      {
        sourceRevision: '5b6c792b424e73edefbfa558b901bcd64788dad2',
        license: 'MIT',
        files: files.map((file) => ({ path: file, sha256: digest(file) })),
      },
      null,
      2,
    ) + '\n',
  );
}
if (process.argv[2] === '--check') checkPiSource();
