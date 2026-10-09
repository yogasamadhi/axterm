import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { inventoryPackagedResources } from './packaged-license-inventory.mjs';
import { verifyPackagedArtifactSbomFromInventory } from './verify-packaged-artifact-sbom.mjs';

const projectRoot = resolve(import.meta.dirname, '../..');
const inventoryPath = resolve(
  projectRoot,
  'docs/implementation/evidence/IR11-IRONRDP-WASM-SOURCE-DEPENDENCIES-2026-09-24.json',
);
const bundlePath = resolve(projectRoot, 'licenses/IronRDP-RUST-ROOT-LICENSES.txt');
const spdxPath = resolve(projectRoot, 'compliance/AXTERM_IRONRDP_WASM_CARGO_SOURCE.spdx.json');
const installedJavaScriptPath = resolve(
  projectRoot,
  'apps/desktop/node_modules/@devolutions/iron-remote-desktop-rdp/iron-remote-desktop-rdp.js',
);
const sourceCommit = 'e45f68c7e52297ca50d33b44c0ace36c9940fbe6';
const cargoLockSha256 = '39e41e6fe8fd7de5679ec11f59e8597e9f761ecb04f9b908eb79c5629b9cfb1a';
const installedJavaScriptSha256 =
  'b008f0e258fd9485c6f2b07747116d4fcbbe51053ce995abd048fb2b79636332';
const embeddedWasmSha256 = '68b5c65280e5348ea418cd0aba2e4e28f9bd4051c2cf9fd4b84d721847ef3363';
const inventorySha256 = 'ff29170ab16588b67555996ba107f15eac5005149b549110cd570fe1c4126792';
const legalBundleSha256 = '4f90cf224ed4e9b0a4e9f6fb2428c98eeccc2f2ab17c063d0543aba266337a96';
const missingRootBundleSha256 = '7768aaf3d75c05f6c75923fbecad728e3c9325c05268098db3a6ac8e8b2851b0';
const nestedSpinLicenseSha256 = '58545fed1565e42d687aecec6897d35c6d37ccb71479a137c0deb2203e125c79';
const sourceHeaderBundleSha256 = 'd90d38584895a626cdfb61f600e8eb4670d0f1734206b5c0c7cdd52a10712084';
const sourceSpdxSha256 = '733048987d2eaf67b41b5c4e7e42c79d3daf4ea5705b6c8c58b5b53d571c25cf';
const rootLegalName = /^(?:LICENSE|LICENCE|COPYING|NOTICE|COPYRIGHT|AUTHORS)(?:[._-].*)?$/iu;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function command(executable, args, cwd) {
  return execFileSync(executable, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  }).trim();
}

export function parseIronRdpCargoTree(output) {
  const identities = new Set();
  for (const line of output.trim().split('\n')) {
    const match = /^([^\s]+) v([^\s]+)(?: \(.+\))?(?: \(\*\))?$/u.exec(line.trim());
    if (!match) throw new Error(`Unrecognized Cargo tree package: ${line}`);
    identities.add(`${match[1]}@${match[2]}`);
  }
  if (!identities.has('ironrdp-web@0.0.0'))
    throw new Error('The wasm-target Cargo tree lacks ironrdp-web');
  return [...identities].sort();
}

export function parseIronRdpCargoLock(lockText) {
  const packages = new Map();
  for (const block of lockText.split(/^\[\[package\]\]\s*$/mu).slice(1)) {
    const value = (name) => new RegExp(`^${name} = "([^"]+)"$`, 'mu').exec(block)?.[1];
    const name = value('name');
    const version = value('version');
    if (!name || !version) throw new Error('Malformed pinned Cargo.lock package block');
    const identity = `${name}@${version}`;
    if (packages.has(identity)) throw new Error(`Ambiguous Cargo.lock identity: ${identity}`);
    packages.set(identity, {
      source: value('source') ?? null,
      checksum: value('checksum') ?? null,
    });
  }
  return packages;
}

