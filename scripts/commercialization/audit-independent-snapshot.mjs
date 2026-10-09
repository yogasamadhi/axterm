import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const blockedTopLevelPaths = new Set([
  '.git',
  '.gitmodules',
  'coverage',
  'dist',
  'out',
  'playwright-report',
  'release',
  'test-results',
]);
const blockedDirectoryNames = new Set(['node_modules']);
const blockedDirectories = new Set([
  'docs/product/assets',
  'scripts/parity',
  'tests/parity',
  'vendor/legacy-prototype',
  'packages/runtime/src/adapters/terminal-transfer/legacy-prototype',
]);
// Retired direct-source/data inputs under ADR-016/ADR-021. Production
// compatibility entry points are removed; the transition-boundary audit
// separately guards any residual historical data identifiers.
const blockedRetiredProductSourceFiles = new Set([
  'apps/desktop/src/renderer/src/i18n/legacy-prototype-locales.generated.json',
  'packages/runtime/src/adapters/widget/legacy-prototype-local-ftp-server.ts',
  'packages/runtime/src/application/legacy-prototype-terminal-themes.generated.ts',
  'scripts/generate-legacy-prototype-themes.mjs',
  'scripts/localization/generate-legacy-prototype-locales.mjs',
]);
// Explicit historical-evidence exclusions. The two unused export fixtures
// are byte-identical to entries in the private W-14-01 source archive. The
// documentation records describe retired upstream/parity or migration-period
// state, not current release policy. Keep the checkout intact.
const archivedHistoricalEvidenceFiles = new Set([
  'docs/implementation/LEGACY_PROTOTYPE_TRANSITION_BOUNDARY.md',
  'docs/product/LEGACY_PROTOTYPE_DESIGN_TOKENS.md',
  'docs/implementation/evidence/IR08-LEGACY_PROTOTYPE-OLD-CSV-WORKFLOW-2026-09-24.md',
  'docs/implementation/evidence/IR08-LEGACY_PROTOTYPE-UI-EXPORT-2026-09-23.md',
  'docs/implementation/evidence/IR08-HISTORICAL-PACKAGE-UPGRADE-REVALIDATION-2026-09-24.md',
  'docs/implementation/evidence/IR08-MACOS-HISTORICAL-CUSTOM-THEME-2026-09-25.md',
  'tests/fixtures/migration/legacy-prototype-data-tool-2.1.10-neDB-export.json',
  'tests/fixtures/migration/legacy-prototype-v1.101.16-ui-export-v1.json',
]);
const operatingSystemMetadataNames = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const maximumSourceFileBytes = 5 * 1024 * 1024;
const transientArtifactExtensions = new Set(['.har', '.mp4', '.trace', '.webm']);
const prohibitedGeneratedArtifacts = new Set(['docs/api/openapi.json']);
const credentialContainerSuffixes = [
  '.jks',
  '.kdbx',
  '.keystore',
  '.p12',
  '.p8',
  '.pfx',
  '.ppk',
  '.snk',
];
const persistentStateDatabaseSuffixes = [
  '.db',
  '.db-journal',
  '.db-shm',
  '.db-wal',
  '.sqlite',
  '.sqlite-journal',
  '.sqlite-shm',
  '.sqlite-wal',
  '.sqlite3',
  '.sqlite3-journal',
  '.sqlite3-shm',
  '.sqlite3-wal',
];
const privateKeyFileNames = new Set(['id_dsa', 'id_ecdsa', 'id_ed25519', 'id_rsa']);
const highConfidenceTokenPatterns = [
  ['AWS access key', /(?:AKIA|ASIA)[A-Z0-9]{16}/gu],
  ['GitHub token', /(?:github_pat_[A-Za-z0-9_]{20,}|gh[psor]_[A-Za-z0-9]{20,})/gu],
  ['GitLab token', /glpat-[A-Za-z0-9_-]{20,}/gu],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/gu],
  ['npm token', /npm_[A-Za-z0-9]{36}/gu],
  ['OpenAI API key', /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/gu],
  ['PyPI token', /pypi-[A-Za-z0-9_-]{50,}/gu],
  ['Slack token', /xox[baprs]-\d{6,}-\d{6,}-[A-Za-z0-9-]{16,}/gu],
  ['Stripe key', /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/gu],
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu],
];
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const lockfileMarkers = [
  '@legacy-prototype/',
  '@legacy-prototype/ftp-srv',
  'legacy-prototype-locales',
  'legacy-prototype-themes',
  'vendor/legacy-prototype',
];

