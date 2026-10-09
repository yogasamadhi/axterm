import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { componentIndexFromBunReport } from './generate-component-index.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const installedPackagesRoot = resolve(repositoryRoot, 'node_modules/.bun');
const outputPath = resolve(repositoryRoot, 'compliance/THIRD_PARTY_LICENSE_TEXTS.json');
const rootLicenseFile = /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function packageIdentity(name, version) {
  return `${name}\0${version}`;
}

function extractedCopyrightLines(files) {
  return files
    .flatMap(({ name, content }) =>
      content
        .split(/\r?\n/u)
        .map((line) => line.trim())
        // Published LICENSE files may put the notice in a Markdown heading,
        // including the nonstandard but real "#Copyright" spelling. Preserve
        // the verbatim line; only the recognition rule is broadened.
        .filter((line) => /^(?:#{1,6}\s*)?(?:copyright\b|©)/iu.test(line))
        .map((line) => ({ file: name, line })),
    )
    .sort(
      (left, right) => compareText(left.file, right.file) || compareText(left.line, right.line),
    );
}

function manifestPublisherRecords(manifest) {
  const records = [
    ...(manifest.author === undefined ? [] : [{ field: 'author', value: manifest.author }]),
    ...(Array.isArray(manifest.contributors)
      ? manifest.contributors.map((value) => ({ field: 'contributors', value }))
      : []),
  ];
  return records.filter(
    ({ value }) =>
      (typeof value === 'string' && value.trim()) ||
      (value && typeof value === 'object' && !Array.isArray(value)),
  );
}

function packageAttribution(manifest, files) {
  return {
    manifestPublisherRecords: manifestPublisherRecords(manifest),
    manifestCopyright:
      typeof manifest.copyright === 'string' && manifest.copyright.trim()
        ? manifest.copyright.trim()
        : null,
    rootLicenseCopyrightLines: extractedCopyrightLines(files),
  };
}

function licenseFilesFromPackage(path, name, version) {
  const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  if (manifest.name !== name || manifest.version !== version) {
    throw new Error(`Bun package path does not match ${name}@${version}`);
  }
  const files = readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && rootLicenseFile.test(entry.name))
    .sort((left, right) => compareText(left.name, right.name))
    .map(({ name: fileName }) => {
      const bytes = readFileSync(join(path, fileName));
      const content = bytes.toString('utf8');
      if (!Buffer.from(content, 'utf8').equals(bytes)) {
        throw new Error(`Non-UTF-8 root license file: ${name}@${version}/${fileName}`);
      }
      return {
        name: fileName,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        content,
      };
    });
  return { files, attribution: packageAttribution(manifest, files) };
}

export function licenseTextsFromBunReport(report, options = {}) {
  const index = componentIndexFromBunReport(report);
  const allowedRoot = options.allowedRoot ? realpathSync(options.allowedRoot) : null;
  const byIdentity = new Map();
  for (const records of Object.values(report)) {
    for (const record of records) {
      if (!Array.isArray(record.paths) || record.paths.length !== record.versions.length) {
        throw new Error(`Missing or unpaired Bun package paths for ${record.name}`);
      }
      for (const [offset, version] of record.versions.entries()) {
        const packagePath = realpathSync(record.paths[offset]);
        if (allowedRoot) {
          const subpath = relative(allowedRoot, packagePath);
          if (isAbsolute(subpath) || subpath === '..' || subpath.startsWith(`..${sep}`)) {
            throw new Error(`Bun package path escapes installed graph: ${record.name}@${version}`);
          }
        }
        const component = licenseFilesFromPackage(packagePath, record.name, version);
        const identity = packageIdentity(record.name, version);
        const previous = byIdentity.get(identity);
        if (previous && JSON.stringify(previous) !== JSON.stringify(component)) {
          throw new Error(`Conflicting license evidence for ${record.name}@${version}`);
        }
        byIdentity.set(identity, component);
      }
    }
  }
  const components = index.components.map((component) => {
    const evidence = byIdentity.get(packageIdentity(component.name, component.version));
    if (!evidence)
      throw new Error(
        `Missing package license evidence for ${component.name}@${component.version}`,
      );
    return { ...component, ...evidence };
  });
  return {
    schemaVersion: 1,
    source: 'Root LICENSE/COPYING/NOTICE files from bun pm licenses --json --prod package paths',
    scope: 'Installed production dependency graph, not an exact platform artifact SBOM.',
    limitations: [
      'Package root files do not cover file-level, nested, generated, inlined, native, Electron/Chromium, WASM or non-code notices.',
      'A package with no root license file needs a separate verified source mapping; an empty files array is not clearance.',
      'Extracted copyright lines and manifest metadata are a review aid, not a complete attribution or source-rights conclusion.',
      'Preserved text and hashes do not establish distribution or source-availability compliance.',
    ],
    missingRootLicenseFiles: components
      .filter(({ files }) => files.length === 0)
      .map(({ name, version }) => ({ name, version })),
    missingCopyrightDeclarations: components
      .filter(
        ({ attribution }) =>
          !attribution.manifestCopyright && attribution.rootLicenseCopyrightLines.length === 0,
      )
      .map(({ name, version }) => ({ name, version })),
    components,
  };
}

export async function serializeLicenseTexts(archive) {
  return format(JSON.stringify(archive), { parser: 'json', printWidth: 100 });
}

export function mismatchedPackagedLicenseTexts(archive, packages) {
  const registered = new Map(
    archive.components.map((component) => [
      packageIdentity(component.name, component.version),
      component,
    ]),
  );
  return packages
    .filter(({ name }) => name && !name.startsWith('@workspace/'))
    .flatMap(({ name, version, license, licenseFiles }) => {
      const component = registered.get(packageIdentity(name, version));
      if (!component || component.license !== license) {
        return [`${name}@${version}: missing or mismatched license-text component`];
      }
      return licenseFiles.flatMap(({ path, sha256 }) => {
        const fileName = basename(path);
        return component.files.some((file) => file.name === fileName && file.sha256 === sha256)
          ? []
          : [`${name}@${version}/${fileName}: packaged root file differs from source archive`];
      });
    })
    .sort(compareText);
}

async function installedArchive() {
  const report = JSON.parse(
    execFileSync('bun', ['pm', 'licenses', '--json', '--prod'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }),
  );
  return serializeLicenseTexts(
    licenseTextsFromBunReport(report, { allowedRoot: installedPackagesRoot }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === '--generate') {
    writeFileSync(outputPath, await installedArchive());
    console.log(`Updated ${outputPath}`);
  } else if (mode === '--check') {
    if (readFileSync(outputPath, 'utf8') !== (await installedArchive())) {
      console.error('Production license texts are stale; run bun run licenses:texts:generate');
      process.exitCode = 1;
    } else {
      console.log('Production root-license texts match the installed Bun graph.');
    }
  } else {
    console.error(
      'Usage: node scripts/commercialization/generate-license-texts.mjs --generate|--check',
    );
    process.exitCode = 2;
  }
}