function rootLegalFiles(directory) {
  return readdirSync(directory)
    .filter((name) => rootLegalName.test(name) && statSync(join(directory, name)).isFile())
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(directory, name));
      if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes))
        throw new Error(`Non-UTF-8 root legal file: ${directory}/${name}`);
      return { name, bytes, sha256: sha256(bytes) };
    });
}

function installedWasmIdentity() {
  const js = readFileSync(installedJavaScriptPath);
  if (sha256(js) !== installedJavaScriptSha256)
    throw new Error('Installed IronRDP JavaScript differs from the pinned npm artifact');
  const match = /data:application\/wasm;base64,([A-Za-z0-9+/=]+)/u.exec(js.toString('utf8'));
  if (!match || sha256(Buffer.from(match[1], 'base64')) !== embeddedWasmSha256)
    throw new Error('Installed IronRDP embedded WASM differs from the pinned artifact');
}

export function inventoryViolations(inventory) {
  const violations = [];
  if (
    inventory?.schemaVersion !== 1 ||
    inventory?.source?.commit !== sourceCommit ||
    inventory?.source?.cargoLockSha256 !== cargoLockSha256 ||
    inventory?.target !== 'wasm32-unknown-unknown' ||
    inventory?.rootPackage !== 'ironrdp-web@0.0.0' ||
    inventory?.publishedJavaScriptSha256 !== installedJavaScriptSha256 ||
    inventory?.publishedEmbeddedWasmSha256 !== embeddedWasmSha256
  ) {
    violations.push('IronRDP source or published-artifact identity differs');
  }
  if (
    !Array.isArray(inventory?.packages) ||
    inventory.packages.length !== 259 ||
    inventory.registryPackageCount !== 236 ||
    inventory.workspacePackageCount !== 23 ||
    inventory.packageRootLegalFileCount !== 468 ||
    inventory.packages.filter((entry) => entry.rootLegalFiles.length === 0).length !== 11
  ) {
    violations.push('IronRDP wasm-target source-package scope differs');
    return violations;
  }
  const identities = new Set();
  for (const entry of inventory.packages) {
    const identity = `${entry.name}@${entry.version}`;
    if (identities.has(identity)) violations.push(`Duplicate IronRDP source package: ${identity}`);
    identities.add(identity);
    if (!entry.license || !['registry', 'workspace'].includes(entry.source))
      violations.push(`Missing source/license metadata: ${identity}`);
    if (entry.source === 'registry' && !/^[a-f0-9]{64}$/u.test(entry.checksum ?? ''))
      violations.push(`Missing locked crate checksum: ${identity}`);
    if (entry.source === 'workspace' && !/^crates\/[^/]+$/u.test(entry.path ?? ''))
      violations.push(`Unexpected upstream workspace path: ${identity}`);
    for (const file of entry.rootLegalFiles) {
      if (!rootLegalName.test(file.name) || !/^[a-f0-9]{64}$/u.test(file.sha256))
        violations.push(`Invalid root legal-file record: ${identity}`);
    }
  }
  if (!identities.has(inventory.rootPackage)) violations.push('IronRDP WASM root is missing');
  if (
    !Array.isArray(inventory.upstreamRootLegalFiles) ||
    inventory.upstreamRootLegalFiles.map((file) => file.name).join(',') !==
      'LICENSE-APACHE,LICENSE-MIT'
  ) {
    violations.push('IronRDP upstream root license scope differs');
  }
  return violations;
}

