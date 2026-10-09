import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditIndependentSnapshot,
  isExcludedFromIndependentSnapshot,
} from './audit-independent-snapshot.mjs';
import {
  auditFinalPublicSnapshot,
  readFinalPublicSnapshotExceptions,
} from './audit-final-public-snapshot.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');

/**
 * Creates a source-only copy before installation. The copy intentionally omits
 * working-tree metadata and output that cannot belong in the independent
 * source snapshot, then subjects the result to the same audit used by the
 * manual Stage-5 evidence process.
 */
export async function prepareIndependentSnapshot(
  sourceDirectory = repositoryRoot,
  { finalPublic = false, exceptionPath } = {},
) {
  const source = resolve(sourceDirectory);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'axterm-independent-snapshot-'));
  const snapshotDirectory = join(temporaryDirectory, 'source');
  await cp(source, snapshotDirectory, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (path) => !isExcludedFromIndependentSnapshot(relative(source, path)),
  });
  return {
    temporaryDirectory,
    snapshotDirectory,
    report: finalPublic
      ? auditFinalPublicSnapshot(snapshotDirectory, {
          exceptions: exceptionPath ? readFinalPublicSnapshotExceptions(exceptionPath) : [],
        })
      : auditIndependentSnapshot(snapshotDirectory),
  };
}

async function checkPreparedSnapshot({ keep, finalPublic, exceptionPath }) {
  const prepared = await prepareIndependentSnapshot(repositoryRoot, { finalPublic, exceptionPath });
  try {
    console.log(
      JSON.stringify(
        {
          ...prepared.report,
          ...(keep ? { snapshotDirectory: prepared.snapshotDirectory } : {}),
        },
        null,
        2,
      ),
    );
    if (!prepared.report.passed) process.exitCode = 1;
  } finally {
    if (!keep) await rm(prepared.temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argumentsList = process.argv.slice(2);
  const keep = argumentsList.includes('--keep');
  const finalPublic = argumentsList.includes('--final-public');
  const exceptionIndex = argumentsList.indexOf('--exceptions');
  const exceptionPath = exceptionIndex < 0 ? undefined : argumentsList[exceptionIndex + 1];
  const allowedArguments = new Set(['--check', '--keep', '--final-public', '--exceptions']);
  const flagArguments = argumentsList.filter(
    (_value, index) => exceptionIndex < 0 || index !== exceptionIndex + 1,
  );
  if (
    !argumentsList.includes('--check') ||
    new Set(flagArguments).size !== flagArguments.length ||
    flagArguments.some((value) => !allowedArguments.has(value)) ||
    (exceptionIndex >= 0 &&
      (!finalPublic ||
        !exceptionPath ||
        exceptionPath.startsWith('--') ||
        exceptionIndex !== argumentsList.length - 2))
  ) {
    console.error(
      'Usage: node scripts/commercialization/prepare-independent-snapshot.mjs --check [--keep] [--final-public] [--exceptions <approved-record.json>]',
    );
    process.exitCode = 2;
  } else {
    await checkPreparedSnapshot({ keep, finalPublic, exceptionPath });
  }
}
