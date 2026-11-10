import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { inventoryLegacyReferences } from '../../scripts/level3-legacy-inventory.mjs';

it('counts a test embedded in a retired package as a legacy entry even without an outgoing import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-embedded-inventory-'));
  const path = 'packages/contracts/src/embedded.test.ts';
  try {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), "it('embedded', () => {});");
    expect(inventoryLegacyReferences(root, [path])).toMatchObject({
      testEntries: 1,
      tests: [{ entry: path, findings: [{ specifier: '<legacy-test-entry>', chain: [path] }] }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('finds legacy test dependencies through re-exports, dynamic imports and aliases without looping, and records static build paths separately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-l3-inventory-'));
  const sources = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { paths: { '@fixture/*': ['./helpers/*'] } },
    }),
    'tests/indirect.test.ts': "import '@fixture/first';",
    'tests/current.test.ts': "import '../helpers/current';",
    'helpers/first.ts': "export * from './second.js';",
    'helpers/second.ts': "import './first'; import('../packages/runtime/src/index.ts');",
    'helpers/current.ts': 'export {};',
    'scripts/build.mjs': "const inputs = ['packages/contracts/src/index.ts'];",
  };
  try {
    for (const [file, source] of Object.entries(sources)) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await writeFile(join(root, file), source);
    }
    const result = inventoryLegacyReferences(root, Object.keys(sources));
    expect(result.testEntries).toBe(2);
    expect(result.tests).toEqual([
      {
        entry: 'tests/indirect.test.ts',
        findings: [
          {
            specifier: '../packages/runtime/src/index.ts',
            chain: [
              'tests/indirect.test.ts',
              'helpers/first.ts',
              'helpers/second.ts',
              'packages/runtime/src/index.ts',
            ],
          },
        ],
      },
    ]);
    expect(result.references.map((row) => row.file)).toEqual([
      'helpers/second.ts',
      'scripts/build.mjs',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
