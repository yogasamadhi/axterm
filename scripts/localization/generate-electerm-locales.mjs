import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const localeRoot = resolve(
  repositoryRoot,
  'vendor/electerm/node_modules/@electerm/electerm-locales/dist/cjs',
);
const outputPath = resolve(
  repositoryRoot,
  'apps/desktop/src/renderer/src/i18n/electerm-locales.generated.json',
);
const require = createRequire(import.meta.url);
const checkOnly = process.argv.includes('--check');
const expectedPackage = '@electerm/electerm-locales';
const expectedVersion = '2.3.16';
const expectedLicense = 'MIT';
const expectedKeyCount = 410;
const localeIds = {
  ar_ar: 'ar',
  de_de: 'de',
  en_us: 'en',
  es_es: 'es',
  fr_fr: 'fr',
  hu_hu: 'hu',
  id_id: 'id',
  ja_jp: 'ja',
  ko_kr: 'ko',
  pl_pl: 'pl',
  pt_br: 'pt-BR',
  ru_ru: 'ru',
  tr_tr: 'tr',
  zh_cn: 'zh-CN',
  zh_tw: 'zh-TW',
};

function validate(output) {
  if (output.schemaVersion !== 1) throw new Error('Unexpected locale snapshot schema');
  if (
    output.source?.package !== expectedPackage ||
    output.source?.version !== expectedVersion ||
    output.source?.license !== expectedLicense
  ) {
    throw new Error('Locale snapshot does not match the pinned package metadata');
  }
  if (output.keyCount !== expectedKeyCount) {
    throw new Error(`Expected ${expectedKeyCount} locale keys, received ${output.keyCount}`);
  }
  const expectedIds = Object.values(localeIds);
  if (JSON.stringify(output.locales?.map(({ id }) => id)) !== JSON.stringify(expectedIds)) {
    throw new Error('Locale snapshot IDs or ordering changed');
  }
  const english = output.locales.find(({ id }) => id === 'en');
  if (!english) throw new Error('Locale snapshot has no English fallback');
  const englishKeys = Object.keys(english.messages);
  if (englishKeys.length !== expectedKeyCount) throw new Error('English locale key count changed');
  for (const locale of output.locales) {
    const keys = Object.keys(locale.messages);
    if (JSON.stringify(keys) !== JSON.stringify(englishKeys)) {
      throw new Error(`${locale.id} does not have the same ordered keys as English`);
    }
    if (Object.values(locale.messages).some((message) => typeof message !== 'string')) {
      throw new Error(`${locale.id} contains a non-string message`);
    }
  }
}

function readUpstream() {
  const packagePath = resolve(localeRoot, '../../package.json');
  if (!existsSync(packagePath) || !existsSync(resolve(localeRoot, 'list.json'))) return undefined;
  const packageMetadata = JSON.parse(readFileSync(packagePath, 'utf8'));
  const sourceFiles = JSON.parse(readFileSync(resolve(localeRoot, 'list.json'), 'utf8'));
  const locales = sourceFiles.map((fileName) => {
    const upstreamId = fileName.replace(/\.js$/u, '');
    const id = localeIds[upstreamId];
    if (!id) throw new Error(`Unmapped Electerm locale ${upstreamId}`);
    const value = require(resolve(localeRoot, fileName));
    const locale = value.default ?? value;
    return {
      id,
      upstreamId,
      name: locale.name,
      flag: locale.flag,
      match: locale.match,
      messages: locale.lang,
    };
  });
  return {
    schemaVersion: 1,
    source: {
      package: expectedPackage,
      version: packageMetadata.version,
      license: packageMetadata.license,
    },
    keyCount: Object.keys(locales.find(({ id }) => id === 'en').messages).length,
    locales,
  };
}

const upstream = readUpstream();
if (!upstream && !checkOnly) {
  throw new Error(
    'The Electerm locale dependency is not installed. Install the pinned submodule dependencies before regenerating.',
  );
}
const committed = existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, 'utf8')) : undefined;
if (!committed && checkOnly) throw new Error('Generated locale snapshot is missing');
const output = upstream ?? committed;
if (!output) throw new Error('No locale source is available');
validate(output);

if (checkOnly) {
  if (upstream && JSON.stringify(upstream) !== JSON.stringify(committed)) {
    throw new Error('Generated locale snapshot is stale; run bun run locales:generate');
  }
  validate(committed);
  console.log(
    `Verified ${committed.locales.length} pinned locales with ${committed.keyCount} keys`,
  );
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    `Generated ${output.locales.length} Electerm locales with ${output.keyCount} keys at ${outputPath}`,
  );
}
