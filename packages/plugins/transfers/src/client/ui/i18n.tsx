import { createContext, useContext, type ReactNode } from 'react';
import type { TransfersTranslator } from './locales.ts';
const Translation = createContext<TransfersTranslator | undefined>(undefined);
export function TransfersI18n({ x, children }: { x: TransfersTranslator; children: ReactNode }) {
  return <Translation.Provider value={x}>{children}</Translation.Provider>;
}
export function useI18n() {
  const x = useContext(Translation);
  if (!x) throw Error('TRANSFERS_LOCALE_UNAVAILABLE');
  return { x };
}
