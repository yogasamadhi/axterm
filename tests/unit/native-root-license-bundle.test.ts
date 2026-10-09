import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeRootLicenseBundleViolations } from '../../scripts/commercialization/native-root-license-bundle.mjs';

const inventory = JSON.parse(
  readFileSync(
    resolve('docs/implementation/evidence/IR11-FS-SAFE-RUST-DEPENDENCIES-2026-09-24.json'),
    'utf8',
  ),
);
const bundle = readFileSync(resolve('licenses/fs-safe-rust-ROOT-LICENSES.txt'));

describe('macOS native Rust root legal-text bundle', () => {
  it('preserves the pinned parent license and all 110 Cargo root files byte-for-byte', () => {
    expect(nativeRootLicenseBundleViolations(inventory, bundle)).toEqual([]);
    const content = bundle.toString('utf8');
    expect(content.match(/^===== BEGIN /gmu)).toHaveLength(111);
    expect(content).toContain('libbz2-rs-sys@0.2.5 / LICENSE');
    expect(content).toContain('unicode-ident@1.0.24 / LICENSE-UNICODE');
    expect(content).toContain('zstd-sys@2.1.0+zstd.1.5.7');
  });

  it('rejects a changed source byte, truncated text and unexpected appended material', () => {
    const changed = Buffer.from(bundle);
    const sourceTextOffset = changed.indexOf('Permission is hereby granted');
    expect(sourceTextOffset).toBeGreaterThan(0);
    changed.writeUInt8(changed.readUInt8(sourceTextOffset) ^ 1, sourceTextOffset);
    expect(nativeRootLicenseBundleViolations(inventory, changed)).toContainEqual(
      expect.stringContaining('original bytes differ'),
    );
    expect(
      nativeRootLicenseBundleViolations(inventory, bundle.subarray(0, bundle.length - 8)),
    ).not.toEqual([]);
    expect(
      nativeRootLicenseBundleViolations(inventory, Buffer.concat([bundle, Buffer.from('x')])),
    ).toEqual(['Unexpected trailing native legal material']);
  });

  it('keeps the installed-file and About/Legal wiring explicit', () => {
    const builder = readFileSync(resolve('apps/desktop/electron-builder.yml'), 'utf8');
    const panel = readFileSync(
      resolve('apps/desktop/src/renderer/src/app/legal-notices-panel.tsx'),
      'utf8',
    );
    const notices = readFileSync(resolve('THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(builder).toContain('from: ../../licenses');
    expect(panel).toContain('licenses/*.txt');
    expect(notices).toContain('licenses/fs-safe-rust-ROOT-LICENSES.txt');
  });
});
