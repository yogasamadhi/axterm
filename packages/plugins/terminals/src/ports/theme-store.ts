import type {
  TerminalTheme,
  TerminalThemeInput,
  TerminalThemePatch,
} from '@axterm/plugin-api/terminals';
export interface TerminalThemeStore {
  list(): TerminalTheme[];
  get(id: string): TerminalTheme;
  create(input: TerminalThemeInput): TerminalTheme;
  update(id: string, input: TerminalThemePatch, ifMatch: string | undefined): TerminalTheme;
  delete(id: string, ifMatch: string | undefined): void;
  replacePortable(values: readonly TerminalTheme[]): void;
}
