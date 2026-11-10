import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { auditRetiredName } from '../../scripts/commercialization/audit-retired-name.mjs';

const directories: string[] = [];
const retiredName = ['elect', 'erm'].join('');

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('retired-name source guard', () => {
  it('ignores Next build caches while continuing to inspect platform source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-platform-name-'));
    directories.push(root);
    await mkdir(join(root, 'platform/portal/.next'), { recursive: true });
    await mkdir(join(root, 'platform/portal/src'), { recursive: true });
    await writeFile(join(root, 'platform/portal/.next/cache.js'), retiredName);
    await writeFile(join(root, 'platform/portal/tsconfig.tsbuildinfo'), retiredName);
    expect(auditRetiredName(root).passed).toBe(true);
    await writeFile(join(root, 'platform/portal/src/page.ts'), retiredName);
    expect(auditRetiredName(root).findings).toEqual([
      { path: 'platform/portal/src/page.ts', kind: 'content', occurrences: 1 },
    ]);
  });

  it('accepts the checked-in source tree', () => {
    expect(auditRetiredName().findings).toEqual([]);
  });

  it('detects paths and ASCII or UTF-16 content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'axterm-retired-name-'));
    directories.push(root);
    await mkdir(join(root, 'packages'), { recursive: true });
    await writeFile(join(root, 'packages', `${retiredName}.ts`), 'export const value = true;');
    await writeFile(join(root, 'packages', 'ascii.ts'), `const value = '${retiredName}';`);
    await writeFile(join(root, 'packages', 'utf16.txt'), Buffer.from(retiredName, 'utf16le'));
    expect(auditRetiredName(root).findings).toEqual([
      { path: 'packages/ascii.ts', kind: 'content', occurrences: 1 },
      { path: `packages/${retiredName}.ts`, kind: 'path', occurrences: 1 },
      { path: 'packages/utf16.txt', kind: 'content', occurrences: 1 },
    ]);
  });
});
