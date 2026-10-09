import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZmodemReceiveFile } from './zmodem';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'axterm-zmodem-output-'));
  roots.push(root);
  return root;
}

describe('independent ZMODEM receive output', () => {
  it('publishes a complete file without exposing its staging name', async () => {
    const root = await fixture();
    const file = new ZmodemReceiveFile(join(root, 'payload.bin'), 'payload.bin', 4);
    await file.write(Buffer.from('DATA'));
    await file.commit();
    expect(await readFile(join(root, 'payload.bin'), 'utf8')).toBe('DATA');
    expect((await readdir(root)).filter((entry) => entry.endsWith('.part'))).toEqual([]);
  });

  it('refuses a destination created after staging and cleans the partial file', async () => {
    const root = await fixture();
    const target = join(root, 'race.bin');
    const file = new ZmodemReceiveFile(target, 'race.bin', 4);
    await file.write(Buffer.from('DATA'));
    await writeFile(target, 'original');
    await expect(file.commit()).rejects.toMatchObject({ code: 'EEXIST' });
    await file.cleanup();
    expect(await readFile(target, 'utf8')).toBe('original');
    expect((await readdir(root)).filter((entry) => entry.endsWith('.part'))).toEqual([]);
  });

  it('refuses bytes past the declared size and removes incomplete output', async () => {
    const root = await fixture();
    const file = new ZmodemReceiveFile(join(root, 'bounded.bin'), 'bounded.bin', 2);
    await file.write(Buffer.from([0, 255]));
    await expect(file.write(Buffer.from([1]))).rejects.toThrow('declared size');
    await file.cleanup();
    expect(await readdir(root)).toEqual([]);
  });

  it('reports a denied stage removal without leaking its path, then retries cleanup', async () => {
    const root = await fixture();
    const target = join(root, 'cancelled.bin');
    let removals = 0;
    const file = new ZmodemReceiveFile(target, 'cancelled.bin', 7, undefined, async (path) => {
      removals += 1;
      if (removals === 1)
        throw Object.assign(new Error(`Stage removal refused at ${path}`), { code: 'EACCES' });
      await unlink(path);
    });
    await file.write(Buffer.from('partial'));

    const failure = await file.cleanup().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'EACCES' });
    expect(String(failure)).not.toContain(root);
    expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toHaveLength(1);
    await file.cleanup();
    expect(removals).toBe(2);
    expect(await readdir(root)).toEqual([]);
  });

  it('preserves published bytes when stage-name removal fails and retries only that name', async () => {
    const root = await fixture();
    const target = join(root, 'published.bin');
    let removals = 0;
    const file = new ZmodemReceiveFile(target, 'published.bin', 4, undefined, async (path) => {
      removals += 1;
      if (removals === 1)
        throw Object.assign(new Error(`Stage removal refused at ${path}`), { code: 'EACCES' });
      await unlink(path);
    });
    await file.write(Buffer.from('DATA'));

    const failure = await file.commit().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'EACCES' });
    expect(String(failure)).not.toContain(root);
    expect(await readFile(target, 'utf8')).toBe('DATA');
    expect((await readdir(root)).filter((name) => name.endsWith('.part'))).toHaveLength(1);
    await file.cleanup();
    expect(await readdir(root)).toEqual(['published.bin']);
    expect(await readFile(target, 'utf8')).toBe('DATA');
  });

  it('retries a failed file-handle close before treating staging as closed', async () => {
    const root = await fixture();
    let closes = 0;
    const file = new ZmodemReceiveFile(
      join(root, 'close-retry.bin'),
      'close-retry.bin',
      4,
      async (handle, buffer, offset, length) => {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          closes += 1;
          if (closes === 1)
            throw Object.assign(new Error('Synthetic close refusal'), { code: 'EIO' });
          await close();
        };
        const { bytesWritten } = await handle.write(buffer, offset, length);
        return bytesWritten;
      },
    );
    await file.write(Buffer.from('DATA'));

    const failure = await file.cleanup().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'EIO' });
    await file.cleanup();
    expect(closes).toBe(2);
    expect(await readdir(root)).toEqual([]);
  });
});
