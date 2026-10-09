import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateUpdateFeedRecord } from '../../scripts/commercialization/update-feed-record.mjs';
import { verifyPackagedUpdateFeed } from '../../scripts/commercialization/verify-packaged-update-feed.mjs';

const asOf = new Date('2026-09-24T12:00:00.000Z');

function activeRecord() {
  const { publicKey } = generateKeyPairSync('ed25519');
  return {
    schemaVersion: 1,
    status: 'active',
    manifestUrl: 'https://updates.axterm.dev/stable/manifest.json',
    publicKeyBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    approval: {
      reviewer: 'Release owner test fixture',
      reviewedAt: '2026-09-24',
      evidence: ['tests/fixtures/signed-feed-review'],
      conclusion: 'Test-only active feed approval',
    },
    limitations: ['This unit-test record does not approve a public feed.'],
  };
}

describe('public update-feed release record', () => {
  it('keeps the committed pending record valid but blocks promotion', () => {
    const record = JSON.parse(
      readFileSync('compliance/UPDATE_FEED_RECORD.json', 'utf8'),
    ) as unknown;
    expect(validateUpdateFeedRecord(record, { asOf })).toEqual([]);
    expect(validateUpdateFeedRecord(record, { asOf, activeRequired: true })).toContain(
      'Public update-feed configuration is still pending',
    );
  });

  it('accepts only a reviewed public HTTPS Ed25519 trust root for active release', () => {
    const record = activeRecord();
    expect(validateUpdateFeedRecord(record, { asOf, activeRequired: true })).toEqual([]);
    expect(
      validateUpdateFeedRecord({ ...record, manifestUrl: 'http://127.0.0.1/feed' }, { asOf }),
    ).toContain('manifestUrl must be a real public HTTPS URL without credentials or fragment');
    expect(
      validateUpdateFeedRecord({ ...record, manifestUrl: 'https://example.com/feed' }, { asOf }),
    ).toContain('manifestUrl must be a real public HTTPS URL without credentials or fragment');
    expect(validateUpdateFeedRecord({ ...record, publicKeyBase64: 'Zm9v' }, { asOf })).toContain(
      'publicKeyBase64 must be canonical Base64-encoded Ed25519 SPKI DER',
    );
    expect(
      validateUpdateFeedRecord(
        { ...record, approval: { ...record.approval, reviewedAt: '2026-09-25' } },
        { asOf },
      ),
    ).toContain('approval.reviewedAt must be a real UTC date no later than today');
  });

  it('rejects a pending record that quietly carries active feed credentials', () => {
    const record = JSON.parse(readFileSync('compliance/UPDATE_FEED_RECORD.json', 'utf8')) as Record<
      string,
      unknown
    >;
    expect(
      validateUpdateFeedRecord({ ...record, manifestUrl: 'https://updates.axterm.dev/feed' }),
    ).toContain('Pending update-feed record must not carry active feed fields');
  });

  it('requires the packaged record to match the reviewed source bytes exactly', async () => {
    const resources = await mkdtemp(join(tmpdir(), 'axterm-feed-resources-'));
    const packagedPath = join(resources, 'AXTERM_UPDATE_FEED.json');
    try {
      expect(verifyPackagedUpdateFeed(resources)).toEqual([
        expect.stringContaining('Packaged update-feed record cannot be read'),
      ]);
      await writeFile(packagedPath, readFileSync('compliance/UPDATE_FEED_RECORD.json'));
      expect(verifyPackagedUpdateFeed(resources)).toEqual([]);
      expect(verifyPackagedUpdateFeed(resources, { activeRequired: true })).toContain(
        'Public update-feed configuration is still pending',
      );
      await writeFile(
        packagedPath,
        `${readFileSync('compliance/UPDATE_FEED_RECORD.json', 'utf8')}\n`,
      );
      expect(verifyPackagedUpdateFeed(resources)).toContain(
        'Packaged update-feed record bytes differ from the reviewed source record',
      );
    } finally {
      await rm(resources, { recursive: true, force: true });
    }
  });
});