export function sourceInventory(checkout) {
  const root = realpathSync(resolve(checkout));
  const commit = command('git', ['rev-parse', 'HEAD'], root);
  if (commit !== sourceCommit) throw new Error(`Unexpected IronRDP source commit: ${commit}`);
  if (command('git', ['status', '--porcelain', '--untracked-files=no'], root))
    throw new Error('Pinned IronRDP source has modified tracked files');
  const lockBytes = readFileSync(join(root, 'Cargo.lock'));
  if (sha256(lockBytes) !== cargoLockSha256)
    throw new Error('Pinned IronRDP Cargo.lock bytes differ');
  installedWasmIdentity();
  const tree = command(
    'cargo',
    [
      'tree',
      '--locked',
      '--target',
      'wasm32-unknown-unknown',
      '--package',
      'ironrdp-web',
      '--edges',
      'normal,build',
      '--prefix',
      'none',
      '--format',
      '{p}',
    ],
    root,
  );
  const metadata = JSON.parse(
    command(
      'cargo',
      [
        'metadata',
        '--locked',
        '--filter-platform',
        'wasm32-unknown-unknown',
        '--format-version',
        '1',
      ],
      root,
    ),
  );
  const metadataByIdentity = new Map();
  for (const entry of metadata.packages) {
    const identity = `${entry.name}@${entry.version}`;
    if (!metadataByIdentity.has(identity)) metadataByIdentity.set(identity, []);
    metadataByIdentity.get(identity).push(entry);
  }
  const locked = parseIronRdpCargoLock(lockBytes.toString('utf8'));
  const files = [];
  const upstreamRootLegalFiles = rootLegalFiles(root).map(({ name, bytes, sha256: hash }) => {
    files.push({ identity: 'IronRDP tagged source root', name, bytes, sha256: hash });
    return { name, sha256: hash };
  });
  const packages = parseIronRdpCargoTree(tree).map((identity) => {
    const matches = metadataByIdentity.get(identity) ?? [];
    if (matches.length !== 1) throw new Error(`Ambiguous Cargo metadata identity: ${identity}`);
    const entry = matches[0];
    const lock = locked.get(identity);
    if (!lock || entry.source !== lock.source)
      throw new Error(`Cargo metadata/lock source differs: ${identity}`);
    if (!entry.license) throw new Error(`Missing manifest license declaration: ${identity}`);
    const source = entry.source?.startsWith('registry+') ? 'registry' : 'workspace';
    if (source === 'registry' && !/^[a-f0-9]{64}$/u.test(lock.checksum ?? ''))
      throw new Error(`Missing registry archive checksum: ${identity}`);
    if (source === 'workspace' && (entry.source || lock.checksum))
      throw new Error(`Unexpected local package source: ${identity}`);
    const packageRoot = dirname(realpathSync(entry.manifest_path));
    const localPath =
      source === 'workspace' ? relative(root, packageRoot).replaceAll('\\', '/') : null;
    if (source === 'workspace' && (!localPath?.startsWith('crates/') || localPath.includes('../')))
      throw new Error(`Unexpected local package path: ${identity}`);
    const legal = rootLegalFiles(packageRoot).map(({ name, bytes, sha256: hash }) => {
      files.push({ identity, name, bytes, sha256: hash });
      return { name, sha256: hash };
    });
    return {
      name: entry.name,
      version: entry.version,
      source,
      ...(source === 'registry' ? { checksum: lock.checksum } : { path: localPath }),
      license: entry.license,
      rootLegalFiles: legal,
    };
  });
  const inventory = {
    schemaVersion: 1,
    source: {
      repository: 'https://github.com/Devolutions/IronRDP',
      tag: 'npm-iron-remote-desktop-rdp-v0.7.0',
      commit,
      cargoLockSha256,
    },
    target: 'wasm32-unknown-unknown',
    rootPackage: 'ironrdp-web@0.0.0',
    resolution:
      'cargo tree --locked --target wasm32-unknown-unknown --package ironrdp-web --edges normal,build',
    publishedJavaScriptSha256: installedJavaScriptSha256,
    publishedEmbeddedWasmSha256: embeddedWasmSha256,
    packageCount: packages.length,
    registryPackageCount: packages.filter((entry) => entry.source === 'registry').length,
    workspacePackageCount: packages.filter((entry) => entry.source === 'workspace').length,
    packageRootLegalFileCount: packages.reduce(
      (count, entry) => count + entry.rootLegalFiles.length,
      0,
    ),
    upstreamRootLegalFiles,
    packages,
    limitations: [
      'The target-specific root package is narrower than the full Cargo workspace or all-lockfile graph.',
      'Normal/build source dependencies include build-time and proc-macro crates; inclusion does not prove runtime WASM linkage.',
      'The npm attestation connects the tarball to this source commit, but a byte-for-byte WASM rebuild has not been achieved.',
      'Manifest license strings and available root texts do not select license alternatives or complete nested/file-level rights review.',
    ],
  };
  const violations = inventoryViolations(inventory);
  if (violations.length) throw new Error(violations.join('; '));
  return { inventory, files };
}

