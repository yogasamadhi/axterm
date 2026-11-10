import { describe, expect, it } from 'vitest';
import {
  inspectTestRetention,
  checkTestRetention,
  inspectSemanticReplacement,
  testSemantics,
} from '../../scripts/level3-test-retention.mjs';
const original =
  "it.skipIf(process.platform === 'win32')('real bytes', async () => { expect(received).toEqual(bytes); expect(closed).toBe(true); });";
describe('Level 3 test retirement guard', () => {
  it('retains assertions, conditional execution and permits owner imports', () => {
    expect(
      inspectTestRetention(
        testSemantics(original),
        `import { received } from './owner.ts'; ${original}`,
      ),
    ).toEqual([]);
  });
  it('rejects deleted and weakened assertions', () => {
    for (const changed of [
      original.replace('expect(closed).toBe(true);', ''),
      original.replace('toEqual(bytes)', 'toBeDefined()'),
    ])
      expect(inspectTestRetention(testSemantics(original), changed).join(' ')).toContain(
        'assertion',
      );
  });
  it('rejects skipping, renaming and condition changes without an explicit title mapping', () => {
    for (const changed of [
      original.replace("process.platform === 'win32'", 'true'),
      original.replace('real bytes', 'different case'),
    ])
      expect(inspectTestRetention(testSemantics(original), changed).join(' ')).toContain(
        'declaration',
      );
    expect(
      inspectTestRetention(testSemantics(original), original.replace('real bytes', 'owner bytes'), {
        'real bytes': 'owner bytes',
      }),
    ).toEqual([]);
  });
});

describe('explicit semantic successor coverage', () => {
  const current = "it('owned bytes', () => { expect(bytes).toEqual(originalBytes); });";
  const row = {
    baseline: testSemantics(original),
    replacements: [
      {
        path: 'owned.test.ts',
        baseline: testSemantics(current),
        cases: [
          {
            from: 'real bytes',
            to: 'owned bytes',
            reason: 'Owned generation-bound service replaces the retired wire.',
          },
        ],
      },
    ],
  };
  it('admits explicit per-case successors with frozen successor assertions', () => {
    expect(inspectSemanticReplacement(row, new Map([['owned.test.ts', current]]))).toEqual([]);
  });
  it('rejects unmapped old cases and missing successor cases or explanations', () => {
    for (const changed of [
      { ...row, replacements: [{ ...row.replacements[0]!, cases: [] }] },
      {
        ...row,
        replacements: [
          {
            ...row.replacements[0]!,
            cases: [{ from: 'real bytes', to: 'missing case', reason: 'ownership changed' }],
          },
        ],
      },
      {
        ...row,
        replacements: [
          {
            ...row.replacements[0]!,
            cases: [{ from: 'real bytes', to: 'owned bytes', reason: '' }],
          },
        ],
      },
    ])
      expect(
        inspectSemanticReplacement(changed, new Map([['owned.test.ts', current]])).length,
      ).toBeGreaterThan(0);
  });
  it('rejects a weakened successor and a missing baseline or source', () => {
    expect(
      inspectSemanticReplacement(
        row,
        new Map([['owned.test.ts', current.replace('toEqual(originalBytes)', 'toBeDefined()')]]),
      ).join(' '),
    ).toContain('assertion');
    expect(inspectSemanticReplacement(row, new Map()).join(' ')).toContain('source missing');
    expect(
      inspectSemanticReplacement(
        { ...row, replacements: [{ ...row.replacements[0]!, baseline: {} }] },
        new Map([['owned.test.ts', current]]),
      ).join(' '),
    ).toContain('baseline missing');
  });
});

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('rejects frozen historical input edits independently of the source-review ledger', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-retention-input-'));
  try {
    await mkdir(join(root, 'tests/fixtures/engineering/level3'), { recursive: true });
    const body = 'recorded historical data';
    await writeFile(join(root, 'input.json'), body);
    await writeFile(
      join(root, 'tests/fixtures/engineering/level3/test-retirement.json'),
      JSON.stringify({
        tests: [],
        frozenInputs: { 'input.json': createHash('sha256').update(body).digest('hex') },
      }),
    );
    expect(await checkTestRetention(root)).toMatchObject({
      retired: 0,
      superseded: 0,
      retargeted: 0,
      pending: 0,
    });
    await writeFile(join(root, 'input.json'), 'replacement data');
    await expect(checkTestRetention(root)).rejects.toThrow('frozen historical input changed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe('computed protocol and native scenario identities', () => {
  const source =
    'for (const mode of ["screen", "buffer"]) it(`keeps ${mode} bytes`, () => { expect(bytes).toEqual(original); });';
  it('records an interpolated test title independently from its implementation', () => {
    expect(testSemantics(source).declarations).toEqual([
      { name: 'computed:`keeps ${mode} bytes`', invocation: 'it' },
    ]);
    expect(inspectTestRetention(testSemantics(source), source)).toEqual([]);
  });
  it('rejects dropping, renaming or skipping an interpolated scenario', () => {
    for (const changed of [
      source.replace('it(`keeps', 'it.skip(`keeps'),
      source.replace('keeps ${mode} bytes', 'different ${mode} bytes'),
      source.replace(/it\(`keeps[\s\S]*$/, ''),
    ])
      expect(inspectTestRetention(testSemantics(source), changed).join(' ')).toContain(
        'declaration',
      );
  });
});
it('rejects dropped or forced platform conditions in native Playwright scenarios', () => {
  const source =
    'test(`native ${mode}`, async () => { test.skip(process.platform === "win32", "POSIX fixture"); expect(closed).toBe(true); });';
  const baseline = testSemantics(source);
  expect(baseline.conditions).toHaveLength(1);
  for (const changed of [
    source.replace('test.skip(process.platform === "win32", "POSIX fixture");', ''),
    source.replace('process.platform === "win32"', 'true'),
  ])
    expect(inspectTestRetention(baseline, changed).join(' ')).toContain('condition');
});
