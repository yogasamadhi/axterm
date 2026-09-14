import { describe, expect, it } from 'vitest';
import {
  APP_LOCALES,
  ELECTERM_LOCALE_KEY_COUNT,
  ELECTERM_LOCALE_SOURCE,
  languageDirection,
  normalizeAppLanguage,
  resolveAppLanguage,
  translateAxterm,
  translateElecterm,
} from '../../apps/desktop/src/renderer/src/i18n/core';

describe('desktop localization', () => {
  it('pins every Electerm locale with identical complete key coverage', () => {
    expect(ELECTERM_LOCALE_SOURCE).toEqual({
      package: '@electerm/electerm-locales',
      version: '2.3.16',
      license: 'MIT',
    });
    expect(APP_LOCALES.map(({ id }) => id)).toEqual([
      'ar',
      'de',
      'en',
      'es',
      'fr',
      'hu',
      'id',
      'ja',
      'ko',
      'pl',
      'pt-BR',
      'ru',
      'tr',
      'zh-CN',
      'zh-TW',
    ]);
    expect(ELECTERM_LOCALE_KEY_COUNT).toBe(410);
    const englishKeys = Object.keys(APP_LOCALES.find(({ id }) => id === 'en')!.messages);
    for (const locale of APP_LOCALES) {
      expect(Object.keys(locale.messages)).toEqual(englishKeys);
      for (const key of englishKeys) expect(translateElecterm(locale.id, key)).not.toBe('');
    }
  });

  it('normalizes browser languages and exposes the correct document direction', () => {
    expect(normalizeAppLanguage('zh_HK')).toBe('zh-TW');
    expect(normalizeAppLanguage('zh-SG')).toBe('zh-CN');
    expect(normalizeAppLanguage('pt-PT')).toBe('pt-BR');
    expect(normalizeAppLanguage('ja-JP')).toBe('ja');
    expect(normalizeAppLanguage('unknown')).toBeUndefined();
    expect(resolveAppLanguage(['unknown', 'de-DE'])).toBe('de');
    expect(resolveAppLanguage([])).toBe('en');
    expect(languageDirection('ar')).toBe('rtl');
    expect(languageDirection('zh-CN')).toBe('ltr');
  });

  it('uses English for missing Axterm text and interpolates as inert text', () => {
    expect(translateElecterm('ja', 'settings')).toBe('設定');
    expect(translateAxterm('ja', 'language.description')).toBe(
      'Choose the application language. Changes apply immediately and persist.',
    );
    expect(
      translateElecterm('en', 'missing-message', 'Hello {name}', {
        name: '<img src=x onerror=alert(1)>',
      }),
    ).toBe('Hello <img src=x onerror=alert(1)>');
  });
});