function bundleEntries(inventory) {
  return [
    ...inventory.upstreamRootLegalFiles.map((file) => ({
      identity: 'IronRDP tagged source root',
      ...file,
    })),
    ...inventory.packages.flatMap((entry) =>
      entry.rootLegalFiles.map((file) => ({ identity: `${entry.name}@${entry.version}`, ...file })),
    ),
  ];
}

function bundleIntroduction(inventory) {
  return Buffer.from(
    [
      'Axterm supplementary IronRDP WebAssembly-source root legal texts',
      '',
      `Source: ${inventory.source.repository} ${inventory.source.tag} (${inventory.source.commit})`,
      `Candidate target graph: ${inventory.rootPackage} / ${inventory.target}; ${inventory.packageCount} Cargo source packages; ${bundleEntries(inventory).length} preserved root legal files.`,
      'Original UTF-8 file bytes appear between BEGIN/END markers and are checked against pinned SHA-256 values.',
      'This includes build-time/proc-macro source packages; it does not assert exact WASM linkage, select a license option or grant rights clearance.',
      'Some crates have no own root legal file; nested notices, source-to-WASM reproduction and qualified review remain open.',
      '',
    ].join('\n') + '\n',
  );
}

function beginMarker(entry, bytes) {
  return Buffer.from(
    `===== BEGIN ${entry.identity} / ${entry.name} | ${bytes} bytes | SHA-256 ${entry.sha256} =====\n`,
  );
}

function endMarker(entry) {
  return Buffer.from(`\n===== END ${entry.identity} / ${entry.name} =====\n\n`);
}

export function ironRdpRootLicenseBundle(inventory, files) {
  const entries = bundleEntries(inventory);
  if (
    entries.length !== files.length ||
    files.some((file, index) =>
      ['identity', 'name', 'sha256'].some((key) => file[key] !== entries[index][key]),
    )
  ) {
    throw new Error('IronRDP source legal files do not match inventory order');
  }
  return Buffer.concat([
    bundleIntroduction(inventory),
    ...files.flatMap((entry) => [
      beginMarker(entry, entry.bytes.length),
      entry.bytes,
      endMarker(entry),
    ]),
  ]);
}

export function ironRdpRootLicenseBundleViolations(inventory, bundle) {
  const entries = bundleEntries(inventory);
  const violations = [];
  const preface = bundleIntroduction(inventory);
  if (!bundle.subarray(0, preface.length).equals(preface))
    return ['IronRDP root-license bundle introduction differs'];
  let offset = preface.length;
  for (const entry of entries) {
    const marker = /^===== BEGIN (.+) \/ (.+) \| (\d+) bytes \| SHA-256 ([a-f0-9]{64}) =====$/u;
    const endOfLine = bundle.indexOf(10, offset);
    if (endOfLine === -1)
      return [...violations, `Missing BEGIN marker: ${entry.identity}/${entry.name}`];
    const match = marker.exec(bundle.toString('utf8', offset, endOfLine));
    if (
      !match ||
      match[1] !== entry.identity ||
      match[2] !== entry.name ||
      match[4] !== entry.sha256
    ) {
      return [...violations, `Changed BEGIN marker: ${entry.identity}/${entry.name}`];
    }
    const length = Number(match[3]);
    if (!Number.isSafeInteger(length) || length < 0)
      return [...violations, `Invalid legal-file length: ${entry.identity}/${entry.name}`];
    offset = endOfLine + 1;
    const bytes = bundle.subarray(offset, offset + length);
    if (bytes.length !== length || sha256(bytes) !== entry.sha256)
      violations.push(`Changed original bytes: ${entry.identity}/${entry.name}`);
    if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes))
      violations.push(`Non-UTF-8 legal-file bytes: ${entry.identity}/${entry.name}`);
    offset += length;
    const end = endMarker(entry);
    if (!bundle.subarray(offset, offset + end.length).equals(end))
      return [...violations, `Changed END marker: ${entry.identity}/${entry.name}`];
    offset += end.length;
  }
  if (offset !== bundle.length) violations.push('Unexpected trailing IronRDP legal material');
  return violations;
}

