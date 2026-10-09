import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';

const root = resolve(import.meta.dirname, '../..');
const sourceInventoryPath = resolve(
  root,
  'docs/implementation/evidence/IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json',
);
const recordPath = resolve(
  root,
  'docs/implementation/evidence/IR11-IRONRDP-MISSING-CRATE-ROOT-TEXTS-2026-09-24.json',
);
const bundlePath = resolve(root, 'licenses/IronRDP-MISSING-CRATE-ROOT-LICENSES.txt');
const recordSha256 = '91695e3bd448ff1464247288f1000f55314f39a7a0a17df934079dd313c24b3a';
const bundleSha256 = '7768aaf3d75c05f6c75923fbecad728e3c9325c05268098db3a6ac8e8b2851b0';
const candidates = [
  {
    name: 'asn1-rs-impl',
    version: '0.2.0',
    repositoryKey: 'asn1-rs',
    repository: 'https://github.com/rusticata/asn1-rs',
    commit: 'a20e5f7319c896737ad0f2557037817b91ad854f',
    pathInVcs: 'impl',
    libSha256: 'c052170f4c8f719ef07a722a1961c0e52423e28951ddbdf3700d7329bb79a277',
  },
  {
    name: 'gloo-net',
    version: '0.7.0',
    repositoryKey: 'gloo',
    repository: 'https://github.com/rustwasm/gloo',
    commit: 'd69fcff62ee63f37076c4a0715a6f828b0036599',
    pathInVcs: 'crates/net',
    libSha256: 'c7ce332978cfbdc3a113d2852b331635d341dc352fc73a63e9e2ad1284b17f13',
  },
  {
    name: 'gloo-timers',
    version: '0.4.0',
    repositoryKey: 'gloo',
    repository: 'https://github.com/rustwasm/gloo',
    commit: 'c8feeb18bf5dde6b7aed80c749e1aef89b34fb52',
    pathInVcs: 'crates/timers',
    libSha256: '45e2413fa20c82e3c8d979445d9221fc604c8b5a96b6e79aebef55134816dc9d',
  },
  {
    name: 'gloo-utils',
    version: '0.3.0',
    repositoryKey: 'gloo',
    repository: 'https://github.com/rustwasm/gloo',
    commit: 'e6280d4b93c86a478a8f2f31af5f13d770b156b7',
    pathInVcs: 'crates/utils',
    libSha256: '8858114054089021f6b7750d8a3e8b5b0db9e4d260b9611fbaf9926ebb595bf5',
  },
  {
    name: 'rustcrypto-ff_derive',
    version: '0.14.0-rc.0',
    repositoryKey: 'ff',
    repository: 'https://github.com/zkcrypto/ff',
    commit: '8417973539baabf561975144e0a68d166d0f9a95',
    pathInVcs: 'ff_derive',
    libSha256: '932e49105a795c49a45ea78574bb9adb35103da803e4d1839c6735ad666dca91',
  },
  {
    name: 'winscard',
    version: '0.3.2',
    repositoryKey: 'sspi-rs',
    repository: 'https://github.com/Devolutions/sspi-rs',
    commit: 'fee71292aa03c569caeb44ec2782f3b5598f20c8',
    pathInVcs: 'crates/winscard',
    libSha256: '0c7307595b9de62490ac39ea0daa78eef2eddb498e192a44812a9cf31ec3ff18',
  },
];
const expectedNames = candidates.map(({ name, version }) => `${name}@${version}`);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function git(checkout, args) {
  return execFileSync('git', args, { cwd: checkout, maxBuffer: 20 * 1024 * 1024 });
}

function crateDirectories(cargoHome, candidate) {
  const base = join(cargoHome, 'registry');
  const roots = readdirSync(join(base, 'src'))
    .filter((name) => name.startsWith('index.crates.io-'))
    .map((name) => ({
      source: join(base, 'src', name, `${candidate.name}-${candidate.version}`),
      archive: join(base, 'cache', name, `${candidate.name}-${candidate.version}.crate`),
    }))
    .filter(({ source, archive }) => existsSync(source) && existsSync(archive));
  if (roots.length !== 1) throw new Error(`Expected one cached published crate: ${candidate.name}`);
  return roots[0];
}

export function missingRootCandidates(inventory) {
  if (inventory?.source?.commit !== 'e45f68c7e52297ca50d33b44c0ace36c9940fbe6')
    throw new Error('IronRDP source commit differs from the reviewed missing-root scope');
  const missing = inventory.packages
    .filter((entry) => entry.source === 'registry' && entry.rootLegalFiles.length === 0)
    .map((entry) => `${entry.name}@${entry.version}`)
    .sort();
  if (JSON.stringify(missing) !== JSON.stringify([...expectedNames].sort()))
    throw new Error('IronRDP missing-root registry scope has changed');
  return candidates.map((candidate) => {
    const packageRecord = inventory.packages.find(
      (entry) => entry.name === candidate.name && entry.version === candidate.version,
    );
    if (!packageRecord?.checksum || !packageRecord.license)
      throw new Error(`Missing pinned archive or license metadata: ${candidate.name}`);
    return { ...candidate, archiveSha256: packageRecord.checksum, license: packageRecord.license };
  });
}

