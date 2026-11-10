import { describe, expect, it } from 'vitest';
import { ownedTranslations } from '../fixtures/level3-owner-translations.ts';
import { dictionaries } from '../../packages/plugins/configuration/src/client/locales.ts';
const translateAxterm = ownedTranslations('configuration', dictionaries);

describe('Axterm configuration safety copy', () => {
  it('explains in all four supported languages that Vault secrets stay local', () => {
    const expected: Record<'en' | 'ja' | 'zh-CN' | 'zh-TW', readonly string[]> = {
      en: ['Vault secrets', 'background image bytes', 'stay local'],
      ja: ['Vault', '背景画像', 'ローカル'],
      'zh-CN': ['Vault 密钥', '背景图片', '本机'],
      'zh-TW': ['Vault', '背景圖片', '本機'],
    };

    for (const [language, fragments] of Object.entries(expected) as [
      keyof typeof expected,
      readonly string[],
    ][]) {
      const safetyCopy = translateAxterm(language, 'axtermConfig.limits');
      for (const fragment of fragments) expect(safetyCopy).toContain(fragment);
    }
  });
});
