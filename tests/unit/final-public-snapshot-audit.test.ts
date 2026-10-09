import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditFinalPublicSnapshot,
  readFinalPublicSnapshotExceptions,
} from '../../scripts/commercialization/audit-final-public-snapshot.mjs';

const directories: string[] = [];
const retiredName = ['elect', 'erm'].join('');

async function snapshotDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-final-public-snapshot-'));
  directories.push(directory);
  await writeFile(join(directory, 'package.json'), '{"name":"snapshot-fixture"}\n', 'utf8');
  await writeFile(join(directory, 'bun.lock'), '# frozen fixture lock\n', 'utf8');
  return directory;
}

async function writeSnapshotFile(directory: string, path: string, content: string) {
  const target = join(directory, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content, 'utf8');
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('final public source snapshot audit', () => {
  it('accepts a hygienic candidate with no legacy product-name references', async () => {
    const directory = await snapshotDirectory();
    await writeSnapshotFile(
      directory,
      'apps/desktop/src/app.ts',
      'export const product = "Axterm";\n',
    );

    const report = auditFinalPublicSnapshot(directory);

    expect(report.passed).toBe(true);
    expect(report.legacyNameFindings).toEqual([]);
    expect(report.exceptionRecords).toEqual([]);
    expect(report.violations).toEqual([]);
  });

  it('rejects legacy-name content and a legacy-name file path in the final candidate', async () => {
    const directory = await snapshotDirectory();
    await writeSnapshotFile(
      directory,
      'apps/desktop/src/migration.ts',
      `const name = "${retiredName}";\n`,
    );
    await writeSnapshotFile(directory, `docs/${retiredName}-history.md`, 'Historical record.\n');

    const report = auditFinalPublicSnapshot(directory);

    expect(report.passed).toBe(false);
    expect(report.unapprovedLegacyNameFindings).toEqual([
      { path: 'apps/desktop/src/migration.ts', kind: 'content', occurrences: 1 },
      { path: `docs/${retiredName}-history.md`, kind: 'path', occurrences: 1 },
    ]);
    expect(report.violations).toContain(
      'apps/desktop/src/migration.ts (content: 1 legacy-name occurrence(s))',
    );
    expect(report.violations).toContain(
      `docs/${retiredName}-history.md (path: 1 legacy-name occurrence(s))`,
    );
  });

  it('rejects the legacy name encoded as UTF-16 in either byte order', async () => {
    const directory = await snapshotDirectory();
    const legacyName = Buffer.from(retiredName, 'utf16le');
    await writeFile(
      join(directory, 'little-endian.txt'),
      Buffer.concat([Buffer.from([1]), legacyName]),
    );
    const bigEndian = Buffer.from(legacyName);
    bigEndian.swap16();
    await writeFile(join(directory, 'big-endian.txt'), bigEndian);

    const report = auditFinalPublicSnapshot(directory);

    expect(report.passed).toBe(false);
    expect(report.unapprovedLegacyNameFindings).toEqual([
      { path: 'big-endian.txt', kind: 'content', occurrences: 1 },
      { path: 'little-endian.txt', kind: 'content', occurrences: 1 },
    ]);
  });

  it('allows only a fully recorded documentation exception and rejects unused or non-documentation records', async () => {
    const directory = await snapshotDirectory();
    await writeSnapshotFile(
      directory,
      'docs/migration-history.md',
      `${retiredName} compatibility record.\n`,
    );
    await writeSnapshotFile(
      directory,
      'apps/desktop/src/migration.ts',
      `const name = "${retiredName}";\n`,
    );

    const report = auditFinalPublicSnapshot(directory, {
      exceptions: [
        {
          path: 'docs/migration-history.md',
          scope: 'content',
          reason: 'Approved historical migration record retained for release traceability.',
          approvedBy: 'release-owner',
          approvedAt: '2026-09-22',
          approvalReference: 'legal-review-42',
        },
        {
          path: 'apps/desktop/src/migration.ts',
          scope: 'content',
          reason: 'This must never be allowed in a final public source tree.',
          approvedBy: 'release-owner',
          approvedAt: '2026-09-22',
          approvalReference: 'invalid-example',
        },
        {
          path: 'docs/unused.md',
          scope: 'content',
          reason: 'This record is intentionally stale.',
          approvedBy: 'release-owner',
          approvedAt: '2026-09-22',
          approvalReference: 'unused-example',
        },
      ],
    });

    expect(report.passed).toBe(false);
    expect(report.unapprovedLegacyNameFindings).toEqual([
      { path: 'apps/desktop/src/migration.ts', kind: 'content', occurrences: 1 },
    ]);
    expect(report.invalidExceptionRecords).toEqual([
      'exceptions[1].path: only documentation paths may be excepted',
      'exceptions[2].path: does not exist in the candidate snapshot',
    ]);
    expect(report.unusedExceptionRecords).toEqual([]);
  });

  it('loads only a versioned JSON exception record', async () => {
    const directory = await snapshotDirectory();
    const recordPath = join(directory, 'approved-exceptions.json');
    await writeFile(
      recordPath,
      JSON.stringify({
        schemaVersion: 1,
        exceptions: [
          {
            path: 'docs/migration-history.md',
            scope: 'content',
            reason: 'Approved historical migration record.',
            approvedBy: 'release-owner',
            approvedAt: '2026-09-22',
            approvalReference: 'legal-review-42',
          },
        ],
      }),
      'utf8',
    );

    expect(readFinalPublicSnapshotExceptions(recordPath)).toEqual([
      {
        path: 'docs/migration-history.md',
        scope: 'content',
        reason: 'Approved historical migration record.',
        approvedBy: 'release-owner',
        approvedAt: '2026-09-22',
        approvalReference: 'legal-review-42',
      },
    ]);
  });
});
