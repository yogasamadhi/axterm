import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  macArtifactViolations,
  minimumReleaseRecordViolations,
  minimumTechnicalScripts,
  runMinimumCommercialReleaseChecks,
} from '../../scripts/commercialization/check-minimum-commercial-release.mjs';

const commit = 'a'.repeat(40);
const dmg = 'b'.repeat(64);
const app = 'c'.repeat(64);

function approvedRecord() {
  return {
    schemaVersion: 1,
    contentRights: {
      approvedBy: 'Release owner',
      approvedAt: '2026-09-26',
      contributorAuthority: 'Named contributor and ownership decision',
      sourceLineageDecision: 'Exact retained source decision',
      assetAndLocaleDecision: 'Icon and four-language decision',
      noticeDecision: 'Source and packaged notice decision',
      evidence: ['controlled rights review record'],
    },
    macDelivery: {
      sourceCommit: commit,
      appSha256: app,
      dmgSha256: dmg,
      downloadedSha256: dmg,
      developerIdTeamId: 'TEAMID1234',
      notarizationId: 'notary-job-id',
      appPath: '/tmp/verified/Axterm.app',
      appAsarPath: '/tmp/verified/Axterm.app/Contents/Resources/app.asar',
      dmgPath: '/tmp/verified/local.dmg',
      downloadedDmgPath: '/tmp/verified/downloaded.dmg',
      downloadUrl: 'https://release.axterm.org/Axterm.dmg',
      gatekeeperAndInstallEvidence: ['Gatekeeper and installed-app receipt'],
      terminalAndSshEvidence: ['terminal and SSH test receipt'],
      legalTextEvidence: ['About and package notices receipt'],
    },
    publicAccess: {
      repositoryUrl: 'https://code.axterm.org/project',
      releaseUrl: 'https://release.axterm.org/version',
      privacyUrl: 'https://release.axterm.org/privacy',
      securityUrl: 'https://release.axterm.org/security',
      supportUrl: 'https://release.axterm.org/support',
      updateMode: 'manual',
      windowsLinuxStatus: 'owner-self-test-pending',
      evidence: ['public page and download verification'],
    },
    ownerAcceptance: {
      approvedBy: 'Release owner',
      approvedAt: '2026-09-26',
      sourceCommit: commit,
      dmgSha256: dmg,
      windowsLinuxStatus: 'owner-self-test-pending',
      unresolvedRisks: [],
      evidence: ['signed owner acceptance'],
    },
  };
}

describe('minimum commercial release evidence gate', () => {
  it('runs the scoped technical checks but keeps all four owner/evidence conditions pending', () => {
    const calls: string[] = [];
    const result = runMinimumCommercialReleaseChecks({
      record: {
        schemaVersion: 1,
        contentRights: null,
        macDelivery: null,
        publicAccess: null,
        ownerAcceptance: null,
      },
      headCommit: commit,
      runGate(script: string) {
        calls.push(script);
        return { exitCode: 0 };
      },
    });
    expect(calls).toEqual(minimumTechnicalScripts);
    expect(minimumTechnicalScripts).not.toContain('release:updater-feed:active-check');
    expect(minimumTechnicalScripts).not.toContain('source:review:reviewed-check');
    expect(result.blockingScripts).toEqual([]);
    expect(result.recordViolations).toHaveLength(4);
    expect(result.exitCode).toBe(1);
  });

  it('requires matching frozen source, Mac hashes, public HTTPS and owner acceptance', () => {
    const record = approvedRecord();
    expect(
      minimumReleaseRecordViolations(record, { headCommit: commit, asOf: '2026-09-26' }),
    ).toEqual([]);
    record.macDelivery.downloadedSha256 = app;
    record.macDelivery.downloadUrl = 'https://10.0.0.1/private.dmg';
    record.publicAccess.updateMode = 'automatic';
    record.ownerAcceptance.sourceCommit = 'd'.repeat(40);
    const problems = minimumReleaseRecordViolations(record, {
      headCommit: commit,
      asOf: '2026-09-26',
    });
    expect(problems).toContain('downloaded Mac DMG hash must match the released DMG');
    expect(problems).toContain('macDelivery.downloadUrl must be public HTTPS');
    expect(problems).toContain('publicAccess.updateMode must be manual for the first release');
    expect(problems).toContain('ownerAcceptance.sourceCommit must equal current Git commit');
  });

  it('does not pass when a scoped technical check fails, even with a complete record', () => {
    const result = runMinimumCommercialReleaseChecks({
      record: approvedRecord(),
      headCommit: commit,
      asOf: '2026-09-26',
      runGate(script: string) {
        return { exitCode: script === 'snapshot:final-public:check' ? 1 : 0 };
      },
      verifyMac() {
        return [];
      },
    });
    expect(result.blockingScripts).toEqual(['snapshot:final-public:check']);
    expect(result.recordViolations).toEqual([]);
    expect(result.exitCode).toBe(1);
  });

  it('checks actual local/downloaded bytes and invokes Mac trust tools for an approved record', () => {
    const directory = mkdtempSync(join(tmpdir(), 'axterm-minimum-release-'));
    const bundle = join(directory, 'Axterm.app');
    const asarPath = join(bundle, 'Contents', 'Resources', 'app.asar');
    const localDmg = join(directory, 'local.dmg');
    const downloadedDmg = join(directory, 'downloaded.dmg');
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    try {
      mkdirSync(join(bundle, 'Contents', 'Resources'), { recursive: true });
      writeFileSync(asarPath, 'application bytes');
      writeFileSync(localDmg, 'installer bytes');
      writeFileSync(downloadedDmg, 'installer bytes');
      const mac = {
        ...approvedRecord().macDelivery,
        appPath: bundle,
        appAsarPath: asarPath,
        dmgPath: localDmg,
        downloadedDmgPath: downloadedDmg,
        appSha256: hash('application bytes'),
        dmgSha256: hash('installer bytes'),
        downloadedSha256: hash('installer bytes'),
      };
      const calls: string[] = [];
      expect(
        macArtifactViolations(mac, {
          inspectSignature: () =>
            'Authority=Developer ID Application: Test (TEAMID1234)\nTeamIdentifier=TEAMID1234',
          runCommand(command: string) {
            calls.push(command);
            return 0;
          },
        }),
      ).toEqual([]);
      expect(calls).toEqual(['codesign', 'spctl', 'xcrun', 'xcrun', 'hdiutil']);
      expect(
        macArtifactViolations(mac, {
          inspectSignature: () => 'Authority=Apple Development\nTeamIdentifier=TEAMID1234',
          runCommand: () => 0,
        }),
      ).toContain('Mac app lacks the recorded Developer ID Application signature');
      writeFileSync(downloadedDmg, 'different bytes');
      expect(
        macArtifactViolations(mac, {
          inspectSignature: () =>
            'Authority=Developer ID Application: Test (TEAMID1234)\nTeamIdentifier=TEAMID1234',
          runCommand: () => 0,
        }),
      ).toContain('downloaded DMG SHA-256 does not match the record');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
