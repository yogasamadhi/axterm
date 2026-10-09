import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareIndependentSnapshot } from '../../scripts/commercialization/prepare-independent-snapshot.mjs';

const directories: string[] = [];

async function fixtureSource() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-snapshot-source-'));
  directories.push(directory);
  await writeFile(join(directory, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(join(directory, 'bun.lock'), 'lockfileVersion: 1\n');
  await writeFile(join(directory, 'README.md'), '# fixture\n');
  await mkdir(join(directory, '.git'), { recursive: true });
  await mkdir(join(directory, 'vendor', 'legacy-prototype'), { recursive: true });
  await mkdir(join(directory, 'node_modules', 'example'), { recursive: true });
  await mkdir(join(directory, 'packages', 'runtime', 'node_modules', 'example'), {
    recursive: true,
  });
  await mkdir(join(directory, 'packages', 'runtime', 'out'), { recursive: true });
  await mkdir(join(directory, 'packages', 'runtime', 'dist'), { recursive: true });
  await mkdir(join(directory, 'out'), { recursive: true });
  await mkdir(join(directory, 'scripts', 'parity'), { recursive: true });
  await writeFile(join(directory, '.gitmodules'), '[submodule]\n');
  await writeFile(join(directory, '.env.local'), 'TOKEN=not-for-snapshot\n');
  await writeFile(join(directory, '.DS_Store'), 'Finder metadata\n');
  await mkdir(join(directory, 'docs'), { recursive: true });
  await writeFile(join(directory, 'docs', '.DS_Store'), 'nested Finder metadata\n');
  await writeFile(join(directory, 'vendor', 'legacy-prototype', 'source.js'), 'old source\n');
  await writeFile(join(directory, 'node_modules', 'example', 'index.js'), 'installed\n');
  await writeFile(
    join(directory, 'packages', 'runtime', 'node_modules', 'example', 'index.js'),
    'nested installed\n',
  );
  await writeFile(join(directory, 'packages', 'runtime', 'out', 'bundle.js'), 'nested build\n');
  await writeFile(join(directory, 'packages', 'runtime', 'dist', 'bundle.js'), 'nested dist\n');
  await writeFile(join(directory, 'out', 'bundle.js'), 'built\n');
  await writeFile(join(directory, 'scripts', 'parity', 'old.mjs'), 'historical\n');
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('independent source snapshot preparation', () => {
  it('retains Pi source inputs while excluding submodule metadata and the unrelated CLI', async () => {
    const source = await fixtureSource();
    await mkdir(join(source, 'vendor/pi/packages/ai/src'), { recursive: true });
    await mkdir(join(source, 'vendor/pi/packages/coding-agent/src'), { recursive: true });
    await writeFile(
      join(source, 'vendor/pi/packages/ai/src/index.ts'),
      'export const engine = true;\n',
    );
    await writeFile(join(source, 'vendor/pi/LICENSE'), 'MIT license\n');
    await writeFile(join(source, 'vendor/pi/.git'), 'gitdir: private-checkout\n');
    await writeFile(join(source, 'vendor/pi/packages/coding-agent/src/cli.ts'), 'unrelated CLI\n');
    await mkdir(join(source, 'vendor/pi/packages/coding-agent/src/core'));
    await writeFile(
      join(source, 'vendor/pi/packages/coding-agent/src/core/skills.ts'),
      'export const skills = true;\n',
    );
    const prepared = await prepareIndependentSnapshot(source);
    directories.push(prepared.temporaryDirectory);
    expect(prepared.report.passed).toBe(true);
    expect(existsSync(join(prepared.snapshotDirectory, 'vendor/pi/packages/ai/src/index.ts'))).toBe(
      true,
    );
    expect(existsSync(join(prepared.snapshotDirectory, 'vendor/pi/LICENSE'))).toBe(true);
    expect(existsSync(join(prepared.snapshotDirectory, 'vendor/pi/.git'))).toBe(false);
    expect(
      existsSync(
        join(prepared.snapshotDirectory, 'vendor/pi/packages/coding-agent/src/core/skills.ts'),
      ),
    ).toBe(true);
    expect(
      existsSync(join(prepared.snapshotDirectory, 'vendor/pi/packages/coding-agent/src/cli.ts')),
    ).toBe(false);
  });
  it('copies only the releasable source set before auditing it', async () => {
    const prepared = await prepareIndependentSnapshot(await fixtureSource());
    directories.push(prepared.temporaryDirectory);

    if ('baseAudit' in prepared.report) throw new Error('Expected the regular snapshot report');
    expect(prepared.report.passed).toBe(true);
    expect(prepared.report.sourceFiles).toBe(3);
    expect(prepared.report.forbiddenEntries).toEqual([]);
    expect(prepared.report.environmentFiles).toEqual([]);
    expect(prepared.report.oversizedFiles).toEqual([]);
    expect(prepared.report.symbolicLinks).toEqual([]);
    expect(prepared.report.transientArtifacts).toEqual([]);
    expect(prepared.report.prohibitedGeneratedFiles).toEqual([]);
    expect(prepared.report.sensitiveArtifacts).toEqual([]);
    expect(prepared.report.highConfidenceSecrets).toEqual([]);
    expect(prepared.report.packageDependencyViolations).toEqual([]);
    expect(prepared.report.lockfileDependencyViolations).toEqual([]);
  });

  it('can apply the later final-public textual guard to the prepared copy', async () => {
    const source = await fixtureSource();
    const retiredName = ['elect', 'erm'].join('');
    await writeFile(
      join(source, 'docs', 'migration-history.md'),
      `${retiredName} compatibility record\n`,
    );

    const prepared = await prepareIndependentSnapshot(source, { finalPublic: true });
    directories.push(prepared.temporaryDirectory);

    if (!('baseAudit' in prepared.report))
      throw new Error('Expected the final-public snapshot report');
    expect(prepared.report.passed).toBe(false);
    expect(prepared.report.baseAudit.passed).toBe(true);
    expect(prepared.report.unapprovedLegacyNameFindings).toEqual([
      { path: 'docs/migration-history.md', kind: 'content', occurrences: 1 },
    ]);
  });

  it('leaves archived evidence out of the candidate without dropping current fixtures', async () => {
    const source = await fixtureSource();
    const fixtureDirectory = join(source, 'tests', 'fixtures', 'migration');
    await mkdir(fixtureDirectory, { recursive: true });
    await mkdir(join(source, 'docs', 'implementation'), { recursive: true });
    await mkdir(join(source, 'docs', 'implementation', 'evidence'), { recursive: true });
    await mkdir(join(source, 'docs', 'product'), { recursive: true });
    for (const path of [
      ['docs', 'implementation', 'LEGACY_PROTOTYPE_TRANSITION_BOUNDARY.md'],
      ['docs', 'product', 'LEGACY_PROTOTYPE_DESIGN_TOKENS.md'],
      [
        'docs',
        'implementation',
        'evidence',
        'IR08-LEGACY_PROTOTYPE-OLD-CSV-WORKFLOW-2026-09-24.md',
      ],
      ['docs', 'implementation', 'evidence', 'IR08-LEGACY_PROTOTYPE-UI-EXPORT-2026-09-23.md'],
      [
        'docs',
        'implementation',
        'evidence',
        'IR08-HISTORICAL-PACKAGE-UPGRADE-REVALIDATION-2026-09-24.md',
      ],
      ['docs', 'implementation', 'evidence', 'IR08-MACOS-HISTORICAL-CUSTOM-THEME-2026-09-25.md'],
    ]) {
      await writeFile(join(source, ...path), 'historical\n');
    }
    for (const name of [
      'legacy-prototype-data-tool-2.1.10-neDB-export.json',
      'legacy-prototype-v1.101.16-ui-export-v1.json',
    ]) {
      await writeFile(join(fixtureDirectory, name), '{}\n');
    }
    await writeFile(join(fixtureDirectory, 'axterm-current.json'), '{}\n');

    const prepared = await prepareIndependentSnapshot(source);
    directories.push(prepared.temporaryDirectory);

    if ('baseAudit' in prepared.report) throw new Error('Expected the regular snapshot report');
    expect(prepared.report.passed).toBe(true);
    expect(prepared.report.sourceFiles).toBe(4);
    for (const name of [
      'legacy-prototype-data-tool-2.1.10-neDB-export.json',
      'legacy-prototype-v1.101.16-ui-export-v1.json',
    ]) {
      expect(
        existsSync(join(prepared.snapshotDirectory, 'tests', 'fixtures', 'migration', name)),
      ).toBe(false);
    }
    for (const path of [
      ['docs', 'implementation', 'LEGACY_PROTOTYPE_TRANSITION_BOUNDARY.md'],
      ['docs', 'product', 'LEGACY_PROTOTYPE_DESIGN_TOKENS.md'],
      [
        'docs',
        'implementation',
        'evidence',
        'IR08-LEGACY_PROTOTYPE-OLD-CSV-WORKFLOW-2026-09-24.md',
      ],
      ['docs', 'implementation', 'evidence', 'IR08-LEGACY_PROTOTYPE-UI-EXPORT-2026-09-23.md'],
      [
        'docs',
        'implementation',
        'evidence',
        'IR08-HISTORICAL-PACKAGE-UPGRADE-REVALIDATION-2026-09-24.md',
      ],
      ['docs', 'implementation', 'evidence', 'IR08-MACOS-HISTORICAL-CUSTOM-THEME-2026-09-25.md'],
    ]) {
      expect(existsSync(join(prepared.snapshotDirectory, ...path))).toBe(false);
    }
    expect(
      await readFile(
        join(prepared.snapshotDirectory, 'tests', 'fixtures', 'migration', 'axterm-current.json'),
        'utf8',
      ),
    ).toBe('{}\n');
  });

  it('rejects an exception record unless the final-public guard is selected', () => {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/commercialization/prepare-independent-snapshot.mjs',
        '--check',
        '--exceptions',
        'approved-record.json',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'Usage: node scripts/commercialization/prepare-independent-snapshot.mjs',
    );
  });
});
