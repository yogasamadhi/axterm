import {
  DEFAULT_TERMINAL_THEME_ID,
  LIGHT_TERMINAL_THEME_ID,
  terminalThemeInputSchema,
  terminalThemePatchSchema,
  terminalThemeSchema,
  type TerminalTheme,
  type TerminalThemeInput,
  type TerminalThemePatch,
} from '@workspace/contracts';
import type { TerminalThemeRepository } from '../adapters/sqlite/terminal-theme-repository';
import { AXTERM_TERMINAL_THEMES } from '@workspace/shared';
import { ApplicationError } from './errors';

export const DARK_TERMINAL_THEME_ID = DEFAULT_TERMINAL_THEME_ID;
export { LIGHT_TERMINAL_THEME_ID };

const builtInTimestamp = '2026-01-01T00:00:00.000Z';
const builtInIds = [
  DARK_TERMINAL_THEME_ID,
  LIGHT_TERMINAL_THEME_ID,
  '00000000-0000-4000-8000-000000001001',
  '00000000-0000-4000-8000-000000001002',
] as const;
const builtIns: readonly TerminalTheme[] = AXTERM_TERMINAL_THEMES.map((theme, index) =>
  terminalThemeSchema.parse({
    id: builtInIds[index],
    ...terminalThemeInputSchema.parse(theme),
    builtIn: true,
    createdAt: builtInTimestamp,
    updatedAt: builtInTimestamp,
    version: 1,
  }),
);

export class TerminalThemeService {
  constructor(private readonly repository: TerminalThemeRepository) {}

  list(): TerminalTheme[] {
    return [...builtIns, ...this.repository.list()];
  }

  create(input: TerminalThemeInput): TerminalTheme {
    return this.repository.create(terminalThemeInputSchema.parse(input));
  }

  clone(id: string, name?: string): TerminalTheme {
    const source = this.requireTheme(id);
    return this.repository.create(
      terminalThemeInputSchema.parse({
        name: name?.trim() || `${source.name} copy`.slice(0, 30),
        terminal: { ...source.terminal },
        ui: { ...source.ui },
      }),
    );
  }

  update(id: string, input: TerminalThemePatch, ifMatch: string | undefined): TerminalTheme {
    if (builtIns.some((theme) => theme.id === id))
      throw new ApplicationError('INVALID_STATE', 'Built-in themes cannot be edited', 409);
    if (!Object.keys(input).length)
      throw new ApplicationError('INVALID_STATE', 'Terminal theme update is empty', 409);
    return this.repository.update(id, terminalThemePatchSchema.parse(input), ifMatch);
  }

  delete(id: string, ifMatch: string | undefined): void {
    if (builtIns.some((theme) => theme.id === id))
      throw new ApplicationError('INVALID_STATE', 'Built-in themes cannot be deleted', 409);
    this.repository.delete(id, ifMatch);
  }

  replacePortable(values: readonly TerminalTheme[]): TerminalTheme[] {
    if (values.length > 256)
      throw new ApplicationError(
        'PAYLOAD_TOO_LARGE',
        'At most 256 terminal themes may be synced',
        413,
      );
    const themes = values.map((value) => terminalThemeSchema.parse(value));
    if (themes.some(({ builtIn }) => builtIn))
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'Built-in terminal themes cannot be replaced',
        400,
      );
    if (new Set(themes.map(({ id }) => id)).size !== themes.length)
      throw new ApplicationError('VALIDATION_ERROR', 'Terminal theme IDs must be unique', 400);
    this.repository.replacePortable(themes);
    return this.list();
  }

  private requireTheme(id: string): TerminalTheme {
    const builtIn = builtIns.find((theme) => theme.id === id);
    return builtIn ?? this.repository.get(id);
  }
}
