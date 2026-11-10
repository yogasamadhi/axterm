import { createContext, useContext } from 'react';
import type dictionaries from './widget-locales.json';
export type WidgetTranslate = (
  key: keyof typeof dictionaries.en,
  values?: Record<string, unknown>,
) => string;
export const WidgetTranslation = createContext<WidgetTranslate | undefined>(undefined);
export function useI18n() {
  const x = useContext(WidgetTranslation);
  if (!x) throw Error('WIDGET_TRANSLATION_UNAVAILABLE');
  return { x };
}
