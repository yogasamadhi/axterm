import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, it, vi } from 'vitest';
import { captureVisualReview } from '../support/level3-visual-review';
const reviewRoot = resolve('out/level3-migration');
it.skipIf(process.platform !== 'darwin')(
  'exports exact frozen before bytes and the current capture while leaving owner acceptance pending',
  async () => {
    await mkdir(reviewRoot, { recursive: true });
    const output = await mkdtemp(join(reviewRoot, 'visual-review-unit-'));
    try {
      const name = 'axterm-shell-1280x800-visual-darwin.png',
        path = resolve('tests/e2e/visual.spec.ts-snapshots', name),
        bytes = await readFile(path);
      const screenshot = vi.fn(async () => bytes),
        page = { screenshot } as unknown as Page;
      await captureVisualReview(
        page,
        'axterm-shell-1280x800.png',
        'synthetic unit capture',
        output,
      );
      expect(await readFile(join(output, 'before', name))).toEqual(bytes);
      expect(await readFile(path)).toEqual(bytes);
      expect(JSON.parse(await readFile(join(output, name + '.json'), 'utf8'))).toMatchObject({
        ownerAcceptance: 'pending',
        thresholdUnchanged: 0.01,
      });
      expect(screenshot).toHaveBeenCalledTimes(1);
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  },
);
it('rejects traversal, outside output and a symlink escape before taking a screenshot', async () => {
  await mkdir(reviewRoot, { recursive: true });
  const output = await mkdtemp(join(reviewRoot, 'visual-review-guard-'));
  try {
    const screenshot = vi.fn(),
      page = { screenshot } as unknown as Page;
    await expect(captureVisualReview(page, '../golden.png', 'fixture', output)).rejects.toThrow(
      'isolated',
    );
    await expect(captureVisualReview(page, 'safe.png', 'fixture', resolve('.'))).rejects.toThrow(
      'isolated',
    );
    await symlink(
      resolve('.'),
      join(output, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      captureVisualReview(page, 'safe.png', 'fixture', join(output, 'escape/uncreated')),
    ).rejects.toThrow('escapes');
    await symlink(
      resolve('tests/e2e/visual.spec.ts-snapshots'),
      join(output, 'before'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      captureVisualReview(page, 'axterm-shell-1280x800.png', 'fixture', output),
    ).rejects.toThrow('file escapes');
    expect(screenshot).not.toHaveBeenCalled();
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
