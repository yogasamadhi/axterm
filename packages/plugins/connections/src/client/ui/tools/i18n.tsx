import { createContext, useContext, type ReactNode } from 'react';
import type { ToolsTranslator } from './locales.ts';
const Translation = createContext<{ x: ToolsTranslator; language: string } | undefined>(undefined);
export function ToolsI18n({
  value,
  children,
}: {
  value: { x: ToolsTranslator; language: string };
  children: ReactNode;
}) {
  return <Translation.Provider value={value}>{children}</Translation.Provider>;
}
export function useI18n() {
  const value = useContext(Translation);
  if (!value) throw Error('CONNECTION_TOOLS_LOCALE_UNAVAILABLE');
  return value;
}
