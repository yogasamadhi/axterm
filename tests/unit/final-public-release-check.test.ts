import { describe, expect, it } from 'vitest';
import {
  finalPublicPrerequisiteScripts,
  finalPublicSnapshotScript,
  runFinalPublicReleaseChecks,
} from '../../scripts/commercialization/check-final-public-release.mjs';

type GateCall = { script: string; argumentsList: string[] };

function passingResult() {
  return { exitCode: 0, stdout: 'passed', stderr: '' };
}

describe('final-public release promotion gate', () => {
  it('reports every failed prerequisite in one run and skips the final snapshot', () => {
    const calls: GateCall[] = [];
    const blocked = new Set([
      'migration:record:removal-check',
      'licenses:native:reviewed-check',
      'licenses:ironrdp:review:reviewed-check',
      'assets:marks:reviewed-check',
      'source:review:reviewed-check',
      'release:services:active-check',
      'release:updater-feed:active-check',
    ]);

    const result = runFinalPublicReleaseChecks({
      runGate(script: string, argumentsList: string[]) {
        calls.push({ script, argumentsList });
        return blocked.has(script)
          ? { exitCode: 1, stdout: '', stderr: `${script} is pending` }
          : passingResult();
      },
    });

    expect(calls).toEqual(
      finalPublicPrerequisiteScripts.map((script) => ({ script, argumentsList: [] })),
    );
    expect(calls.some(({ script }) => script === finalPublicSnapshotScript)).toBe(false);
    expect(result).toMatchObject({
      exitCode: 1,
      blockingScripts: [...blocked],
      snapshotResult: null,
      snapshotSkipped: true,
    });
  });

  it('runs the final snapshot last and forwards only its approved exception record', () => {
    const calls: GateCall[] = [];
    const exceptionPath = '/controlled/review/final-public-exceptions.json';

    const result = runFinalPublicReleaseChecks({
      argumentsList: ['--', '--exceptions', exceptionPath],
      runGate(script: string, argumentsList: string[]) {
        calls.push({ script, argumentsList });
        return passingResult();
      },
    });

    expect(calls.at(-1)).toEqual({
      script: finalPublicSnapshotScript,
      argumentsList: ['--exceptions', exceptionPath],
    });
    expect(calls.slice(0, -1).every(({ argumentsList }) => argumentsList.length === 0)).toBe(true);
    expect(finalPublicPrerequisiteScripts).toContain('release:updater-feed:active-check');
    expect(finalPublicPrerequisiteScripts).toContain('licenses:native:texts:check');
    expect(finalPublicPrerequisiteScripts).toContain('licenses:native:headers:check');
    expect(finalPublicPrerequisiteScripts).toContain('licenses:zstd:embedded:check');
    expect(finalPublicPrerequisiteScripts).toContain('licenses:napi:check');
    expect(finalPublicPrerequisiteScripts).toContain('licenses:native:reviewed-check');
    expect(finalPublicPrerequisiteScripts).toContain('licenses:ironrdp:source:check');
    expect(finalPublicPrerequisiteScripts).toContain('licenses:ironrdp:missing:check');
    expect(finalPublicPrerequisiteScripts).toContain('licenses:ironrdp:nested:check');
    expect(finalPublicPrerequisiteScripts).toContain('licenses:ironrdp:headers:check');
    expect(finalPublicPrerequisiteScripts).toContain('licenses:ironrdp:review:reviewed-check');
    expect(finalPublicPrerequisiteScripts).toContain('source:review:reviewed-check');
    expect(result).toMatchObject({
      exitCode: 0,
      blockingScripts: [],
      snapshotSkipped: false,
    });
  });

  it('rejects ambiguous arguments before invoking any release gate', () => {
    const calls: GateCall[] = [];
    const result = runFinalPublicReleaseChecks({
      argumentsList: ['--exceptions'],
      runGate(script: string, argumentsList: string[]) {
        calls.push({ script, argumentsList });
        return passingResult();
      },
    });

    expect(calls).toEqual([]);
    expect(result.exitCode).toBe(2);
    expect(result.usageError).toContain('Usage:');
  });
});
