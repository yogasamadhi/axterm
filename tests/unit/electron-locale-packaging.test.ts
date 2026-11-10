import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Electron runtime locale packaging', () => {
  it('keeps Electron runtime resources within the four released Axterm locales', () => {
    const configuration = readFileSync(resolve('apps/desktop/electron-builder.yml'), 'utf8');
    const languages = configuration.match(/^electronLanguages:\n((?: {2}- [^\n]+\n?)+)/mu)?.[1];

    expect(languages).toBeDefined();
    expect(languages?.match(/^ {2}- (.+)$/gmu)?.map((line) => line.slice(4))).toEqual([
      'en',
      'ja',
      'zh-CN',
      'zh-TW',
    ]);
  });
});