export function ironRdpSourceSpdx(inventory, product) {
  const violations = inventoryViolations(inventory);
  if (violations.length) throw new Error(violations.join('; '));
  if (!product?.name || !product?.version) throw new Error('Product identity is required');
  const packages = inventory.packages.map((entry) => ({
    SPDXID: `SPDXRef-Cargo-${sha256(`${entry.name}\0${entry.version}`)}`,
    name: entry.name,
    versionInfo: entry.version,
    primaryPackagePurpose: 'SOURCE',
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: 'NOASSERTION',
    licenseDeclared: 'NOASSERTION',
    licenseComments: `Cargo manifest declaration: ${entry.license}. Applicable alternative and file-level scope have not been reviewed.`,
    copyrightText: 'NOASSERTION',
    sourceInfo:
      entry.source === 'registry'
        ? `Pinned crates.io archive checksum: ${entry.checksum}.`
        : `Tagged IronRDP workspace source: ${entry.path} at ${inventory.source.commit}.`,
    comment: `Target-root-reachable normal/build source package; inclusion does not prove WASM linkage. Available package-root legal files: ${entry.rootLegalFiles.length ? entry.rootLegalFiles.map(({ name, sha256: hash }) => `${name} (${hash})`).join(', ') : 'none'}.`,
    ...(entry.source === 'registry'
      ? {
          externalRefs: [
            {
              referenceCategory: 'PACKAGE-MANAGER',
              referenceType: 'purl',
              referenceLocator: `pkg:cargo/${encodeURIComponent(entry.name)}@${encodeURIComponent(entry.version)}`,
            },
          ],
        }
      : {}),
  }));
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${product.name} IronRDP WASM Cargo source-scope inventory`,
    documentNamespace: `https://axterm.dev/sbom/ironrdp-source/${encodeURIComponent(product.version)}/${sha256(JSON.stringify(inventory.packages))}`,
    creationInfo: {
      created: '2026-09-24T00:00:00Z',
      creators: ['Tool: Axterm IronRDP WASM source-scope SBOM generator'],
      licenseListVersion: '3.23',
      comment: `Tagged source ${inventory.source.repository} ${inventory.source.tag} (${inventory.source.commit}); Cargo.lock SHA-256 ${inventory.source.cargoLockSha256}.`,
    },
    documentDescribes: packages.map(({ SPDXID }) => SPDXID),
    comment: `Candidate ${inventory.target} normal/build graph rooted at ${inventory.rootPackage}: ${inventory.packageCount} source packages. It is separate from the Bun production SBOM and exact packaged-artifact sidecars. It includes build-time/proc-macro packages; it is not a source-to-WASM build proof or a license-selection/rights finding. Published embedded WASM SHA-256: ${inventory.publishedEmbeddedWasmSha256}.`,
    packages,
  };
}

async function formattedInventory(inventory) {
  return format(JSON.stringify(inventory), { parser: 'json' });
}

async function formattedSpdx(inventory) {
  return format(
    JSON.stringify(
      ironRdpSourceSpdx(inventory, JSON.parse(readFileSync(resolve(projectRoot, 'package.json')))),
    ),
    { parser: 'json' },
  );
}

