import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const registry = 'https://registry.npmjs.org/';
const packageName = '@devolutions/iron-remote-desktop-rdp';
const version = '0.7.0';
const expectedIntegrity =
  'sha512-CclAh4OS9aBoPJT0l7bih7ETOHPnB9KjT0drB0a6r5+Qh95pTEuQCx7uFN/XA2AlkFlrqx+DBAMDGYXmgsjHAQ==';
const expectedJavaScriptSha256 = 'b008f0e258fd9485c6f2b07747116d4fcbbe51053ce995abd048fb2b79636332';
const sourceCommit = 'e45f68c7e52297ca50d33b44c0ace36c9940fbe6';
const workflow = {
  repository: 'https://github.com/Devolutions/IronRDP',
  path: '.github/workflows/npm-publish.yml',
  ref: 'refs/heads/master',
};
const runUrl = 'https://github.com/Devolutions/IronRDP/actions/runs/26511159700/attempts/1';
const subjectName = 'pkg:npm/%40devolutions/iron-remote-desktop-rdp@0.7.0';
const publishPredicate = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';
const provenancePredicate = 'https://slsa.dev/provenance/v1';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function statementFromBundle(bundle, expectedPredicate) {
  if (bundle?.predicateType !== expectedPredicate || !bundle.bundle?.dsseEnvelope?.payload)
    throw new Error(`Missing verified ${expectedPredicate} bundle`);
  let statement;
  try {
    statement = JSON.parse(Buffer.from(bundle.bundle.dsseEnvelope.payload, 'base64').toString());
  } catch {
    throw new Error(`Malformed ${expectedPredicate} statement`);
  }
  if (statement.predicateType !== expectedPredicate) {
    throw new Error(`Attestation predicate differs from its verified bundle: ${expectedPredicate}`);
  }
  const subject = statement.subject;
  const expectedDigest = Buffer.from(expectedIntegrity.slice('sha512-'.length), 'base64').toString(
    'hex',
  );
  if (
    !Array.isArray(subject) ||
    subject.length !== 1 ||
    subject[0]?.name !== subjectName ||
    subject[0]?.digest?.sha512 !== expectedDigest
  ) {
    throw new Error(`Attestation subject differs from the locked ${packageName} tarball`);
  }
  return statement;
}

/** Interpret npm CLI's cryptographically verified result; this does not verify signatures itself. */
export function inspectIronRdpNpmProvenance(report) {
  if (!Array.isArray(report?.invalid) || report.invalid.length > 0)
    throw new Error('npm reported an invalid registry signature or attestation');
  if (!Array.isArray(report?.missing) || report.missing.length > 0)
    throw new Error('npm reported a missing registry signature or attestation');
  const verified = report.verified;
  if (!Array.isArray(verified) || verified.length !== 1)
    throw new Error('Expected exactly one verified IronRDP npm package');
  const entry = verified[0];
  if (entry.name !== packageName || entry.version !== version || entry.registry !== registry)
    throw new Error('The verified package identity or registry changed');
  const bundles = entry.attestationBundles;
  if (!Array.isArray(bundles)) throw new Error('npm returned no verified attestation bundles');
  const publication = statementFromBundle(
    bundles.find((bundle) => bundle.predicateType === publishPredicate),
    publishPredicate,
  );
  const provenance = statementFromBundle(
    bundles.find((bundle) => bundle.predicateType === provenancePredicate),
    provenancePredicate,
  );
  if (
    publication.predicate?.name !== packageName ||
    publication.predicate?.version !== version ||
    publication.predicate?.registry !== new URL(registry).origin
  ) {
    throw new Error('The verified npm publication statement changed');
  }
  const build = provenance.predicate?.buildDefinition;
  const publishedWorkflow = build?.externalParameters?.workflow;
  if (
    publishedWorkflow?.repository !== workflow.repository ||
    publishedWorkflow?.path !== workflow.path ||
    publishedWorkflow?.ref !== workflow.ref ||
    build?.internalParameters?.github?.event_name !== 'workflow_dispatch' ||
    !build?.resolvedDependencies?.some(
      (dependency) =>
        dependency.uri === `git+${workflow.repository}@${workflow.ref}` &&
        dependency.digest?.gitCommit === sourceCommit,
    ) ||
    provenance.predicate?.runDetails?.builder?.id !==
      'https://github.com/actions/runner/github-hosted' ||
    provenance.predicate?.runDetails?.metadata?.invocationId !== runUrl
  ) {
    throw new Error('The verified IronRDP source commit or publisher workflow changed');
  }
  return {
    package: `${packageName}@${version}`,
    npmIntegrity: expectedIntegrity,
    sourceCommit,
    workflowRun: runUrl,
    verifiedAttestations: [publishPredicate, provenancePredicate],
  };
}

async function runNpm(directory, argumentsList) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const { stdout } = await execFileAsync(command, argumentsList, {
    cwd: directory,
    env: { ...process.env, npm_config_registry: registry },
    shell: process.platform === 'win32',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

export async function verifyIronRdpNpmProvenance() {
  const desktop = JSON.parse(await readFile(resolve(projectRoot, 'apps/desktop/package.json')));
  if (desktop.dependencies?.[packageName] !== version)
    throw new Error('The desktop IronRDP dependency version changed');
  const lock = await readFile(resolve(projectRoot, 'bun.lock'), 'utf8');
  const matchingLockLines = lock
    .split('\n')
    .filter((line) =>
      /^\s*"@devolutions\/iron-remote-desktop-rdp": \["@devolutions\/iron-remote-desktop-rdp@0\.7\.0",/u.test(
        line,
      ),
    );
  if (matchingLockLines.length !== 1 || !matchingLockLines[0].includes(`"${expectedIntegrity}"`))
    throw new Error('The Bun lock no longer pins the reviewed IronRDP tarball');
  const existingJavaScript = await readFile(
    resolve(
      projectRoot,
      'apps/desktop/node_modules/@devolutions/iron-remote-desktop-rdp/iron-remote-desktop-rdp.js',
    ),
  );
  if (sha256(existingJavaScript) !== expectedJavaScriptSha256)
    throw new Error('The frozen Bun install no longer matches the reviewed IronRDP JavaScript');

  const directory = await mkdtemp(join(tmpdir(), 'axterm-ironrdp-provenance-'));
  try {
    await runNpm(directory, [
      'install',
      '--save-exact',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      `--registry=${registry}`,
      `${packageName}@${version}`,
    ]);
    const npmLock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
    const npmEntry = npmLock.packages?.[`node_modules/${packageName}`];
    if (npmEntry?.integrity !== expectedIntegrity || !npmEntry.resolved?.startsWith(registry))
      throw new Error('The isolated npm package does not match the Bun-locked tarball');
    const npmJavaScript = await readFile(
      join(directory, 'node_modules', packageName, 'iron-remote-desktop-rdp.js'),
    );
    if (!npmJavaScript.equals(existingJavaScript))
      throw new Error('The isolated npm tarball differs from the frozen Bun install');
    const output = await runNpm(directory, [
      'audit',
      'signatures',
      '--json',
      '--include-attestations',
      `--registry=${registry}`,
    ]);
    return inspectIronRdpNpmProvenance(JSON.parse(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--check') throw new Error('Use --check');
  console.log(JSON.stringify(await verifyIronRdpNpmProvenance(), null, 2));
}
