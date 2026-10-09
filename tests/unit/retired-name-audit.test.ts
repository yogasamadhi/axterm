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
