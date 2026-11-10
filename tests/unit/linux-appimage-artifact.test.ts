import { describe, expect, it } from 'vitest';
import { findSquashfsOffset } from '../../scripts/commercialization/verify-linux-appimage.mjs';

function superblock(header: Buffer, offset: number, filesystemBytes = 256n): void {
  header.write('hsqs', offset, 'ascii');
  header.writeUInt32LE(131072, offset + 12);
  header.writeUInt16LE(4, offset + 28);
  header.writeUInt16LE(0, offset + 30);
  header.writeBigUInt64LE(filesystemBytes, offset + 40);
}

describe('Linux AppImage payload gate', () => {
  it('ignores magic bytes in the executable and finds one bounded SquashFS superblock', () => {
    const header = Buffer.alloc(512);
    header.write('hsqs', 4, 'ascii');
    superblock(header, 128);
    expect(findSquashfsOffset(header, 512)).toBe(128);
  });

  it('rejects a missing, ambiguous or out-of-bounds payload', () => {
    expect(() => findSquashfsOffset(Buffer.alloc(512), 512)).toThrow(/found 0/u);
    const ambiguous = Buffer.alloc(1024);
    superblock(ambiguous, 128);
    superblock(ambiguous, 512);
    expect(() => findSquashfsOffset(ambiguous, 1024)).toThrow(/found 2/u);
    const outOfBounds = Buffer.alloc(512);
    superblock(outOfBounds, 128, 1024n);
    expect(() => findSquashfsOffset(outOfBounds, 512)).toThrow(/found 0/u);
  });
});
