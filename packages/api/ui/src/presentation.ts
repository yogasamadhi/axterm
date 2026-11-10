// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Selected locale/theme interfaces adapted from packages/client/{locale,ui-theme}/src/client/index.ts
// at 8bd073392eef6f54e921a093b95076248eb08cbb; Axterm owns the accepted preference port.
import type { LocaleDictOf, LocaleNamespaceMap, Translate, TranslateNS } from './index.ts';
import type { ObservableSnapshot } from '@axterm/plugin-api';

export type { PresentationPreferencePort } from './preference.ts';
import type { PresentationPreferencePort } from './preference.ts';
export const BUILT_IN_LOCALES = ['en', 'ja', 'zh-CN', 'zh-TW'] as const;
export type BuiltInLocaleId = (typeof BUILT_IN_LOCALES)[number];
export type LocaleId = string;
export type LocalizedText = string | Readonly<{ en: string } & Record<string, string>>;
export type LocaleDict = Readonly<Record<string, string>>;
export interface LanguageRegistration {
  readonly id: LocaleId;
  readonly label: string;
  readonly fallback: LocaleId;
}
export interface LocaleDefinition {
  readonly id: LocaleId;
  readonly label: string;
  readonly fallback?: LocaleId;
}
export interface LocaleSnapshot {
  readonly active: LocaleId;
  readonly locales: readonly LocaleDefinition[];
  readonly revision: number;
}
export interface LocaleService extends ObservableSnapshot<LocaleSnapshot> {
  getLocale(): LocaleSnapshot;
  resolveText(text: LocalizedText): string;
  setLocale(id: string): Promise<void>;
  addLanguage(input: LanguageRegistration): () => void;
  register<N extends Extract<keyof LocaleNamespaceMap, string>>(
    namespace: N,
    dictionaries: Record<BuiltInLocaleId, LocaleDictOf<N>> & Record<string, LocaleDict>,
  ): () => void;
  register(namespace: string, locale: string, dictionary: LocaleDict): () => void;
  bind<N extends Extract<keyof LocaleNamespaceMap, string>>(namespace: N): TranslateNS<N>;
  bind(namespace: string): Translate;
  attachPreference(port: PresentationPreferencePort<string>): () => Promise<void>;
}
export type ThemePreference = 'dark' | 'light' | 'system';
export interface ThemeDefinition {
  readonly id: string;
  readonly colorScheme: 'dark' | 'light';
  readonly tokens: Readonly<Record<string, string>>;
}
export interface ThemeTokenModes {
  readonly light: string;
  readonly dark: string;
}
export type ThemeTokenOverrides = Readonly<Record<string, ThemeTokenModes>>;
export interface ThemeSnapshot {
  readonly preference: string;
  readonly active: ThemeDefinition;
  readonly themes: readonly ThemeDefinition[];
  readonly revision: number;
}
export interface ThemeService extends ObservableSnapshot<ThemeSnapshot> {
  getTheme(): ThemeSnapshot;
  setTheme(id: string): Promise<void>;
  register(definition: ThemeDefinition): () => void;
  overrideTokens(source: string, tokens: ThemeTokenOverrides): () => void;
  attachPreference(port: PresentationPreferencePort<string>): () => Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    locale: LocaleService;
    theme: ThemeService;
  }
  interface Events {
    'locale/change'(snapshot: LocaleSnapshot): void;
    'theme/change'(snapshot: ThemeSnapshot): void;
  }
}
