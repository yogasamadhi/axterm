import { createContext, useContext } from 'react';
import type { AppLanguage } from '@workspace/contracts';
import type { AxtermMessageKey, LocaleDefinition, Variables } from './core';

export interface I18nValue {
  language: AppLanguage;
  direction: 'ltr' | 'rtl';
  locales: readonly LocaleDefinition[];
  t(key: string, fallback?: string, variables?: Variables): string;
  x(key: AxtermMessageKey, variables?: Variables): string;
}

export const I18nContext = createContext<I18nValue | undefined>(undefined);

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}
