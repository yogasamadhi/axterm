import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  zstdEmbeddedLegalFiles,
  zstdEmbeddedLicenseViolations,
} from '../../scripts/commercialization/zstd-embedded-licenses.mjs';

const inventory = JSON.parse(
  readFileSync(
    resolve('docs/implementation/evidence/IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json'),
    'utf8',
  ),
);
const files = Object.fromEntries(
  zstdEmbeddedLegalFiles.map(({ outputName }) => [
    outputName,
    readFileSync(resolve('licenses', outputName)),
  ]),
);

describe('macOS native embedded Zstandard legal texts', () => {
  it('preserves the pinned Cargo source bytes for both alternatives', () => {
    expect(zstdEmbeddedLicenseViolations(inventory, files)).toEqual([]);
    expect(files['zstd-sys-Zstandard-LICENSE.txt']!.toString('utf8')).toContain(
      'Copyright (c) Meta Platforms, Inc. and affiliates.',
    );
    expect(files['zstd-sys-Zstandard-COPYING.txt']!.toString('utf8')).toContain(
      'GNU GENERAL PUBLIC LICENSE',
    );
  });

  it('rejects source-scope drift and any altered legal-text byte', () => {
    expect(
      zstdEmbeddedLicenseViolations({ ...inventory, target: 'x86_64-unknown-linux-gnu' }, files),
    ).toContain('Pinned macOS Rust source scope differs');
    const changed = Buffer.from(files['zstd-sys-Zstandard-LICENSE.txt']!);
    changed.writeUInt8(changed.readUInt8(0) ^ 1, 0);
    expect(
      zstdEmbeddedLicenseViolations(inventory, {
        ...files,
        'zstd-sys-Zstandard-LICENSE.txt': changed,
      }),
    ).toContain('zstd-sys-Zstandard-LICENSE.txt: original bytes differ');
  });

  it('keeps both files discoverable in the packaged legal directory and About', () => {
    const builder = readFileSync(resolve('apps/desktop/electron-builder.yml'), 'utf8');
    const panel = readFileSync(
      resolve('apps/desktop/src/renderer/src/app/legal-notices-panel.tsx'),
      'utf8',
    );
    const notices = readFileSync(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(builder).toContain('from: ../../licenses');
    expect(panel).toContain('licenses/*.txt');
    for (const { outputName } of zstdEmbeddedLegalFiles)
      expect(notices).toContain(`licenses/${outputName}`);
  });
});