/**
 * Paths deliberately omitted when preparing the source-only Stage-5 snapshot.
 * The audit still rejects any excluded material that arrives in the prepared
 * copy through a different route (for example a symlink).
 */
export function isExcludedFromIndependentSnapshot(snapshotPath) {
  const path = snapshotPath.replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!path) return false;
  const segments = path.split('/');
  const topLevel = segments[0];
  // ADR-027: include only the pinned Pi engine inputs, never its Git metadata or CLI.
  if (topLevel === 'vendor') {
    if (
      segments.some((segment) => ['.git', 'node_modules', 'dist'].includes(segment)) ||
      segments.some((segment) => operatingSystemMetadataNames.has(segment))
    )
      return true;
    if (['vendor', 'vendor/pi', 'vendor/pi/packages'].includes(path)) return false;
    if (['vendor/pi/LICENSE', 'vendor/pi/nix', 'vendor/pi/nix/model-catalog.json'].includes(path))
      return false;
    if (/^vendor\/pi\/packages\/(ai|agent|telemetry)$/u.test(path)) return false;
    if (/^vendor\/pi\/packages\/(ai|agent|telemetry)\/src(?:\/|$)/u.test(path)) return false;
    if (/^vendor\/pi\/packages\/coding-agent(?:\/src(?:\/(?:core|utils))?)?$/u.test(path))
      return false;
    if (
      /^vendor\/pi\/packages\/coding-agent\/src\/(?:config\.ts|core\/(?:skills|source-info|diagnostics)\.ts|utils\/(?:frontmatter|text|paths|child-process)\.ts)$/u.test(
        path,
      )
    )
      return false;
    if (
      path === 'vendor/pi/packages/ai/scripts' ||
      /^vendor\/pi\/packages\/ai\/scripts\/(hydrate-model-catalog|model-data)\.ts$/u.test(path)
    )
      return false;
    return true;
  }
  const excludedDirectoryNames = new Set([
    '.git',
    'vendor',
    'node_modules',
    ...blockedTopLevelPaths,
  ]);
  if (
    segments.some((segment) => operatingSystemMetadataNames.has(segment)) ||
    segments.some((segment) => excludedDirectoryNames.has(segment)) ||
    topLevel === '.gitmodules' ||
    topLevel === 'vendor'
  ) {
    return true;
  }
  if (path === 'scripts/parity' || path.startsWith('scripts/parity/')) return true;
  if (path === 'tests/parity' || path.startsWith('tests/parity/')) return true;
  if (archivedHistoricalEvidenceFiles.has(path)) return true;
  return isEnvironmentFile(path);
}

