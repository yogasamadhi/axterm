import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const repositoryRoot = resolve(import.meta.dirname, '../..');
const inputRoot = resolve(repositoryRoot, 'tests/fixtures/migration/generation2-localization');
const catalogPath = resolve(inputRoot, 'axterm-navigation.generated.json');
const usageSha256 = 'c1123faf47cb59d4094f1adc3daa1412a6538fa26124c4f818e9eed509eef264';
/** Historical review facts only; actual Client dictionaries/source have their own owned gate. */
export function auditLegacyUiKeys({ catalogFile = catalogPath } = {}) {
  const bytes = readFileSync(resolve(inputRoot, 'navigation-usage.json'));
  if (createHash('sha256').update(bytes).digest('hex') !== usageSha256)
    throw new Error('Frozen generation2 navigation usage changed');
  const snapshot = JSON.parse(bytes);
  if (snapshot.sourceCommit !== 'f252e62c7841ba906f9d4cb73152cd55a3bea9b3')
    throw new Error('Unrecognized historical navigation source');
  for (const [path, expected] of Object.entries(snapshot.sourceIdentities)) {
    const input = readFileSync(
      resolve(inputRoot, path.split('/').at(-1) + (path.endsWith('.ts') ? '.txt' : '')),
    );
    if (createHash('sha256').update(input).digest('hex') !== expected)
      throw new Error('Frozen historical catalog changed');
  }
  const catalog = catalogFile ? JSON.parse(readFileSync(catalogFile, 'utf8')) : null;
  const english = catalog?.locales.find(({ id }) => id === 'en');
  if (catalog && !english) throw new Error('The Axterm catalog has no English fallback');
  const keys = english ? new Set(Object.keys(english.messages)) : null;
  const used = new Set(snapshot.usage.usedKeys);
  const missing = keys ? [...used].filter((key) => !keys.has(key)).sort() : [];
  return {
    ...snapshot.usage,
    catalogKeyCount: keys?.size ?? null,
    unusedKeys: keys ? [...keys].filter((key) => !used.has(key)).sort() : [],
    missingKeys: missing,
    unexpectedMissingKeys: missing,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = auditLegacyUiKeys();
  if (report.unexpectedMissingKeys.length || report.unrecognizedDynamicCalls.length)
    throw new Error('Frozen navigation review facts do not match the historical catalog');
  console.log(`Verified historical navigation usage: ${report.usedKeys.length} keys`);
}
