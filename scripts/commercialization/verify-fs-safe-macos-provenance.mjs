import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const packageName = '@openclaw/fs-safe-darwin-arm64';
const packageVersion = '0.13.1';
const packageSpec = `${packageName}@${packageVersion}`;
const officialRegistry = 'https://registry.npmjs.org';
const workflowRunUrl = 'https://github.com/openclaw/fs-safe/actions/runs/35153270431/attempts/1';
const sourceCommit = '7022a0a10c53e36f34a467df68ed5614a1db1741';
const tarballSha512 =
  '7723c239f31524c5da3f6c89208c99aef2b74f242908476e86fbdf1f765b730ff84ab74a3f9ef8aa086024cf950958364fd4c41d337860134eeb3e768a2308de';
const tarballIntegrity =
  'sha512-dyPCOfMVJMXaP2yJIIyZrvK3TyQpCEduhvvfH3Zbcw/4SrdKP574qghgJM+VCVg2T9TEHTN4YBNO6z52iiMI3g==';
const nativeBinarySha256 = '78ca69b52d05da239bf50a6768867134265aace0195c8494f64f65b6d1ba6db0';
const slsaPredicate = 'https://slsa.dev/provenance/v1';

function digest(bytes, algorithm, encoding = 'hex') {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function runNpm(args, cwd) {
  try {
    return execFileSync('npm', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
      env: {
        ...process.env,
        npm_config_registry: officialRegistry,
        npm_config_userconfig: '/dev/null',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(
      `npm ${args[0]} failed: ${error.stderr?.toString('utf8').trim() ?? error.message}`,
      { cause: error },
    );
  }
}

export function fsSafeMacProvenanceViolations(evidence) {
  const violations = [];
  const verified = evidence.audit?.verified;
  if (
    !Array.isArray(evidence.audit?.invalid) ||
    evidence.audit.invalid.length !== 0 ||
    !Array.isArray(evidence.audit?.missing) ||
    evidence.audit.missing.length !== 0 ||
    !Array.isArray(verified) ||
    verified.length !== 1 ||
    verified[0]?.name !== packageName ||
    verified[0]?.version !== packageVersion ||
    ![officialRegistry, `${officialRegistry}/`].includes(verified[0]?.registry) ||
    verified[0]?.attestations?.provenance?.predicateType !== slsaPredicate
  ) {
    violations.push('npm CLI did not verify the exact official-registry provenance');
  }
  const statement = evidence.statement;
  if (
    statement?._type !== 'https://in-toto.io/Statement/v1' ||
    statement?.predicateType !== slsaPredicate ||
    statement?.subject?.length !== 1 ||
    statement.subject[0]?.name !== 'pkg:npm/%40openclaw/fs-safe-darwin-arm64@0.13.1' ||
    statement.subject[0]?.digest?.sha512 !== tarballSha512 ||
    statement.predicate?.buildDefinition?.externalParameters?.workflow?.repository !==
      'https://github.com/openclaw/fs-safe' ||
    statement.predicate?.buildDefinition?.externalParameters?.workflow?.ref !==
      'refs/tags/v0.13.1' ||
    statement.predicate?.buildDefinition?.externalParameters?.workflow?.path !==
      '.github/workflows/release.yml' ||
    !statement.predicate?.buildDefinition?.resolvedDependencies?.some(
      (entry) =>
        entry.uri === 'git+https://github.com/openclaw/fs-safe@refs/tags/v0.13.1' &&
        entry.digest?.gitCommit === sourceCommit,
    ) ||
    statement.predicate?.runDetails?.metadata?.invocationId !== workflowRunUrl
  ) {
    violations.push('Verified SLSA statement does not describe the pinned tag, commit and run');
  }
  if (
    evidence.run?.id !== 35153270431 ||
    evidence.run?.run_attempt !== 1 ||
    evidence.run?.status !== 'completed' ||
    evidence.run?.conclusion !== 'success' ||
    evidence.run?.event !== 'push' ||
    evidence.run?.head_branch !== 'v0.13.1' ||
    evidence.run?.head_sha !== sourceCommit ||
    evidence.run?.path !== '.github/workflows/release.yml'
  ) {
    violations.push('GitHub release workflow run does not match the pinned successful build');
  }
  if (evidence.archiveSha512 !== tarballSha512 || evidence.archiveIntegrity !== tarballIntegrity) {
    violations.push('Official registry tarball bytes/integrity differ from the attested subject');
  }
  if (
    evidence.archiveBinarySha256 !== nativeBinarySha256 ||
    evidence.installedBinarySha256 !== nativeBinarySha256 ||
    (evidence.packagedBinarySha256 !== undefined &&
      evidence.packagedBinarySha256 !== nativeBinarySha256)
  ) {
    violations.push('Archive, installed or packaged macOS native binding bytes differ');
  }
  return violations;
}

function installedBinary() {
  const desktopRequire = createRequire(resolve(repositoryRoot, 'apps/desktop/package.json'));
  const parentManifest = desktopRequire.resolve('@openclaw/fs-safe/package.json');
  return readFileSync(createRequire(parentManifest).resolve(packageName));
}

function packagedBinary(appPath) {
  return readFileSync(
    join(
      appPath,
      'Contents/Resources/app.asar.unpacked/node_modules/@openclaw/fs-safe-darwin-arm64/fs-safe-native.node',
    ),
  );
}

async function githubRun() {
  const response = await globalThis.fetch(
    'https://api.github.com/repos/openclaw/fs-safe/actions/runs/35153270431',
    {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'axterm-provenance-audit' },
      signal: globalThis.AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error(`GitHub Actions run request failed: HTTP ${response.status}`);
  return response.json();
}

export async function verifyFsSafeMacProvenance(appPath) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('This proof is scoped to macOS arm64 only');
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'axterm-fs-safe-provenance-'));
  try {
    runNpm(
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', packageSpec],
      temporaryDirectory,
    );
    const audit = JSON.parse(
      runNpm(['audit', 'signatures', '--json', '--include-attestations'], temporaryDirectory),
    );
    const attestation = audit.verified?.[0]?.attestationBundles?.find(
      (entry) => entry.predicateType === slsaPredicate,
    );
    const statement = attestation?.bundle?.dsseEnvelope?.payload
      ? JSON.parse(Buffer.from(attestation.bundle.dsseEnvelope.payload, 'base64').toString('utf8'))
      : null;
    const packages = JSON.parse(
      runNpm(
        ['pack', packageSpec, '--json', '--pack-destination', temporaryDirectory],
        temporaryDirectory,
      ),
    );
    const archiveName = packages?.[0]?.filename;
    if (
      packages.length !== 1 ||
      archiveName !== 'openclaw-fs-safe-darwin-arm64-0.13.1.tgz' ||
      basename(archiveName) !== archiveName
    ) {
      throw new Error('npm pack returned an unexpected archive');
    }
    const archivePath = join(temporaryDirectory, archiveName);
    const archive = readFileSync(archivePath);
    const archiveBinary = execFileSync(
      'tar',
      ['-xOzf', archivePath, 'package/fs-safe-native.node'],
      {
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const evidence = {
      audit,
      statement,
      run: await githubRun(),
      archiveSha512: digest(archive, 'sha512'),
      archiveIntegrity: `sha512-${digest(archive, 'sha512', 'base64')}`,
      archiveBinarySha256: digest(archiveBinary, 'sha256'),
      installedBinarySha256: digest(installedBinary(), 'sha256'),
      ...(appPath
        ? { packagedBinarySha256: digest(packagedBinary(resolve(appPath)), 'sha256') }
        : {}),
    };
    const violations = fsSafeMacProvenanceViolations(evidence);
    if (violations.length) throw new Error(violations.join('; '));
    return {
      schemaVersion: 1,
      package: packageSpec,
      sourceCommit,
      workflowRunUrl,
      tarballSha512,
      nativeBinarySha256,
      verifiedOfficialRegistryProvenance: true,
      packagedAppCompared: Boolean(appPath),
      limitations: [
        'npm provenance links the published tarball to a source commit and release workflow; it does not prove file-level authorship, a fully reproducible native build, applicable license choice or legal clearance.',
        'Only the specified macOS arm64 installed binary is compared; other platforms and final signed installers require separate verification.',
      ],
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appPath = process.argv[2] === '--app' ? process.argv[3] : undefined;
  if (process.argv.length > (appPath ? 4 : 2) || (process.argv[2] === '--app' && !appPath)) {
    console.error('Usage: verify-fs-safe-macos-provenance.mjs [--app <Axterm.app>]');
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await verifyFsSafeMacProvenance(appPath), null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
