import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../..');

export const finalPublicPrerequisiteScripts = Object.freeze([
  'migration:record:removal-check',
  'licenses:components:check',
  'licenses:texts:check',
  'licenses:attribution:reviewed-check',
  'licenses:native:texts:check',
  'licenses:native:headers:check',
  'licenses:zstd:embedded:check',
  'licenses:napi:check',
  'licenses:native:reviewed-check',
  'licenses:ironrdp:source:check',
  'licenses:ironrdp:missing:check',
  'licenses:ironrdp:nested:check',
  'licenses:ironrdp:headers:check',
  'licenses:ironrdp:review:reviewed-check',
  'assets:check',
  'assets:marks:reviewed-check',
  'source:review:reviewed-check',
  'locales:check',
  'locales:navigation:reviewed-check',
  'locales:core:check',
  'locales:core:reviewed-check',
  'release:services:active-check',
  'release:updater-feed:active-check',
]);

export const finalPublicSnapshotScript = 'snapshot:final-public:check';

function parseArguments(argumentsList) {
  const normalized = argumentsList[0] === '--' ? argumentsList.slice(1) : argumentsList;
  if (normalized.length === 0) return [];
  if (
    normalized.length === 2 &&
    normalized[0] === '--exceptions' &&
    typeof normalized[1] === 'string' &&
    normalized[1].trim().length > 0
  ) {
    return normalized;
  }
  throw new Error(
    'Usage: node scripts/commercialization/check-final-public-release.mjs [--exceptions <approved-record.json>]',
  );
}

function normalizedGateResult(script, argumentsList, result) {
  return {
    script,
    argumentsList,
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 1,
    stdout: typeof result?.stdout === 'string' ? result.stdout : '',
    stderr: typeof result?.stderr === 'string' ? result.stderr : '',
  };
}

function invokeGate(runGate, script, argumentsList) {
  try {
    return normalizedGateResult(script, argumentsList, runGate(script, argumentsList));
  } catch (error) {
    return normalizedGateResult(script, argumentsList, {
      exitCode: 1,
      stderr: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Runs every promotion prerequisite so a release owner gets one complete
 * blocker list. The final source scan remains ordered last and is not run until
 * every prerequisite has passed.
 *
 * @param {{
 *   argumentsList?: string[],
 *   runGate: (script: string, argumentsList: string[]) => {
 *     exitCode?: number,
 *     stdout?: string,
 *     stderr?: string,
 *   },
 * }} options
 */
export function runFinalPublicReleaseChecks({ argumentsList = [], runGate }) {
  let snapshotArguments;
  try {
    snapshotArguments = parseArguments(argumentsList);
  } catch (error) {
    return {
      exitCode: 2,
      usageError: error instanceof Error ? error.message : String(error),
      prerequisiteResults: [],
      blockingScripts: [],
      snapshotResult: null,
      snapshotSkipped: true,
    };
  }

  const prerequisiteResults = finalPublicPrerequisiteScripts.map((script) =>
    invokeGate(runGate, script, []),
  );
  const blockingScripts = prerequisiteResults
    .filter((result) => result.exitCode !== 0)
    .map((result) => result.script);

  if (blockingScripts.length > 0) {
    return {
      exitCode: 1,
      usageError: null,
      prerequisiteResults,
      blockingScripts,
      snapshotResult: null,
      snapshotSkipped: true,
    };
  }

  const snapshotResult = invokeGate(runGate, finalPublicSnapshotScript, snapshotArguments);
  return {
    exitCode: snapshotResult.exitCode === 0 ? 0 : 1,
    usageError: null,
    prerequisiteResults,
    blockingScripts: snapshotResult.exitCode === 0 ? [] : [finalPublicSnapshotScript],
    snapshotResult,
    snapshotSkipped: false,
  };
}

function runBunScript(script, argumentsList) {
  const bunArguments = ['run', script];
  if (argumentsList.length > 0) bunArguments.push('--', ...argumentsList);
  const result = spawnSync('bun', bunArguments, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error instanceof Error ? result.error.message : ''),
  };
}

function writeGateResult(result) {
  const marker = result.exitCode === 0 ? 'PASS' : 'BLOCKED';
  const output = result.stdout.trim();
  const errorOutput = result.stderr.trim();
  console.log(`[${marker}] ${result.script}`);
  if (output.length > 0) console.log(output);
  if (errorOutput.length > 0) console.error(errorOutput);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outcome = runFinalPublicReleaseChecks({
    argumentsList: process.argv.slice(2),
    runGate: runBunScript,
  });

  if (outcome.usageError) {
    console.error(outcome.usageError);
  } else {
    for (const result of outcome.prerequisiteResults) writeGateResult(result);
    if (outcome.snapshotResult) writeGateResult(outcome.snapshotResult);

    if (outcome.snapshotSkipped) {
      console.error(
        `Final-public source snapshot skipped until ${outcome.blockingScripts.length} prerequisite gate(s) pass: ${outcome.blockingScripts.join(', ')}`,
      );
    } else if (outcome.exitCode === 0) {
      console.log('Final-public release promotion gate passed.');
    } else {
      console.error('Final-public release promotion gate is blocked by the source snapshot.');
    }
  }

  process.exitCode = outcome.exitCode;
}