function normalizedPath(root, path) {
  return relative(root, path).replaceAll('\\', '/');
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function isEnvironmentFile(path) {
  const name = basename(path);
  return (name === '.env' || name.startsWith('.env.')) && name !== '.env.example';
}

function isOperatingSystemMetadata(path) {
  return operatingSystemMetadataNames.has(basename(path));
}

function isTransientTestArtifact(path) {
  const normalized = path.replaceAll('\\', '/').toLowerCase();
  const name = basename(normalized);
  if (transientArtifactExtensions.has(name.slice(name.lastIndexOf('.')))) return true;
  return name === 'trace.zip' || (normalized.includes('/traces/') && name.endsWith('.zip'));
}

function isProhibitedGeneratedArtifact(path) {
  return prohibitedGeneratedArtifacts.has(path.replaceAll('\\', '/'));
}

function sensitiveArtifactKind(path) {
  const name = basename(path).toLowerCase();
  if (privateKeyFileNames.has(name)) return 'private-key filename';
  if (credentialContainerSuffixes.some((suffix) => name.endsWith(suffix))) {
    return 'credential container';
  }
  if (persistentStateDatabaseSuffixes.some((suffix) => name.endsWith(suffix))) {
    return 'persistent state database';
  }
  return undefined;
}

function isBlockedPath(path, stat) {
  if (blockedTopLevelPaths.has(path)) return true;
  if (
    blockedDirectories.has(path) ||
    blockedRetiredProductSourceFiles.has(path) ||
    archivedHistoricalEvidenceFiles.has(path)
  )
    return true;
  return stat.isDirectory() && blockedDirectoryNames.has(basename(path));
}

export function collectSnapshotEntries(root) {
  const files = [];
  const forbiddenEntries = [];
  const environmentFiles = [];
  const oversizedFiles = [];
  const symbolicLinks = [];
  const transientArtifacts = [];
  const prohibitedGeneratedFiles = [];
  const sensitiveArtifacts = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = resolve(directory, entry.name);
      const snapshotPath = normalizedPath(root, path);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        symbolicLinks.push(snapshotPath);
        continue;
      }
      if (isOperatingSystemMetadata(snapshotPath)) {
        forbiddenEntries.push(snapshotPath);
        continue;
      }
      if (isBlockedPath(snapshotPath, stat)) {
        forbiddenEntries.push(snapshotPath);
        continue;
      }
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!stat.isFile()) {
        forbiddenEntries.push(`${snapshotPath} (unsupported filesystem entry)`);
        continue;
      }
      if (isTransientTestArtifact(snapshotPath)) {
        transientArtifacts.push(snapshotPath);
        continue;
      }
      if (isProhibitedGeneratedArtifact(snapshotPath)) {
        prohibitedGeneratedFiles.push(snapshotPath);
        continue;
      }
      const sensitiveKind = sensitiveArtifactKind(snapshotPath);
      if (sensitiveKind) {
        sensitiveArtifacts.push({ path: snapshotPath, kind: sensitiveKind });
        continue;
      }
      if (stat.size > maximumSourceFileBytes) {
        oversizedFiles.push({ path: snapshotPath, bytes: stat.size });
        continue;
      }
      if (isEnvironmentFile(path)) environmentFiles.push(snapshotPath);
      const content = readFileSync(path);
      files.push({ path: snapshotPath, bytes: content.byteLength, sha256: sha256(content) });
    }
  }

  visit(root);
  return {
    files,
    forbiddenEntries: forbiddenEntries.sort(),
    environmentFiles: environmentFiles.sort(),
    oversizedFiles: oversizedFiles.sort((left, right) => left.path.localeCompare(right.path)),
    symbolicLinks: symbolicLinks.sort(),
    transientArtifacts: transientArtifacts.sort(),
    prohibitedGeneratedFiles: prohibitedGeneratedFiles.sort(),
    sensitiveArtifacts: sensitiveArtifacts.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

function packageViolations(root, files) {
  const violations = [];
  for (const { path } of files.filter((file) => basename(file.path) === 'package.json')) {
    const manifestPath = resolve(root, path);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      violations.push(`${path}: invalid JSON`);
      continue;
    }
    for (const field of dependencyFields) {
      const dependencies = manifest[field];
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))
        continue;
      for (const [name, specifier] of Object.entries(dependencies)) {
        if (
          name.startsWith('@legacy-prototype/') ||
          (typeof specifier === 'string' &&
            /(?:^|[/\\])vendor[/\\]legacy-prototype(?:[/\\]|$)/u.test(specifier))
        ) {
          violations.push(`${path}: ${field}.${name}`);
        }
      }
    }
  }
  return violations.sort();
}

function lockfileViolations(root) {
  const lockfilePath = resolve(root, 'bun.lock');
  if (!existsSync(lockfilePath)) return ['bun.lock: missing'];
  const lockfile = readFileSync(lockfilePath, 'utf8');
  return lockfileMarkers
    .filter((marker) => lockfile.includes(marker))
    .map((marker) => `bun.lock: ${marker}`);
}

