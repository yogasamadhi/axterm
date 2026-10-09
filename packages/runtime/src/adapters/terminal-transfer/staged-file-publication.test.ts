import { link, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  destinationDoesNotSupportAtomicPublication,
  destinationCreatedBeforePublicationFailure,
  publishStagedFile,
} from './staged-file-publication';

const roots: string[] = [];
const realNoHardlinkDirectory = process.env.AXTERM_REAL_NOHARDLINK_DIRECTORY;
const realNoReplaceDirectory = process.env.AXTERM_REAL_NO_REPLACE_DIRECTORY;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'axterm-staged-publication-'));
  roots.push(root);
  return root;
}

function unsupportedHardLink(): never {
  const error = Object.assign(new Error('Hard links are not supported by this filesystem'), {
    code: 'EOPNOTSUPP',
  });
  throw error;
}

describe('staged transfer-file publication', () => {
  it.skipIf(!realNoReplaceDirectory)(
    'fails closed on a real volume that rejects both hard links and native no-replace rename',
    async () => {
      const root = await mkdtemp(join(realNoReplaceDirectory!, 'axterm-ir03-'));
      roots.push(root);
      const source = join(root, '.received.part');
      const destination = join(root, 'received.bin');
      const probe = join(root, 'hardlink-probe');
      const bytes = Buffer.from([0, 1, 2, 255]);
      await writeFile(source, bytes);
      await expect(link(source, probe)).rejects.toMatchObject({
        code: expect.stringMatching(/^(?:EPERM|EOPNOTSUPP|ENOTSUP|ENOSYS|EINVAL)$/u),
      });

      await expect(publishStagedFile(source, destination)).rejects.toThrow(
        /(?:not supported|unsupported)/iu,
      );
      expect(await readFile(source)).toEqual(bytes);
      await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });

      await writeFile(destination, 'existing bytes');
      await expect(publishStagedFile(source, destination)).rejects.toThrow();
      expect(await readFile(destination, 'utf8')).toBe('existing bytes');
      expect(await readFile(source)).toEqual(bytes);
      // macOS writes AppleDouble metadata sidecars on ExFAT; those are not
      // transfer payloads or publication staging names.
      expect((await readdir(root)).filter((name) => !name.startsWith('._')).sort()).toEqual([
        '.received.part',
        'received.bin',
      ]);
    },
  );

  it.skipIf(!realNoHardlinkDirectory)(
    'publishes on a real hard-link-limited filesystem without partial or overwritten output',
    async () => {
      const root = await mkdtemp(join(realNoHardlinkDirectory!, 'axterm-ir03-'));
      roots.push(root);
      const source = join(root, '.received.part');
      const destination = join(root, 'received.bin');
      const probe = join(root, 'hardlink-probe');
      await writeFile(source, Buffer.from([0, 1, 2, 255]));
      await expect(link(source, probe)).rejects.toMatchObject({
        code: expect.stringMatching(/^(?:EPERM|EOPNOTSUPP|ENOTSUP|ENOSYS|EINVAL)$/u),
      });

      await publishStagedFile(source, destination);
      expect(await readFile(destination)).toEqual(Buffer.from([0, 1, 2, 255]));
      await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' });

      const collision = join(root, '.collision.part');
      await writeFile(collision, 'new bytes');
      await expect(publishStagedFile(collision, destination)).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(await readFile(destination)).toEqual(Buffer.from([0, 1, 2, 255]));
      expect(await readFile(collision, 'utf8')).toBe('new bytes');
    },
  );

  it('uses native atomic no-replace rename when the destination rejects hard links', async () => {
    const root = await fixture();
    const source = join(root, '.staged.part');
    const destination = join(root, 'received.bin');
    await writeFile(source, Buffer.from([0, 1, 2, 255]));

    await publishStagedFile(source, destination, { linkFile: async () => unsupportedHardLink() });

    expect(await readFile(destination)).toEqual(Buffer.from([0, 1, 2, 255]));
    await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never overwrites an existing destination when native rename is used', async () => {
    const root = await fixture();
    const source = join(root, '.staged.part');
    const destination = join(root, 'received.bin');
    await writeFile(source, 'replacement');
    await writeFile(destination, 'original');

    await expect(
      publishStagedFile(source, destination, { linkFile: async () => unsupportedHardLink() }),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(await readFile(destination, 'utf8')).toBe('original');
    expect(await readFile(source, 'utf8')).toBe('replacement');
  });

  it('fails closed without native support instead of exposing a partial final file', async () => {
    const root = await fixture();
    const source = join(root, '.staged.part');
    const destination = join(root, 'received.bin');
    await writeFile(source, 'xmodem bytes');
    const unavailable = Object.assign(new Error('Native helper unavailable'), {
      code: 'helper-unavailable',
    });

    await expect(
      publishStagedFile(source, destination, {
        linkFile: async () => unsupportedHardLink(),
        nativePublish: async () => Promise.reject(unavailable),
      }),
    ).rejects.toBe(unavailable);

    expect(await readFile(source, 'utf8')).toBe('xmodem bytes');
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the hard-link fast path without loading the native fallback', async () => {
    const root = await fixture();
    const source = join(root, '.staged.part');
    const destination = join(root, 'received.bin');
    await writeFile(source, 'complete bytes');
    const nativePublish = vi.fn();

    await publishStagedFile(source, destination, { linkFile: link, nativePublish });

    expect(nativePublish).not.toHaveBeenCalled();
    expect(await readFile(destination, 'utf8')).toBe('complete bytes');
    expect(await readFile(source, 'utf8')).toBe('complete bytes');
  });

  it('recognizes a preserved final file after a post-rename failure receipt', () => {
    const postRename = Object.assign(new Error('Directory sync failed'), {
      code: 'helper-failed',
      details: { targetCreated: true, cleanup: 'preserved', phase: 'directory-sync' },
    });
    const beforeRename = Object.assign(new Error('Native helper unavailable'), {
      code: 'helper-unavailable',
    });

    expect(destinationCreatedBeforePublicationFailure(postRename)).toBe(true);
    expect(destinationCreatedBeforePublicationFailure(beforeRename)).toBe(false);
  });

  it('classifies only filesystem unsupported errors as unavailable atomic publication', () => {
    for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])
      expect(
        destinationDoesNotSupportAtomicPublication(Object.assign(new Error(code), { code })),
      ).toBe(true);
    for (const code of ['EEXIST', 'EACCES', 'ENOSPC'])
      expect(
        destinationDoesNotSupportAtomicPublication(Object.assign(new Error(code), { code })),
      ).toBe(false);
  });

  it('does not mask ordinary hard-link failures as filesystem portability', async () => {
    const root = await fixture();
    const source = join(root, '.staged.part');
    const destination = join(root, 'received.bin');
    await writeFile(source, 'bytes');
    const permissionError = Object.assign(new Error('Permission denied'), { code: 'EACCES' });

    await expect(
      publishStagedFile(source, destination, {
        linkFile: async () => Promise.reject(permissionError),
      }),
    ).rejects.toBe(permissionError);

    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(source, 'utf8')).toBe('bytes');
  });
});