export function missingRootSourceRecord(inventory, checkouts, cargoHome) {
  const files = [];
  const packages = missingRootCandidates(inventory).map((candidate) => {
    const checkout = checkouts[candidate.repositoryKey];
    if (!checkout) throw new Error(`Missing ${candidate.repositoryKey} source checkout`);
    const repository = git(checkout, ['remote', 'get-url', 'origin']).toString().trim();
    if (repository.replace(/\.git$/u, '').toLowerCase() !== candidate.repository.toLowerCase())
      throw new Error(`Wrong publisher repository for ${candidate.name}`);
    if (git(checkout, ['cat-file', '-t', candidate.commit]).toString().trim() !== 'commit')
      throw new Error(`Missing immutable publisher commit for ${candidate.name}`);
    const crate = crateDirectories(cargoHome, candidate);
    if (sha256(readFileSync(crate.archive)) !== candidate.archiveSha256)
      throw new Error(`Published crate archive checksum differs: ${candidate.name}`);
    const vcs = JSON.parse(readFileSync(join(crate.source, '.cargo_vcs_info.json'), 'utf8'));
    if (vcs.git?.sha1 !== candidate.commit || vcs.path_in_vcs !== candidate.pathInVcs)
      throw new Error(`Published crate VCS information differs: ${candidate.name}`);
    const publishedLib = readFileSync(join(crate.source, 'src/lib.rs'));
    const upstreamLib = git(checkout, [
      'show',
      `${candidate.commit}:${candidate.pathInVcs}/src/lib.rs`,
    ]);
    if (!publishedLib.equals(upstreamLib) || sha256(publishedLib) !== candidate.libSha256) {
      throw new Error(
        `Published crate source differs from immutable publisher commit: ${candidate.name}`,
      );
    }
    const rootLegalFiles = ['LICENSE-APACHE', 'LICENSE-MIT'].map((name) => {
      const bytes = git(checkout, ['show', `${candidate.commit}:${name}`]);
      if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes))
        throw new Error(`Publisher root license is not UTF-8: ${candidate.name}/${name}`);
      const entry = {
        identity: `${candidate.name}@${candidate.version} (${candidate.commit})`,
        name,
        bytes,
        sha256: sha256(bytes),
      };
      files.push(entry);
      return { name, bytes: bytes.length, sha256: entry.sha256 };
    });
    return {
      name: candidate.name,
      version: candidate.version,
      license: candidate.license,
      archiveSha256: candidate.archiveSha256,
      repository: candidate.repository,
      commit: candidate.commit,
      pathInVcs: candidate.pathInVcs,
      matchedLibSha256: candidate.libSha256,
      rootLegalFiles,
    };
  });
  return {
    record: {
      schemaVersion: 1,
      source: 'IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json',
      target: 'wasm32-unknown-unknown',
      publishedCrateCount: packages.length,
      publisherRootLegalFileCount: files.length,
      packages,
      limitations: [
        'The published crate archives omit their own root legal text; these are exact publisher-repository-root texts at each crate VCS commit.',
        'Matching one published src/lib.rs per crate is an identity cross-check, not an exhaustive source-to-binary map.',
        'Preserving both alternatives does not select a license option or complete nested/file-level rights review.',
      ],
    },
    files,
  };
}

function introduction(record) {
  return Buffer.from(
    [
      'Axterm supplementary IronRDP published-crate missing-root legal texts',
      '',
      `Source scope: ${record.source}; ${record.publishedCrateCount} pinned registry crates; ${record.publisherRootLegalFileCount} publisher-root files.`,
      'Original UTF-8 publisher file bytes appear between markers; lengths and SHA-256 are checked against the pinned record.',
      'This preserves both source-repository license alternatives and does not assert exact WASM linkage or legal clearance.',
      '',
    ].join('\n') + '\n',
  );
}

function expectedFileEntries(record) {
  return record.packages.flatMap((candidate) =>
    candidate.rootLegalFiles.map((file) => ({
      identity: `${candidate.name}@${candidate.version} (${candidate.commit})`,
      ...file,
    })),
  );
}

function begin(entry) {
  return Buffer.from(
    `===== BEGIN ${entry.identity} / ${entry.name} | ${entry.bytes} bytes | SHA-256 ${entry.sha256} =====\n`,
  );
}

function end(entry) {
  return Buffer.from(`\n===== END ${entry.identity} / ${entry.name} =====\n\n`);
}

export function missingRootBundle(record, files) {
  const expected = expectedFileEntries(record);
  if (
    files.length !== expected.length ||
    files.some(
      (file, index) =>
        ['identity', 'name', 'sha256'].some((key) => file[key] !== expected[index][key]) ||
        file.bytes.length !== expected[index].bytes,
    )
  ) {
    throw new Error('Missing-root publisher legal files differ from source record');
  }
  return Buffer.concat([
    introduction(record),
    ...files.flatMap((entry) => [
      begin({ ...entry, bytes: entry.bytes.length }),
      entry.bytes,
      end(entry),
    ]),
  ]);
}

