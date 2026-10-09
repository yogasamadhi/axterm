import { describe, expect, it } from 'vitest';
import { migrationReleaseRecordViolations } from '../../scripts/commercialization/migration-release-record.mjs';

function pendingRecord() {
  return {
    schemaVersion: 1,
    status: 'pending',
    recommendedBaseline: {
      minimumDays: 90,
      minimumStableReleases: 1,
      rule: 'later-of-duration-and-stable-release',
    },
    publicMigrationRelease: null,
    approvedWindow: null,
    support: null,
    removalApproval: null,
  };
}

function immediateRemovalRecord() {
  return {
    schemaVersion: 2,
    status: 'immediate-removal-approved',
    publicMigrationRelease: null,
    approvedWindow: null,
    support: null,
    removalApproval: null,
    immediateRemovalApproval: {
      approvedBy: 'Repository owner',
      approvedAt: '2026-09-25',
      priorPublicDistribution: false,
      localDataPolicy: 'preserve-inert',
      remoteDataPolicy: 'preserve',
      decisionEvidence: ['docs/adr/ADR-021-immediate-legacy-prototype-compatibility-removal.md'],
    },
  };
}

function activeRecord(): {
  schemaVersion: number;
  status: 'active' | 'removal-approved';
  recommendedBaseline: {
    minimumDays: number;
    minimumStableReleases: number;
    rule: string;
  };
  publicMigrationRelease: {
    version: string;
    publishedAt: string;
    artifactSha256: string;
    evidence: string[];
  };
  approvedWindow: {
    minimumDays: number;
    minimumStableReleases: number;
    removalNotBefore: string;
    approvedBy: string;
    approvedAt: string;
    decisionEvidence: string[];
    exceptionRationale: string | null;
  };
  support: {
    channels: string[];
    scope: string;
  };
  removalApproval: null | {
    removalReleaseVersion: string;
    confirmedAt: string;
    stableReleaseMilestones: Array<{
      version: string;
      publishedAt: string;
      evidence: string[];
    }>;
    approvedBy: string;
    evidence: string[];
  };
} {
  return {
    ...pendingRecord(),
    status: 'active',
    publicMigrationRelease: {
      version: '0.11.0',
      publishedAt: '2026-10-01',
      artifactSha256: 'a'.repeat(64),
      evidence: ['public release permalink'],
    },
    approvedWindow: {
      minimumDays: 90,
      minimumStableReleases: 1,
      removalNotBefore: '2026-12-30',
      approvedBy: 'Release owner',
      approvedAt: '2026-09-21',
      decisionEvidence: ['release decision record'],
      exceptionRationale: null,
    },
    support: {
      channels: ['support portal'],
      scope: 'Migration questions, recovery guidance and compatibility-path retirement.',
    },
  };
}

