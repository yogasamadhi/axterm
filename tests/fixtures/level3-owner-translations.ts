import { Context } from '@deepseek-ai/cordis';
import { afterEach } from 'vitest';
import { LocaleRuntime } from '../../packages/infra/locale/src/client/index.ts';
const cleanups = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const close of [...cleanups].reverse()) await close();
});
/** Test presentation only: every text comes from its actual owner's dictionary and Locale runtime. */
export function ownedTranslations(
  namespace: string,
  dictionaries: Readonly<Record<string, Readonly<Record<string, string>>>>,
) {
  const active = new Map<string, LocaleRuntime>();
  return (language: string, key: string, variables?: Record<string, unknown>): string => {
    let locale = active.get(language);
    if (!locale) {
      const ctx = new Context();
      locale = new LocaleRuntime(ctx, { languages: [language] });
      for (const [id, dictionary] of Object.entries(dictionaries))
        locale.register(namespace, id, dictionary);
      active.set(language, locale);
      const current = locale;
      const close = async () => {
        try {
          await current.dispose();
          await ctx.fiber.dispose();
        } finally {
          active.delete(language);
          cleanups.delete(close);
        }
      };
      cleanups.add(close);
    }
    return locale.bind(namespace)(key, variables);
  };
}
