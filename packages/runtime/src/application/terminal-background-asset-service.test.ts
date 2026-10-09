import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalBackgroundAssetService } from './terminal-background-asset-service';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('TerminalBackgroundAssetService', () => {
  it('streams a granted PNG into persistent app-local storage and deletes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-background-'));
    directories.push(root);
    const source = join(root, 'source.png');
    const image = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from('bounded-image-body'),
    ]);
    await writeFile(source, image);
    const host = {
      resolveGrant: vi.fn(async () => ({
        path: source,
        kind: 'file',
        permissions: ['read'],
      })),
    };
    const assetDirectory = join(root, 'assets');
    const service = new TerminalBackgroundAssetService(assetDirectory, host as never);

    const created = await service.import('grant-image');
    const reopened = new TerminalBackgroundAssetService(assetDirectory, undefined);
    const resolved = await reopened.resolve(created.id);

    expect(created).toEqual({ id: expect.any(String), mimeType: 'image/png', bytes: image.length });
    expect(resolved.asset).toEqual(created);
    expect(host.resolveGrant).toHaveBeenCalledWith('grant-image');
    await reopened.delete(created.id);
    await expect(reopened.resolve(created.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects non-image input without creating an asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-background-invalid-'));
    directories.push(root);
    const source = join(root, 'source.txt');
    await writeFile(source, 'not an image');
    const service = new TerminalBackgroundAssetService(join(root, 'assets'), {
      resolveGrant: async () => ({ path: source, kind: 'file', permissions: ['read'] }),
    } as never);

    await expect(service.import('grant-text')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});