describe('migration release record', () => {
  it('accepts the owner-approved immediate removal without inventing a public migration window', () => {
    const record = immediateRemovalRecord();
    expect(migrationReleaseRecordViolations(record, { asOf: '2026-09-25' })).toEqual([]);
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2026-09-25' }),
    ).toEqual([]);
    expect(
      migrationReleaseRecordViolations(record, { mode: 'active', asOf: '2026-09-25' }),
    ).toEqual(['No public migration release exists under the approved immediate-removal decision']);
  });

  it('rejects an immediate-removal record that weakens the approved data or ownership facts', () => {
    const record = immediateRemovalRecord();
    record.immediateRemovalApproval.priorPublicDistribution = true;
    record.immediateRemovalApproval.localDataPolicy = 'delete';
    record.immediateRemovalApproval.remoteDataPolicy = 'delete';
    record.immediateRemovalApproval.decisionEvidence = ['unrelated approval'];
    record.publicMigrationRelease = { version: '0.11.0' } as never;
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2026-09-25' }),
    ).toEqual([
      'immediate-removal record must leave publicMigrationRelease null',
      'immediateRemovalApproval.decisionEvidence must cite ADR-021',
      'immediateRemovalApproval.localDataPolicy must be preserve-inert',
      'immediateRemovalApproval.priorPublicDistribution must be false',
      'immediateRemovalApproval.remoteDataPolicy must be preserve',
    ]);
  });

  it('allows an entirely empty pending record but refuses to treat it as an active window', () => {
    const record = pendingRecord();
    expect(migrationReleaseRecordViolations(record)).toEqual([]);
    expect(migrationReleaseRecordViolations(record, { mode: 'active' })).toEqual([
      'Migration release record is pending; public migration release approval is required',
    ]);
  });

  it('requires a public release, owner-approved window and support record to start the migration clock', () => {
    const record = activeRecord();
    expect(
      migrationReleaseRecordViolations(record, { mode: 'active', asOf: '2026-10-01' }),
    ).toEqual([]);
    expect(
      migrationReleaseRecordViolations(record, { mode: 'active', asOf: '2026-09-21' }),
    ).toContain('publicMigrationRelease.publishedAt cannot be after the current UTC date');

    record.approvedWindow.removalNotBefore = '2026-12-29';
    expect(
      migrationReleaseRecordViolations(record, { mode: 'active', asOf: '2026-10-01' }),
    ).toContain('approvedWindow.removalNotBefore is earlier than the approved minimum days');

    record.approvedWindow.removalNotBefore = '2026-12-30';
    record.approvedWindow.minimumDays = 30;
    record.approvedWindow.exceptionRationale = null;
    expect(
      migrationReleaseRecordViolations(record, { mode: 'active', asOf: '2026-10-01' }),
    ).toContain(
      'approvedWindow.exceptionRationale is required below the recommended 90-day/one-stable-release baseline',
    );
  });

  it('requires the migration window to be approved before its public release', () => {
    const record = activeRecord();
    record.approvedWindow.approvedAt = '2026-10-02';
    expect(
      migrationReleaseRecordViolations(record, { mode: 'active', asOf: '2026-10-01' }),
    ).toEqual([
      'approvedWindow.approvedAt cannot be after the current UTC date',
      'approvedWindow.approvedAt must not be after the public migration release',
    ]);
    expect(
      migrationReleaseRecordViolations(record, { mode: 'active', asOf: '2026-10-02' }),
    ).toContain('approvedWindow.approvedAt must not be after the public migration release');

    record.approvedWindow.approvedAt = '2026-09-21';
    record.publicMigrationRelease.version = '0.11.0-rc.1';
    expect(
      migrationReleaseRecordViolations(record, { mode: 'active', asOf: '2026-10-01' }),
    ).toContain('publicMigrationRelease.version must be a stable semantic version');
  });

  it('requires an elapsed-window removal approval and stable-release milestone before compatibility removal', () => {
    const record = activeRecord();
    record.status = 'removal-approved';
    record.removalApproval = {
      removalReleaseVersion: '0.13.0',
      confirmedAt: '2027-01-02',
      stableReleaseMilestones: [
        {
          version: '0.12.0',
          publishedAt: '2026-11-15',
          evidence: ['stable release permalink'],
        },
      ],
      approvedBy: 'Release owner',
      evidence: ['migration-window completion review'],
    };
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2027-01-02' }),
    ).toEqual([]);

    record.removalApproval!.confirmedAt = '2026-12-01';
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2027-01-02' }),
    ).toContain('removalApproval.confirmedAt is earlier than removalNotBefore');

    record.removalApproval!.confirmedAt = '2027-01-03';
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2027-01-02' }),
    ).toContain('removalApproval.confirmedAt cannot be after the current UTC date');

    record.removalApproval!.confirmedAt = '2027-01-02';
    record.removalApproval!.stableReleaseMilestones[0]!.publishedAt = '2027-01-03';
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2027-01-02' }),
    ).toContain('removalApproval.stableReleaseMilestones[0] is later than the removal approval');

    record.removalApproval!.stableReleaseMilestones[0]!.publishedAt = '2026-11-15';
    record.approvedWindow.minimumStableReleases = 2;
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2027-01-02' }),
    ).toContain(
      'removalApproval.stableReleaseMilestones does not satisfy approvedWindow.minimumStableReleases',
    );
  });

  it('does not count the migration release or repeated dates of one version as later milestones', () => {
    const record = activeRecord();
    record.status = 'removal-approved';
    record.removalApproval = {
      removalReleaseVersion: '0.14.0',
      confirmedAt: '2027-01-02',
      stableReleaseMilestones: [
        {
          version: '0.11.0',
          publishedAt: '2026-10-01',
          evidence: ['migration release permalink'],
        },
      ],
      approvedBy: 'Release owner',
      evidence: ['migration-window completion review'],
    };
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2027-01-02' }),
    ).toEqual([
      'removalApproval.stableReleaseMilestones does not satisfy approvedWindow.minimumStableReleases',
      'removalApproval.stableReleaseMilestones[0] must be dated after the public migration release',
      'removalApproval.stableReleaseMilestones[0].version must differ from the public migration release',
    ]);

    record.removalApproval.stableReleaseMilestones[0]!.version = '0.12.0';
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2027-01-02' }),
    ).toContain(
      'removalApproval.stableReleaseMilestones[0] must be dated after the public migration release',
    );

    record.removalApproval.stableReleaseMilestones = [
      { version: '0.12.0', publishedAt: '2026-11-15', evidence: ['first release permalink'] },
      { version: '0.12.0', publishedAt: '2026-12-01', evidence: ['same version permalink'] },
    ];
    record.approvedWindow.minimumStableReleases = 2;
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2027-01-02' }),
    ).toEqual([
      'removalApproval.stableReleaseMilestones does not satisfy approvedWindow.minimumStableReleases',
      'removalApproval.stableReleaseMilestones[1].version duplicates an earlier stable-release milestone',
    ]);

    record.removalApproval.stableReleaseMilestones[1]!.version = '0.13.0';
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2027-01-02' }),
    ).toEqual([]);
  });

  it('requires each stable milestone to precede a distinct later removal version', () => {
    const record = activeRecord();
    record.status = 'removal-approved';
    record.removalApproval = {
      removalReleaseVersion: '0.12.0',
      confirmedAt: '2027-01-02',
      stableReleaseMilestones: [
        { version: '0.12.0', publishedAt: '2026-11-15', evidence: ['stable release permalink'] },
      ],
      approvedBy: 'Release owner',
      evidence: ['migration-window completion review'],
    };
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2027-01-02' }),
    ).toContain(
      'removalApproval.stableReleaseMilestones[0].version must precede the compatibility-removal release',
    );

    record.removalApproval.removalReleaseVersion = '0.13.0';
    record.removalApproval.stableReleaseMilestones[0]!.version = '0.10.9';
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2027-01-02' }),
    ).toContain(
      'removalApproval.stableReleaseMilestones[0].version must follow the public migration release',
    );

    record.removalApproval.stableReleaseMilestones = [
      { version: '0.12.0+one', publishedAt: '2026-11-15', evidence: ['first release permalink'] },
      { version: '0.12.0+two', publishedAt: '2026-12-01', evidence: ['second release permalink'] },
    ];
    record.approvedWindow.minimumStableReleases = 2;
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2027-01-02' }),
    ).toContain(
      'removalApproval.stableReleaseMilestones[1].version duplicates an earlier stable-release milestone',
    );

    record.approvedWindow.minimumStableReleases = 1;
    record.removalApproval.stableReleaseMilestones = [
      { version: '0.12.10', publishedAt: '2026-11-15', evidence: ['stable release permalink'] },
    ];
    record.removalApproval.removalReleaseVersion = '0.12.9';
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2027-01-02' }),
    ).toContain(
      'removalApproval.stableReleaseMilestones[0].version must precede the compatibility-removal release',
    );
    record.removalApproval.removalReleaseVersion = '0.12.11';
    expect(
      migrationReleaseRecordViolations(record, { mode: 'removal', asOf: '2027-01-02' }),
    ).toEqual([]);
  });
});
