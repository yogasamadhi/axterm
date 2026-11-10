import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { canonicalizeWatchPath } from '@axterm/infra-home-paths';
import type { Page } from '@playwright/test';

/** Capture review pairs during the original run; never write a golden or replace its assertion. */
export async function captureVisualReview(
  page: Page,
  name: string,
  title: string,
  directory = process.env.AXTERM_VISUAL_REVIEW_DIRECTORY,
): Promise<void> {
  if (!directory) return;
  const root = resolve('out/level3-migration'),
    output = resolve(directory);
  if (
    !output.startsWith(root + sep) ||
    basename(name) !== name ||
    !/^[a-zA-Z0-9_-]+\.png$/u.test(name)
  )
    throw Error('Visual review requires an isolated output and a finite snapshot name');
  const [repository, canonicalRoot, canonicalOutput] = await Promise.all([
    canonicalizeWatchPath(resolve('.')),
    canonicalizeWatchPath(root),
    canonicalizeWatchPath(output),
  ]);
  if (
    canonicalRoot !== join(repository, 'out/level3-migration') ||
    !canonicalOutput.startsWith(canonicalRoot + sep)
  )
    throw Error('Visual review output escapes its owned directory');
  const filename = name.replace(/\.png$/u, `-visual-${process.platform}.png`);
  for (const target of [
    join(output, 'before', filename),
    join(output, 'after', filename),
    join(output, filename + '.json'),
  ]) {
    if (!(await canonicalizeWatchPath(target)).startsWith(canonicalOutput + sep))
      throw Error('Visual review file escapes its owned directory');
  }
  const expectedPath = 'tests/e2e/visual.spec.ts-snapshots/' + filename;
  const baseline = JSON.parse(
    await readFile(resolve('tests/fixtures/engineering/level3/baseline.json'), 'utf8'),
  ) as { files: Array<{ path: string; sha256: string }> };
  const expected = await readFile(resolve(expectedPath));
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const expectedSha256 = hash(expected);
  if (baseline.files.find((row) => row.path === expectedPath)?.sha256 !== expectedSha256)
    throw Error('Frozen visual baseline identity changed');
  await mkdir(join(output, 'before'), { recursive: true });
  await mkdir(join(output, 'after'), { recursive: true });
  const actual = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  await writeFile(join(output, 'before', filename), expected);
  await writeFile(join(output, 'after', filename), actual);
  await writeFile(
    join(output, filename + '.json'),
    JSON.stringify(
      {
        name: filename,
        title,
        before: 'before/' + filename,
        after: 'after/' + filename,
        expectedSha256,
        actualSha256: hash(actual),
        thresholdUnchanged: 0.01,
        ownerAcceptance: 'pending',
      },
      null,
      2,
    ) + '\n',
  );
}
