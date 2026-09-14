import {
  terminalThemeSchema,
  type TerminalTheme,
  type TerminalThemeInput,
  type TerminalThemePatch,
} from '@workspace/contracts';
import type { ProductRepository } from './product-repository';

type StoredThemeInput = TerminalThemeInput & { builtIn: false };

export class TerminalThemeRepository {
  constructor(private readonly products: ProductRepository) {}

  list(): TerminalTheme[] {
    return this.products
      .listJson<unknown>('terminal_themes')
      .map((theme) => terminalThemeSchema.parse(theme));
  }

  get(id: string): TerminalTheme {
    return terminalThemeSchema.parse(this.products.getJson<unknown>('terminal_themes', id));
  }

  create(input: TerminalThemeInput): TerminalTheme {
    return terminalThemeSchema.parse(
      this.products.createJson<StoredThemeInput>(
        'terminal_themes',
        { ...input, builtIn: false },
        'terminal-theme',
      ),
    );
  }

  update(id: string, input: TerminalThemePatch, ifMatch: string | undefined): TerminalTheme {
    return terminalThemeSchema.parse(
      this.products.updateJson<StoredThemeInput>(
        'terminal_themes',
        id,
        input,
        ifMatch,
        'terminal-theme',
      ),
    );
  }

  delete(id: string, ifMatch: string | undefined): void {
    this.products.deleteJson('terminal_themes', id, ifMatch, 'terminal-theme');
  }

  replacePortable(themes: readonly TerminalTheme[]): void {
    this.products.replaceJsonCollection('terminal_themes', themes, 'terminal-theme-list');
  }
}
