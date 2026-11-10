import { createContext, useContext, type ReactNode } from 'react';
import type { ProtocolTranslator } from './locales.ts';
const Translation = createContext<ProtocolTranslator | undefined>(undefined);
export function ProtocolI18n({
  translate,
  children,
}: {
  translate: ProtocolTranslator;
  children: ReactNode;
}) {
  return <Translation.Provider value={translate}>{children}</Translation.Provider>;
}
export function useI18n() {
  const x = useContext(Translation);
  if (!x) throw Error('REMOTE_DESKTOP_LOCALE_UNAVAILABLE');
  return { x };
}
