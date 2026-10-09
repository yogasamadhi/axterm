import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  licenseTextsFromBunReport,
  mismatchedPackagedLicenseTexts,
  serializeLicenseTexts,
} from '../../scripts/commercialization/generate-license-texts.mjs';

const temporaryDirectories: string[] = [];

function packageFixture(
  root: string,
  name: string,
  version: string,
  file?: string,
  copyright?: string,
  author?: string | Record<string, string>,
  contributors?: Array<string | Record<string, string>>,
) {
  const path = join(root, `${name}-${version}`);
  mkdirSync(path);
  writeFileSync(
    join(path, 'package.json'),
    JSON.stringify({
      name,
      version,
      license: 'MIT',
      ...(copyright ? { copyright } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(contributors !== undefined ? { contributors } : {}),
    }),
  );
  if (file !== undefined) writeFileSync(join(path, 'LICENSE'), file);
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('production root-license text archive', () => {
  it('preserves exact installed text and explicitly lists packages with no root file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'axterm-license-texts-'));
    temporaryDirectories.push(root);
    const license = 'Copyright Test Author\r\nPermission is hereby granted.\r\n';
    const alpha = packageFixture(
      root,
      'alpha',
      '1.0.0',
      license,
      'Copyright Alpha Publisher',
      { name: 'Alpha Maintainer', email: 'alpha@example.test' },
      ['Alpha Contributor', { name: 'Beta Contributor', url: 'https://example.test/beta' }],
    );
    const beta = packageFixture(root, 'beta', '2.0.0');
    const report = {
      MIT: [
        { name: 'beta', versions: ['2.0.0'], paths: [beta], license: 'MIT' },
        { name: 'alpha', versions: ['1.0.0'], paths: [alpha], license: 'MIT' },
      ],
    };
    const archive = licenseTextsFromBunReport(report, { allowedRoot: root });
    expect(archive.components.map(({ name }: { name: string }) => name)).toEqual(['alpha', 'beta']);
    expect(archive.missingRootLicenseFiles).toEqual([{ name: 'beta', version: '2.0.0' }]);
    expect(archive.components[0].files).toEqual([
      {
        name: 'LICENSE',
        sha256: createHash('sha256').update(license).digest('hex'),
        content: license,
      },
    ]);
    expect(archive.components[0].attribution).toEqual({
      manifestPublisherRecords: [
        {
          field: 'author',
          value: { name: 'Alpha Maintainer', email: 'alpha@example.test' },
        },
        { field: 'contributors', value: 'Alpha Contributor' },
        {
          field: 'contributors',
          value: { name: 'Beta Contributor', url: 'https://example.test/beta' },
        },
      ],
      manifestCopyright: 'Copyright Alpha Publisher',
      rootLicenseCopyrightLines: [{ file: 'LICENSE', line: 'Copyright Test Author' }],
    });
    expect(archive.missingCopyrightDeclarations).toEqual([{ name: 'beta', version: '2.0.0' }]);
    const serialized = await serializeLicenseTexts(archive);
    expect(JSON.parse(serialized)).toEqual(archive);
    expect(serialized).toContain('"manifestPublisherRecords":');
    expect(serialized).toMatch(/\n$/u);
  });

  it('recognizes Markdown-prefixed publisher copyright notices without rewriting their text', () => {
    const root = mkdtempSync(join(tmpdir(), 'axterm-license-heading-'));
    temporaryDirectories.push(root);
    const compact = packageFixture(
      root,
      'compact-heading',
      '1.0.0',
      '#Copyright (c) 2014-2018 Example Publisher\nPermission is hereby granted.\n',
    );
    const spaced = packageFixture(
      root,
      'spaced-heading',
      '1.0.0',
      '# Copyright (c) 2015 Another Publisher\nPermission is hereby granted.\n',
    );
    const noDeclaration = packageFixture(
      root,
      'no-declaration',
      '1.0.0',
      'See the copyright policy elsewhere.\n',
    );
    const archive = licenseTextsFromBunReport(
      {
        MIT: [
          { name: 'compact-heading', versions: ['1.0.0'], paths: [compact], license: 'MIT' },
          { name: 'spaced-heading', versions: ['1.0.0'], paths: [spaced], license: 'MIT' },
          {
            name: 'no-declaration',
            versions: ['1.0.0'],
            paths: [noDeclaration],
            license: 'MIT',
          },
        ],
      },
      { allowedRoot: root },
    );
    expect(
      archive.components.find(({ name }: { name: string }) => name === 'compact-heading')
        ?.attribution.rootLicenseCopyrightLines,
    ).toEqual([{ file: 'LICENSE', line: '#Copyright (c) 2014-2018 Example Publisher' }]);
    expect(
      archive.components.find(({ name }: { name: string }) => name === 'spaced-heading')
        ?.attribution.rootLicenseCopyrightLines,
    ).toEqual([{ file: 'LICENSE', line: '# Copyright (c) 2015 Another Publisher' }]);
    expect(archive.missingCopyrightDeclarations).toEqual([
      { name: 'no-declaration', version: '1.0.0' },
    ]);
  });

  it('detects source/packaged license-file drift', () => {
    const sha256 = createHash('sha256').update('License text').digest('hex');
    const archive = {
      components: [
        { name: 'alpha', version: '1.0.0', license: 'MIT', files: [{ name: 'LICENSE', sha256 }] },
      ],
    };
    expect(
      mismatchedPackagedLicenseTexts(archive, [
        {
          name: 'alpha',
          version: '1.0.0',
          license: 'MIT',
          licenseFiles: [{ path: '/node_modules/alpha/LICENSE', sha256 }],
        },
      ]),
    ).toEqual([]);
    expect(
      mismatchedPackagedLicenseTexts(archive, [
        {
          name: 'alpha',
          version: '1.0.0',
          license: 'MIT',
          licenseFiles: [{ path: '/node_modules/alpha/LICENSE', sha256: 'different' }],
        },
      ]),
    ).toEqual(['alpha@1.0.0/LICENSE: packaged root file differs from source archive']);
  });

  it('rejects a package path outside the installed graph', () => {
    const root = mkdtempSync(join(tmpdir(), 'axterm-license-texts-'));
    temporaryDirectories.push(root);
    const allowed = join(root, 'allowed');
    mkdirSync(allowed);
    const outside = packageFixture(root, 'outside', '1.0.0', 'license');
    expect(() =>
      licenseTextsFromBunReport(
        {
          MIT: [{ name: 'outside', versions: ['1.0.0'], paths: [outside], license: 'MIT' }],
        },
        { allowedRoot: allowed },
      ),
    ).toThrow(/escapes installed graph/);
  });
});
