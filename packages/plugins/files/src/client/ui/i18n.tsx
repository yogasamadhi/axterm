import { createContext, useContext, type ReactNode } from 'react';
import type { FilesTranslator } from './locales.ts';
const Translation = createContext<{ x: FilesTranslator; language: string } | undefined>(undefined);
export function FilesI18n({
  value,
  children,
}: {
  value: { x: FilesTranslator; language: string };
  children: ReactNode;
}) {
  return <Translation.Provider value={value}>{children}</Translation.Provider>;
}
export function useI18n() {
  const value = useContext(Translation);
  if (!value) throw Error('FILES_LOCALE_UNAVAILABLE');
  return value;
}