export function ironRdpArtifactViolations(packaged) {
  const violations = [];
  if (
    !packaged.packages.some(
      ({ name, version }) => name === '@devolutions/iron-remote-desktop-rdp' && version === '0.7.0',
    )
  ) {
    violations.push('Packaged IronRDP npm identity is missing');
  }
  const legal = packaged.externalLegalFiles.find(
    ({ path }) => path === 'licenses/IronRDP-RUST-ROOT-LICENSES.txt',
  );
  if (legal?.sha256 !== legalBundleSha256)
    violations.push('Packaged IronRDP Rust root legal texts differ');
  const missingRootLegal = packaged.externalLegalFiles.find(
    ({ path }) => path === 'licenses/IronRDP-MISSING-CRATE-ROOT-LICENSES.txt',
  );
  if (missingRootLegal?.sha256 !== missingRootBundleSha256)
    violations.push('Packaged IronRDP missing-crate publisher root texts differ');
  const nestedSpinLegal = packaged.externalLegalFiles.find(
    ({ path }) => path === 'licenses/tracing-core-spin-LICENSE.txt',
  );
  if (nestedSpinLegal?.sha256 !== nestedSpinLicenseSha256)
    violations.push('Packaged tracing-core nested spin license differs');
  const sourceHeaders = packaged.externalLegalFiles.find(
    ({ path }) => path === 'licenses/IronRDP-SOURCE-HEADER-ATTRIBUTIONS.txt',
  );
  if (sourceHeaders?.sha256 !== sourceHeaderBundleSha256)
    violations.push('Packaged IronRDP source-header attributions differ');
  const apache = packaged.externalLegalFiles.find(
    ({ path }) => path === 'licenses/IronRDP-LICENSE-APACHE.txt',
  );
  if (apache?.sha256 !== 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30')
    violations.push('Packaged IronRDP upstream Apache text differs');
  const chunks = packaged.rendererAssetFiles.filter(({ path }) =>
    /^\/out\/renderer\/assets\/iron-remote-desktop-rdp-[^/]+\.js$/u.test(path),
  );
  if (chunks.length !== 1) violations.push('Expected one packaged IronRDP Renderer bundle');
  return violations;
}

export async function verifyIronRdpMacArtifact(resourcesDirectory, sidecarPath) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('IronRDP artifact comparison is scoped to macOS arm64');
  const inventoryText = readFileSync(inventoryPath, 'utf8');
  const sourceSpdx = readFileSync(spdxPath, 'utf8');
  const inventory = JSON.parse(inventoryText);
  const sourceViolations = inventoryViolations(inventory);
  if (
    sourceViolations.length ||
    sha256(inventoryText) !== inventorySha256 ||
    sha256(readFileSync(bundlePath)) !== legalBundleSha256 ||
    sha256(
      readFileSync(resolve(projectRoot, 'licenses/IronRDP-MISSING-CRATE-ROOT-LICENSES.txt')),
    ) !== missingRootBundleSha256 ||
    sha256(readFileSync(resolve(projectRoot, 'licenses/tracing-core-spin-LICENSE.txt'))) !==
      nestedSpinLicenseSha256 ||
    sha256(
      readFileSync(resolve(projectRoot, 'licenses/IronRDP-SOURCE-HEADER-ATTRIBUTIONS.txt')),
    ) !== sourceHeaderBundleSha256 ||
    sha256(sourceSpdx) !== sourceSpdxSha256 ||
    sourceSpdx !== (await formattedSpdx(inventory))
  ) {
    throw new Error(
      'Committed IronRDP source scope or legal texts differ from the pinned review target',
    );
  }
  const resources = resolve(resourcesDirectory);
  const packaged = inventoryPackagedResources(resources);
  const product = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
  await verifyPackagedArtifactSbomFromInventory(
    packaged,
    product,
    'macos-arm64',
    readFileSync(resolve(sidecarPath), 'utf8'),
  );
  const violations = ironRdpArtifactViolations(packaged);
  if (violations.length) throw new Error(violations.join('; '));
  const chunk = packaged.rendererAssetFiles.find(({ path }) =>
    /^\/out\/renderer\/assets\/iron-remote-desktop-rdp-[^/]+\.js$/u.test(path),
  );
  const appRequire = createRequire(resolve(projectRoot, 'apps/desktop/package.json'));
  const builderRequire = createRequire(appRequire.resolve('electron-builder'));
  const asar = builderRequire('@electron/asar');
  const bytes = asar.extractFile(join(resources, 'app.asar'), chunk.path.slice(1));
  if (sha256(bytes) !== chunk.sha256)
    throw new Error('Packaged IronRDP Renderer bundle differs from its SPDX entry');
  const wasm = /data:application\/wasm;base64,([A-Za-z0-9+/=]+)/u.exec(bytes.toString('utf8'));
  if (!wasm || sha256(Buffer.from(wasm[1], 'base64')) !== embeddedWasmSha256)
    throw new Error('Packaged IronRDP embedded WASM differs from the published target');
  return {
    sourcePackages: inventory.packageCount,
    sourceSpdxSha256,
    legalBundleSha256,
    publishedEmbeddedWasmSha256: embeddedWasmSha256,
    packagedAsarSha256: packaged.archiveSha256,
    limitation:
      'The package matches the pinned published WASM and candidate source-scope record; exact source-to-WASM build reproduction and rights review remain open.',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === '--generate' || mode === '--source-check') {
    if (!process.argv[3]) throw new Error(`Usage: ${mode} <IronRDP release-tag checkout>`);
    const { inventory, files } = sourceInventory(process.argv[3]);
    const json = await formattedInventory(inventory);
    const bundle = ironRdpRootLicenseBundle(inventory, files);
    const spdx = await formattedSpdx(inventory);
    if (mode === '--generate') {
      writeFileSync(inventoryPath, json);
      writeFileSync(bundlePath, bundle);
      writeFileSync(spdxPath, spdx);
      console.log(
        `Updated IronRDP WASM source inventory, SPDX and ${files.length} root legal texts.`,
      );
    } else if (
      readFileSync(inventoryPath, 'utf8') !== json ||
      !readFileSync(bundlePath).equals(bundle) ||
      readFileSync(spdxPath, 'utf8') !== spdx
    ) {
      throw new Error(
        'Committed IronRDP source inventory, SPDX or legal texts differ from tagged source',
      );
    } else
      console.log(
        `IronRDP WASM source matches ${inventory.packageCount} packages and ${files.length} legal files.`,
      );
  } else if (mode === '--check') {
    installedWasmIdentity();
    const text = readFileSync(inventoryPath, 'utf8');
    const bundle = readFileSync(bundlePath);
    const spdx = readFileSync(spdxPath, 'utf8');
    const inventory = JSON.parse(text);
    const violations = inventoryViolations(inventory);
    if (text !== (await formattedInventory(inventory)))
      violations.push('IronRDP inventory formatting differs');
    if (sha256(text) !== inventorySha256) violations.push('IronRDP pinned inventory hash differs');
    if (sha256(bundle) !== legalBundleSha256)
      violations.push('IronRDP pinned legal-bundle hash differs');
    if (sha256(spdx) !== sourceSpdxSha256)
      violations.push('IronRDP pinned source-SPDX hash differs');
    violations.push(...ironRdpRootLicenseBundleViolations(inventory, bundle));
    if (spdx !== (await formattedSpdx(inventory)))
      violations.push('IronRDP source-scope SPDX differs');
    if (violations.length) throw new Error(violations.join('; '));
    console.log(
      `IronRDP WASM source inventory matches ${inventory.packageCount} packages and ${bundleEntries(inventory).length} pinned legal files.`,
    );
  } else if (mode === '--artifact-check' && process.argv.length === 5) {
    console.log(
      JSON.stringify(await verifyIronRdpMacArtifact(process.argv[3], process.argv[4]), null, 2),
    );
  } else {
    throw new Error(
      'Usage: ironrdp-wasm-source-scope.mjs --generate|--source-check <checkout>|--check|--artifact-check <Resources> <packaged SPDX>',
    );
  }
}
