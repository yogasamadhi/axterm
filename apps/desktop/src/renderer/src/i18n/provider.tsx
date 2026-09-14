import { useEffect, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type { AppLanguage } from '@workspace/contracts';
import {
  APP_LOCALES,
  languageDirection,
  normalizeAppLanguage,
  resolveAppLanguage,
  translateAxterm,
  translateElecterm,
} from './core';
import { I18nContext, type I18nValue } from './context';

export function I18nProvider({
  language,
  children,
}: {
  language: AppLanguage;
  children: ReactNode;
}) {
  const direction = languageDirection(language);
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = direction;
    document.documentElement.dataset.language = language;
  }, [direction, language]);
  const value = useMemo<I18nValue>(
    () => ({
      language,
      direction,
      locales: APP_LOCALES,
      t: (key, fallback, variables) => translateElecterm(language, key, fallback, variables),
      x: (key, variables) => translateAxterm(language, key, variables),
    }),
    [direction, language],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function RuntimeI18nProvider({
  client,
  children,
}: {
  client: ReturnType<typeof createRuntimeClient>;
  children: ReactNode;
}) {
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: client.settings,
    retry: 2,
  });
  const browserLanguages = typeof navigator === 'undefined' ? [] : navigator.languages;
  const language =
    normalizeAppLanguage(settings.data?.appearance.language) ??
    resolveAppLanguage(browserLanguages);
  return <I18nProvider language={language}>{children}</I18nProvider>;
}
