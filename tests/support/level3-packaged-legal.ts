import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import { LegalDocuments } from '../../packages/plugins/configuration/src/legal.ts';

/** Use the actual package-material owner and exact source bytes, independent of retired UI source. */
export async function assertOwnedLegalMaterial(names: readonly string[]): Promise<void> {
  const owner = new LegalDocuments(resolve('packages/plugins/configuration/lib/legal'));
  try {
    for (const name of names) {
      const entry = owner.list().find((row) => row.name === name);
      expect(entry, `Missing packaged legal material: ${name}`).toBeDefined();
      let text = '';
      for await (const chunk of owner.read(entry!.id, new AbortController().signal))
        text += chunk.text;
      expect(Buffer.from(text, 'utf8')).toEqual(await readFile(resolve(name)));
    }
  } finally {
    await owner.close();
  }
}