function hasCompletePrivateKey(content) {
  const pemBlocks = content.matchAll(
    /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----\r?\n([\s\S]*?)\r?\n-----END (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/gu,
  );
  for (const block of pemBlocks) {
    const encodedBody = block[1].replaceAll(/\s/gu, '');
    if (encodedBody.length >= 256 && /^[A-Za-z0-9+/=]+$/u.test(encodedBody)) return true;
  }
  return false;
}

/**
 * Finds only formats that have a high probability of being usable credentials.
 * It intentionally returns paths and classifications, never the matched values.
 * A passing result does not replace release-owner secret review or a secrets
 * manager's history scan.
 */
function highConfidenceSecretFindings(root, files) {
  const findings = [];
  for (const { path } of files) {
    const content = readFileSync(resolve(root, path), 'utf8');
    const types = [];
    if (hasCompletePrivateKey(content)) types.push('PEM private key');
    for (const [type, pattern] of highConfidenceTokenPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) types.push(type);
    }
    if (types.length > 0) findings.push({ path, types });
  }
  return findings.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Audits a source copy prepared for an independent release. It intentionally
 * does not interpret legacy migration strings as a failure: that decision is
 * gated by the later public-migration removal release, not by this snapshot
 * hygiene check.
 */
export function auditIndependentSnapshot(snapshotDirectory) {
  const root = resolve(snapshotDirectory);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    throw new Error(`Snapshot directory does not exist: ${root}`);
  }
  const entries = collectSnapshotEntries(root);
  const packageDependencyViolations = packageViolations(root, entries.files);
  const lockfileDependencyViolations = lockfileViolations(root);
  const highConfidenceSecrets = highConfidenceSecretFindings(root, entries.files);
  const manifest = entries.files
    .map(({ path, bytes, sha256: hash }) => `${path}\0${bytes}\0${hash}`)
    .join('\n');
  const violations = [
    ...entries.forbiddenEntries,
    ...entries.environmentFiles.map((path) => `${path} (environment file)`),
    ...entries.oversizedFiles.map(
      ({ path, bytes }) => `${path} (${bytes} bytes exceeds ${maximumSourceFileBytes} byte limit)`,
    ),
    ...entries.symbolicLinks.map((path) => `${path} (symbolic link)`),
    ...entries.transientArtifacts.map((path) => `${path} (transient test artifact)`),
    ...entries.prohibitedGeneratedFiles.map((path) => `${path} (prohibited generated artifact)`),
    ...entries.sensitiveArtifacts.map(({ path, kind }) => `${path} (${kind})`),
    ...highConfidenceSecrets.flatMap(({ path, types }) =>
      types.map((type) => `${path} (high-confidence secret: ${type})`),
    ),
    ...packageDependencyViolations,
    ...lockfileDependencyViolations,
  ].sort();
  return {
    schemaVersion: 1,
    sourceFiles: entries.files.length,
    sourceBytes: entries.files.reduce((total, file) => total + file.bytes, 0),
    sourceTreeSha256: sha256(manifest),
    forbiddenEntries: entries.forbiddenEntries,
    environmentFiles: entries.environmentFiles,
    oversizedFiles: entries.oversizedFiles,
    symbolicLinks: entries.symbolicLinks,
    transientArtifacts: entries.transientArtifacts,
    prohibitedGeneratedFiles: entries.prohibitedGeneratedFiles,
    sensitiveArtifacts: entries.sensitiveArtifacts,
    highConfidenceSecrets,
    packageDependencyViolations,
    lockfileDependencyViolations,
    passed: violations.length === 0,
    violations,
    limitations: [
      'This validates snapshot hygiene, direct dependency markers, common credential/state containers and high-confidence textual secret formats; it is not a copyright, trademark, complete secret-content or source-rights review.',
      'This hygiene check does not prove that Legacy Prototype compatibility code and historical documents have been removed; ADR-021 requires separate source, bundle, and behavior review before the first public release.',
      'A passing copy does not prove that the owner created the final Git repository, signed installers or completed external-platform verification.',
    ],
  };
}

function parsedSnapshotPath(argumentsList) {
  const index = argumentsList.indexOf('--snapshot');
  return index < 0 ? undefined : argumentsList[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const snapshotPath = parsedSnapshotPath(process.argv.slice(2));
  if (!snapshotPath) {
    console.error(
      'Usage: node scripts/commercialization/audit-independent-snapshot.mjs --snapshot <path>',
    );
    process.exitCode = 2;
  } else {
    try {
      const report = auditIndependentSnapshot(snapshotPath);
      console.log(JSON.stringify(report, null, 2));
      if (!report.passed) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 2;
    }
  }
}
