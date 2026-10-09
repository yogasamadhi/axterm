import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditIndependentSnapshot } from '../../scripts/commercialization/audit-independent-snapshot.mjs';

const directories: string[] = [];

async function snapshotDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-independent-snapshot-'));
  directories.push(directory);
  return directory;
}

async function writeSnapshotManifest(directory: string, dependencies: Record<string, string> = {}) {
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'snapshot-fixture', dependencies }),
    'utf8',
  );
  await writeFile(join(directory, 'bun.lock'), '# frozen fixture lock\n', 'utf8');
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('independent source snapshot audit', () => {
  it('accepts a metadata-free source snapshot and derives a stable tree identity', async () => {
    const directory = await snapshotDirectory();
    await writeSnapshotManifest(directory, { hono: '4.0.0' });
    await mkdir(join(directory, 'packages', 'runtime'), { recursive: true });
    await writeFile(
      join(directory, 'packages', 'runtime', 'entry.ts'),
      'export const ready = true;\n',
    );

    const first = auditIndependentSnapshot(directory);
    const second = auditIndependentSnapshot(directory);

    expect(first).toMatchObject({
      schemaVersion: 1,
      sourceFiles: 3,
      forbiddenEntries: [],
      environmentFiles: [],
      oversizedFiles: [],
      symbolicLinks: [],
      transientArtifacts: [],
      prohibitedGeneratedFiles: [],
      sensitiveArtifacts: [],
      highConfidenceSecrets: [],
      packageDependencyViolations: [],
      lockfileDependencyViolations: [],
      passed: true,
      violations: [],
    });
    expect(first.sourceTreeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.sourceTreeSha256).toBe(first.sourceTreeSha256);
  });

  it('rejects old repository material, retired direct product sources, generated output, environment files, large files, transient traces, credential/state artifacts, high-confidence secrets, links and direct Legacy Prototype dependencies', async () => {
    const directory = await snapshotDirectory();
    await writeSnapshotManifest(directory, { '@legacy-prototype/ftp-srv': '1.0.5' });
    await writeFile(
      join(directory, 'bun.lock'),
      'packages:\n  legacy-prototype-themes: 1.0.1\n',
      'utf8',
    );
    await mkdir(join(directory, '.git'), { recursive: true });
    await mkdir(join(directory, 'vendor', 'legacy-prototype'), { recursive: true });
    await mkdir(
      join(
        directory,
        'packages',
        'runtime',
        'src',
        'adapters',
        'terminal-transfer',
        'legacy-prototype',
      ),
      { recursive: true },
    );
    await mkdir(join(directory, 'node_modules', 'fixture'), { recursive: true });
    await mkdir(join(directory, 'release'), { recursive: true });
    await mkdir(join(directory, 'tests', 'parity'), { recursive: true });
    await mkdir(join(directory, 'docs'), { recursive: true });
    await mkdir(join(directory, 'docs', 'product', 'assets'), { recursive: true });
    await mkdir(join(directory, 'apps', 'desktop', 'src', 'renderer', 'src', 'i18n'), {
      recursive: true,
    });
    await writeFile(
      join(
        directory,
        'apps',
        'desktop',
        'src',
        'renderer',
        'src',
        'i18n',
        'legacy-prototype-locales.generated.json',
      ),
      '{}\n',
    );
    await mkdir(join(directory, 'packages', 'runtime', 'src', 'adapters', 'widget'), {
      recursive: true,
    });
    await writeFile(
      join(
        directory,
        'packages',
        'runtime',
        'src',
        'adapters',
        'widget',
        'legacy-prototype-local-ftp-server.ts',
      ),
      'export {};\n',
    );
    await mkdir(join(directory, 'packages', 'runtime', 'src', 'application'), { recursive: true });
    await writeFile(
      join(
        directory,
        'packages',
        'runtime',
        'src',
        'application',
        'legacy-prototype-terminal-themes.generated.ts',
      ),
      'export {};\n',
    );
    await mkdir(join(directory, 'scripts', 'localization'), { recursive: true });
    await writeFile(
      join(directory, 'scripts', 'generate-legacy-prototype-themes.mjs'),
      'export {};\n',
    );
    await writeFile(
      join(directory, 'scripts', 'localization', 'generate-legacy-prototype-locales.mjs'),
      'export {};\n',
    );
    await writeFile(
      join(directory, '.env.local'),
      'PRIVATE_VALUE=not-for-source-control\n',
      'utf8',
    );
    await writeFile(join(directory, 'link-target.txt'), 'target\n', 'utf8');
    await writeFile(join(directory, 'docs', '.DS_Store'), 'Finder metadata\n', 'utf8');
    await writeFile(join(directory, 'generated-api.json'), Buffer.alloc(5 * 1024 * 1024 + 1));
    await writeFile(
      join(directory, 'private.pem'),
      [
        ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
        Buffer.alloc(192, 7).toString('base64'),
        ['-----END', 'PRIVATE KEY-----'].join(' '),
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(directory, 'token.txt'),
      [['github', 'pat', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('_'), 'fixture'].join('\n'),
      'utf8',
    );
    await mkdir(join(directory, 'tests', 'e2e', 'traces'), { recursive: true });
    await writeFile(join(directory, 'tests', 'e2e', 'traces', 'recording.zip'), 'trace fixture');
    await writeFile(join(directory, 'tests', 'e2e', 'network.har'), 'har fixture');
    await mkdir(join(directory, 'docs', 'api'), { recursive: true });
    await writeFile(join(directory, 'docs', 'api', 'openapi.json'), '{}\n');
    await mkdir(join(directory, 'credentials'), { recursive: true });
    await writeFile(join(directory, 'credentials', 'release-signing.p12'), Buffer.from([1, 2, 3]));
    await writeFile(join(directory, 'credentials', 'id_ed25519'), 'encrypted fixture bytes\n');
    await mkdir(join(directory, 'fixtures'), { recursive: true });
    await writeFile(join(directory, 'fixtures', 'axterm.sqlite-wal'), 'SQLite state fixture\n');
    if (process.platform !== 'win32')
      await symlink('link-target.txt', join(directory, 'source-link'));

    const report = auditIndependentSnapshot(directory);

    expect(report.passed).toBe(false);
    expect(report.forbiddenEntries).toEqual([
      '.git',
      'apps/desktop/src/renderer/src/i18n/legacy-prototype-locales.generated.json',
      'docs/.DS_Store',
      'docs/product/assets',
      'node_modules',
      'packages/runtime/src/adapters/terminal-transfer/legacy-prototype',
      'packages/runtime/src/adapters/widget/legacy-prototype-local-ftp-server.ts',
      'packages/runtime/src/application/legacy-prototype-terminal-themes.generated.ts',
      'release',
      'scripts/generate-legacy-prototype-themes.mjs',
      'scripts/localization/generate-legacy-prototype-locales.mjs',
      'tests/parity',
      'vendor/legacy-prototype',
    ]);
    expect(report.environmentFiles).toEqual(['.env.local']);
    expect(report.oversizedFiles).toEqual([
      { path: 'generated-api.json', bytes: 5 * 1024 * 1024 + 1 },
    ]);
    expect(report.symbolicLinks).toEqual(process.platform === 'win32' ? [] : ['source-link']);
    expect(report.transientArtifacts).toEqual([
      'tests/e2e/network.har',
      'tests/e2e/traces/recording.zip',
    ]);
    expect(report.prohibitedGeneratedFiles).toEqual(['docs/api/openapi.json']);
    expect(report.sensitiveArtifacts).toEqual([
      { path: 'credentials/id_ed25519', kind: 'private-key filename' },
      { path: 'credentials/release-signing.p12', kind: 'credential container' },
      { path: 'fixtures/axterm.sqlite-wal', kind: 'persistent state database' },
    ]);
    expect(report.highConfidenceSecrets).toEqual([
      { path: 'private.pem', types: ['PEM private key'] },
      { path: 'token.txt', types: ['GitHub token'] },
    ]);
    expect(report.packageDependencyViolations).toEqual([
      'package.json: dependencies.@legacy-prototype/ftp-srv',
    ]);
    expect(report.lockfileDependencyViolations).toEqual(['bun.lock: legacy-prototype-themes']);
  });
});
