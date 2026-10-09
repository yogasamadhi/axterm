import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StagedTrzszWriter } from './trzsz';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'axterm-trzsz-output-'));
  roots.push(path);
  return path;
}

describe('independent TRZSZ staged writer', () => {
  it('keeps bytes private until verification and publishes empty files too', async () => {
    const directory = await root();
    const destination = join(directory, 'report.bin');
    const writer = new StagedTrzszWriter(destination, 'report.bin');
    await writer.writeFile(Buffer.from([0, 1, 2, 255]));
    writer.closeFile();
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await writer.commit();
    expect(await readFile(destination)).toEqual(Buffer.from([0, 1, 2, 255]));

    const empty = new StagedTrzszWriter(join(directory, 'empty.bin'), 'empty.bin');
    await empty.commit();
    expect(await readFile(join(directory, 'empty.bin'))).toHaveLength(0);
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('does not overwrite a destination created during transfer', async () => {
    const directory = await root();
    const destination = join(directory, 'existing.bin');
    const writer = new StagedTrzszWriter(destination, 'existing.bin');
    await writer.writeFile(Buffer.from('new bytes'));
    await writeFile(destination, 'original');
    await expect(writer.commit()).rejects.toMatchObject({ code: 'EEXIST' });
    await writer.deleteFile();
    expect(await readFile(destination, 'utf8')).toBe('original');
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('fails a missing output directory without publishing or hanging', async () => {
    const directory = await root();
    const destination = join(directory, 'missing', 'output.bin');
    const writer = new StagedTrzszWriter(destination, 'output.bin');
    await expect(writer.writeFile(Buffer.from('DATA'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(writer.deleteFile()).resolves.toBe(destination);
  });

  it('reports a failed cancellation cleanup and retries only its own staged file', async () => {
    const directory = await root();
    const destination = join(directory, 'cancelled.bin');
    let removals = 0;
    const writer = new StagedTrzszWriter(destination, 'cancelled.bin', undefined, async (path) => {
      removals += 1;
      if (removals === 1)
        throw Object.assign(new Error(`Stage removal refused at ${path}`), { code: 'EACCES' });
      await unlink(path);
    });
    await writer.writeFile(Buffer.from('partial'));

    const failure = await writer.deleteFile().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'EACCES' });
    expect(String(failure)).not.toContain(directory);
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toHaveLength(1);
    await expect(writer.deleteFile()).resolves.toBe(destination);
    expect(removals).toBe(2);
    expect(await readdir(directory)).toEqual([]);
  });

  it('retries staged-name cleanup after successful publication without deleting the final file', async () => {
    const directory = await root();
    const destination = join(directory, 'published.bin');
    let removals = 0;
    const writer = new StagedTrzszWriter(destination, 'published.bin', undefined, async (path) => {
      removals += 1;
      if (removals === 1)
        throw Object.assign(new Error(`Stage removal refused at ${path}`), { code: 'EACCES' });
      await unlink(path);
    });
    await writer.writeFile(Buffer.from('verified'));

    const failure = await writer.commit().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'EACCES' });
    expect(String(failure)).not.toContain(directory);
    expect(await readFile(destination, 'utf8')).toBe('verified');
    expect((await readdir(directory)).filter((name) => name.endsWith('.part'))).toHaveLength(1);
    await writer.deleteFile();
    expect(await readdir(directory)).toEqual(['published.bin']);
    expect(await readFile(destination, 'utf8')).toBe('verified');
  });
});
