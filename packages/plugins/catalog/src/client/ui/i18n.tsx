import { createContext, useContext, type ReactNode } from 'react';
import type { TranslateNS } from '@axterm/ui';
const Translation = createContext<TranslateNS<'catalog'> | undefined>(undefined);
export function CatalogI18n({
  translate,
  children,
}: {
  translate: TranslateNS<'catalog'>;
  children: ReactNode;
}) {
  return <Translation.Provider value={translate}>{children}</Translation.Provider>;
}
export function useI18n() {
  const x = useContext(Translation);
  if (!x) throw new Error('CATALOG_LOCALE_UNAVAILABLE');
  return { x };
}