export function missingRootBundleViolations(record, bundle) {
  const preface = introduction(record);
  if (!bundle.subarray(0, preface.length).equals(preface))
    return ['Missing-root legal-bundle introduction differs'];
  const violations = [];
  let offset = preface.length;
  for (const entry of expectedFileEntries(record)) {
    const marker = begin(entry);
    if (!bundle.subarray(offset, offset + marker.length).equals(marker))
      return [...violations, `Changed BEGIN marker: ${entry.identity}/${entry.name}`];
    offset += marker.length;
    const bytes = bundle.subarray(offset, offset + entry.bytes);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
      violations.push(`Changed original bytes: ${entry.identity}/${entry.name}`);
    if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes))
      violations.push(`Non-UTF-8 bytes: ${entry.identity}/${entry.name}`);
    offset += entry.bytes;
    const closing = end(entry);
    if (!bundle.subarray(offset, offset + closing.length).equals(closing))
      return [...violations, `Changed END marker: ${entry.identity}/${entry.name}`];
    offset += closing.length;
  }
  if (offset !== bundle.length) violations.push('Unexpected trailing missing-root legal material');
  return violations;
}

export function missingRootRecordViolations(record, inventory) {
  const expected = missingRootCandidates(inventory);
  const violations = [];
  if (
    record?.schemaVersion !== 1 ||
    record.source !== 'IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json' ||
    record.target !== 'wasm32-unknown-unknown' ||
    record.publishedCrateCount !== 6 ||
    record.publisherRootLegalFileCount !== 12 ||
    !Array.isArray(record.packages) ||
    record.packages.length !== 6
  ) {
    return ['Missing-root publisher-source record scope differs'];
  }
  for (let index = 0; index < expected.length; index += 1) {
    const entry = record.packages[index];
    const candidate = expected[index];
    const same = [
      'name',
      'version',
      'license',
      'archiveSha256',
      'repository',
      'commit',
      'pathInVcs',
    ].every((key) => entry?.[key] === candidate[key]);
    if (!same || entry?.matchedLibSha256 !== candidate.libSha256)
      violations.push(`Missing-root crate/source identity differs: ${candidate.name}`);
    if (
      !Array.isArray(entry?.rootLegalFiles) ||
      entry.rootLegalFiles.map((file) => file.name).join(',') !== 'LICENSE-APACHE,LICENSE-MIT' ||
      !entry.rootLegalFiles.every(
        (file) =>
          Number.isSafeInteger(file.bytes) && file.bytes > 0 && /^[a-f0-9]{64}$/u.test(file.sha256),
      )
    ) {
      violations.push(`Missing-root publisher legal-file scope differs: ${candidate.name}`);
    }
  }
  return violations;
}

async function serialize(record) {
  return format(JSON.stringify(record), { parser: 'json' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const inventory = JSON.parse(readFileSync(sourceInventoryPath, 'utf8'));
  if (mode === '--generate' || mode === '--source-check') {
    const paths = process.argv.slice(3);
    if (paths.length !== 4)
      throw new Error(
        `Usage: ${mode} <gloo checkout> <asn1-rs checkout> <ff checkout> <sspi-rs checkout>`,
      );
    const [gloo, asn1, ff, sspi] = paths.map((path) => resolve(path));
    const checkouts = { gloo, 'asn1-rs': asn1, ff, 'sspi-rs': sspi };
    const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo');
    const { record, files } = missingRootSourceRecord(inventory, checkouts, cargoHome);
    const json = await serialize(record);
    const bundle = missingRootBundle(record, files);
    if (mode === '--generate') {
      writeFileSync(recordPath, json);
      writeFileSync(bundlePath, bundle);
      console.log(
        `Updated ${recordPath} and ${bundlePath} (${files.length} publisher root files).`,
      );
    } else if (
      readFileSync(recordPath, 'utf8') !== json ||
      !readFileSync(bundlePath).equals(bundle)
    ) {
      throw new Error(
        'Committed missing-root record or legal bundle differs from publisher commits',
      );
    } else console.log('Six pinned IronRDP crates map to twelve exact publisher root legal texts.');
  } else if (mode === '--check') {
    const json = readFileSync(recordPath, 'utf8');
    const bundle = readFileSync(bundlePath);
    const record = JSON.parse(json);
    const violations = missingRootRecordViolations(record, inventory);
    if (json !== (await serialize(record)))
      violations.push('Missing-root record formatting differs');
    if (sha256(json) !== recordSha256) violations.push('Missing-root record pinned hash differs');
    if (sha256(bundle) !== bundleSha256)
      violations.push('Missing-root legal-bundle pinned hash differs');
    violations.push(...missingRootBundleViolations(record, bundle));
    if (violations.length) throw new Error(violations.join('; '));
    console.log('Six pinned IronRDP crates have twelve byte-checked publisher root legal texts.');
  } else {
    throw new Error(
      'Usage: ironrdp-missing-root-licenses.mjs --generate|--source-check <four checkouts>|--check',
    );
  }
}
