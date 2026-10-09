import { describe, expect, it } from 'vitest';
import { releaseServiceRecordViolations } from '../../scripts/commercialization/release-service-record.mjs';

function pendingRecord() {
  return {
    schemaVersion: 1,
    status: 'pending',
    privacyAndDataHandling: null,
    securityReporting: null,
    supportPolicy: null,
  };
}

function activeRecord() {
  return {
    ...pendingRecord(),
    status: 'active',
    privacyAndDataHandling: {
      publicPolicyUrl: 'https://axterm.dev/privacy',
      scope: 'Desktop application data handling and third-party endpoint disclosures.',
      approvedBy: 'Privacy owner',
      approvedAt: '2026-09-21',
      evidence: ['public privacy policy approval'],
    },
    securityReporting: {
      reportChannels: ['mailto:security@axterm.dev'],
      disclosurePolicyUrl: 'https://axterm.dev/security',
      supportedVersionsPolicyUrl: 'https://axterm.dev/security/supported-versions',
      approvedBy: 'Security owner',
      approvedAt: '2026-09-21',
      evidence: ['security reporting service approval'],
    },
    supportPolicy: {
      channels: ['https://axterm.dev/support'],
      publicPolicyUrl: 'https://axterm.dev/support',
      scope: 'Installation, migration and supported-version assistance.',
      responseTarget: 'Published support hours and first-response target.',
      approvedBy: 'Support owner',
      approvedAt: '2026-09-21',
      evidence: ['support policy approval'],
    },
  };
}

describe('release service record', () => {
  it('allows an entirely empty pending record but refuses to treat it as release-ready', () => {
    const record = pendingRecord();
    expect(releaseServiceRecordViolations(record)).toEqual([]);
    expect(releaseServiceRecordViolations(record, { mode: 'active' })).toEqual([
      'Release service record is pending; public privacy, security-reporting and support approvals are required',
    ]);
  });

  it('requires public, non-placeholder service endpoints and owner approvals', () => {
    const record = activeRecord();
    expect(releaseServiceRecordViolations(record, { mode: 'active', asOf: '2026-09-21' })).toEqual(
      [],
    );

    record.securityReporting.reportChannels = ['https://security.example.com/report'];
    expect(
      releaseServiceRecordViolations(record, { mode: 'active', asOf: '2026-09-21' }),
    ).toContain(
      'securityReporting.reportChannels must contain distinct public HTTPS or mailto channels',
    );

    record.securityReporting.reportChannels = ['mailto:security@axterm.dev'];
    record.supportPolicy.channels = ['https://127.0.0.1/support'];
    expect(
      releaseServiceRecordViolations(record, { mode: 'active', asOf: '2026-09-21' }),
    ).toContain('supportPolicy.channels must contain distinct public HTTPS or mailto channels');

    record.supportPolicy.channels = ['https://axterm.dev/support?token=must-not-be-recorded'];
    expect(
      releaseServiceRecordViolations(record, { mode: 'active', asOf: '2026-09-21' }),
    ).toContain('supportPolicy.channels must contain distinct public HTTPS or mailto channels');

    record.supportPolicy.channels = ['https://axterm.dev/support'];
    record.supportPolicy.approvedAt = '2026-09-22';
    expect(
      releaseServiceRecordViolations(record, { mode: 'active', asOf: '2026-09-21' }),
    ).toContain('supportPolicy.approvedAt cannot be after the current UTC date');
  });
});
