import { TextDecoder } from 'node:util';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export async function buildLegalDocuments(directory = dirname(fileURLToPath(import.meta.url))) {
  const root = resolve(directory, '../../..'),
    target = join(directory, 'lib/legal');
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const inputs = [
    'LICENSE',
    'THIRD_PARTY_NOTICES.txt',
    'compliance/THIRD_PARTY_COMPONENTS.json',
    'compliance/AXTERM_PRODUCTION_DEPENDENCIES.spdx.json',
    'compliance/THIRD_PARTY_LICENSE_TEXTS.json',
    ...(await readdir(join(root, 'licenses')))
      .filter((name) => name.endsWith('.txt'))
      .sort()
      .map((name) => 'licenses/' + name),
  ];
  const entries = [];
  let total = 0;
  for (const name of inputs) {
    const content = await readFile(join(root, name));
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    total += content.length;
    if (content.length > 8 * 1024 * 1024 || total > 32 * 1024 * 1024 || inputs.length > 128)
      throw Error('Legal artifact capacity exceeded');
    const id = createHash('sha256').update(name).digest('hex').slice(0, 24),
      sha256 = createHash('sha256').update(content).digest('hex');
    await writeFile(join(target, id + '.txt'), content);
    entries.push({ id, name, bytes: content.length, sha256 });
  }
  await writeFile(
    join(target, 'manifest.json'),
    JSON.stringify({ version: 1, documents: entries }) + '\n',
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildLegalDocuments();
