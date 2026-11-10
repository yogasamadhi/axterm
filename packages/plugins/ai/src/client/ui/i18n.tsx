import { createContext, useContext, type ReactNode } from 'react';
import type { dictionaries } from './locales.ts';
export type AxtermMessageKey = keyof typeof dictionaries.en;
export type AiTranslator = (
  key: AxtermMessageKey,
  variables?: Readonly<Record<string, string | number>>,
) => string;
interface AiI18n {
  readonly language: string;
  readonly x: AiTranslator;
}
const Context = createContext<AiI18n | undefined>(undefined);
/** This is a feature-local view of the renderer-owned locale service, without another locale store. */
export function AiI18nProvider({ value, children }: { value: AiI18n; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useI18n(): AiI18n {
  const value = useContext(Context);
  if (!value) throw new Error('AI_LOCALE_UNAVAILABLE');
  return value;
}
