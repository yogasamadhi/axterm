import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const safeTransferName = require('./safe-transfer-name.cjs') as (
  value: unknown,
  reservedBytes?: number,
) => string;

describe('safe transfer name', () => {
  it('keeps a single file leaf and neutralizes path, control and Windows metacharacters', () => {
    expect(safeTransferName('../report*.txt')).toBe('.._report_.txt');
    expect(safeTransferName('dir\\child:name?.txt')).toBe('dir_child_name_.txt');
    expect(safeTransferName('a\u0000b\u007fc')).toBe('a_b_c');
    expect(safeTransferName('  .config  ')).toBe('.config');
    expect(safeTransferName('file... ')).toBe('file');
  });

  it('does not expose Windows device names even when they have an extension', () => {
    expect(safeTransferName('CON')).toBe('_CON');
    expect(safeTransferName('lPt9.log')).toBe('_lPt9.log');
    expect(safeTransferName('COM1 .txt')).toBe('_COM1 .txt');
    expect(safeTransferName('COM¹.log')).toBe('_COM¹.log');
    expect(safeTransferName('CONOUT$')).toBe('_CONOUT$');
  });

  it('returns a safe fallback for empty or non-string values', () => {
    expect(safeTransferName('...')).toBe('unnamed');
    expect(safeTransferName('  ')).toBe('unnamed');
    expect(safeTransferName(undefined)).toBe('unnamed');
  });

  it('enforces a UTF-8 byte bound without splitting a code point and keeps short extensions', () => {
    const longAscii = safeTransferName(`${'a'.repeat(400)}.txt`);
    expect(longAscii).toHaveLength(255);
    expect(longAscii.endsWith('.txt')).toBe(true);

    const longUnicode = safeTransferName(`${'🌿'.repeat(100)}.log`);
    expect(Buffer.byteLength(longUnicode, 'utf8')).toBeLessThanOrEqual(255);
    expect(longUnicode.endsWith('.log')).toBe(true);
    expect(longUnicode).not.toContain('\ufffd');

    const oversizedExtension = safeTransferName(`🌿.${'x'.repeat(254)}`);
    expect(Buffer.byteLength(oversizedExtension, 'utf8')).toBeLessThanOrEqual(255);
    expect(oversizedExtension.startsWith('🌿')).toBe(true);
  });

  it('limits work for an oversized untrusted protocol name', () => {
    expect(safeTransferName('z'.repeat(100_000))).toBe('z'.repeat(255));
    expect(safeTransferName(`${'z'.repeat(4095)}🌿tail`)).not.toContain('\ud83c');
  });

  it('reserves bytes for collision suffixes without breaking UTF-8 or extensions', () => {
    const suffix = '.1234567890abcdef1234567890abcdef';
    const name = safeTransferName(`${'🌿'.repeat(90)}.log`, Buffer.byteLength(suffix));
    expect(Buffer.byteLength(name + suffix, 'utf8')).toBeLessThanOrEqual(255);
    expect(name.endsWith('.log')).toBe(true);
  });
});
