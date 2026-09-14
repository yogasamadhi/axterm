import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import {
  terminalThemeExportResultSchema,
  terminalThemeInputSchema,
  terminalThemePatchSchema,
  terminalThemeSchema,
  type TerminalTheme,
  type TerminalThemeInput,
  type TerminalThemePatch,
} from '@workspace/contracts';
import type { TerminalThemeRepository } from '../adapters/sqlite/terminal-theme-repository';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import { ELECTERM_TERMINAL_THEME_SOURCES } from './electerm-terminal-themes.generated';
import { ApplicationError } from './errors';

export const DARK_TERMINAL_THEME_ID = '00000000-0000-4000-8000-000000000001';
export const LIGHT_TERMINAL_THEME_ID = '00000000-0000-4000-8000-000000000002';

const darkTheme: TerminalThemeInput = {
  name: 'Default',
  ui: {
    main: '#121214',
    'main-dark': '#000000',
    'main-light': '#2E3338',
    text: '#dddddd',
    'text-light': '#ffffff',
    'text-dark': '#888888',
    'text-disabled': '#777777',
    primary: '#0088cc',
    info: '#FFD166',
    success: '#06D6A0',
    error: '#EF476F',
    warn: '#E55934',
  },
  terminal: {
    foreground: '#d6dde2',
    background: '#0b1114',
    cursor: '#78e39b',
    cursorAccent: '#0b1114',
    selectionBackground: 'rgba(88, 199, 217, 0.28)',
    black: '#1c252b',
    red: '#f07178',
    green: '#84d99c',
    yellow: '#e7c66b',
    blue: '#69a7e3',
    magenta: '#bd93d8',
    cyan: '#65c9d5',
    white: '#d8e0e5',
    brightBlack: '#66737b',
    brightRed: '#ff8b92',
    brightGreen: '#9beaaf',
    brightYellow: '#f4d980',
    brightBlue: '#82baf0',
    brightMagenta: '#d2a8ea',
    brightCyan: '#7edce5',
    brightWhite: '#f2f6f8',
  },
};

const lightTheme: TerminalThemeInput = {
  name: 'Default light',
  ui: {
    main: '#ededed',
    'main-dark': '#cccccc',
    'main-light': '#fefefe',
    text: '#555555',
    'text-light': '#777777',
    'text-dark': '#444444',
    'text-disabled': '#888888',
    primary: '#0088cc',
    info: '#FFD166',
    success: '#06D6A0',
    error: '#EF476F',
    warn: '#E55934',
  },
  terminal: {
    background: '#121214',
    foreground: '#af9a91',
    cursor: '#af9a91',
    selectionBackground: '#575256',
    cursorAccent: '#121214',
    black: '#572100',
    red: '#ba3934',
    green: '#91773f',
    yellow: '#b55600',
    blue: '#5f63b4',
    magenta: '#a17c7b',
    cyan: '#8faea9',
    white: '#af9a91',
    brightBlack: '#4e4b61',
    brightRed: '#d9443f',
    brightGreen: '#d6b04e',
    brightYellow: '#f66813',
    brightBlue: '#8086ef',
    brightMagenta: '#e2c2bb',
    brightCyan: '#a4dce7',
    brightWhite: '#d2c7a9',
  },
};

const builtInTimestamp = '2026-01-01T00:00:00.000Z';
const nativeBuiltIns: TerminalTheme[] = [
  terminalThemeSchema.parse({
    id: DARK_TERMINAL_THEME_ID,
    ...darkTheme,
    builtIn: true,
    createdAt: builtInTimestamp,
    updatedAt: builtInTimestamp,
    version: 1,
  }),
  terminalThemeSchema.parse({
    id: LIGHT_TERMINAL_THEME_ID,
    ...lightTheme,
    builtIn: true,
    createdAt: builtInTimestamp,
    updatedAt: builtInTimestamp,
    version: 1,
  }),
] as const;

const uiKeys = Object.keys(darkTheme.ui) as Array<keyof TerminalThemeInput['ui']>;
const terminalKeys = Object.keys(darkTheme.terminal) as Array<keyof TerminalThemeInput['terminal']>;

const electermBuiltIns: TerminalTheme[] = ELECTERM_TERMINAL_THEME_SOURCES.map((source, index) =>
  terminalThemeSchema.parse({
    id: `00000000-0000-4000-8000-${String(index + 3).padStart(12, '0')}`,
    ...parseElectermTheme(source),
    builtIn: true,
    createdAt: builtInTimestamp,
    updatedAt: builtInTimestamp,
    version: 1,
  }),
);

const builtIns: readonly TerminalTheme[] = [...nativeBuiltIns, ...electermBuiltIns];

export class TerminalThemeService {
  constructor(
    private readonly repository: TerminalThemeRepository,
    private readonly host: HostCapabilityClient | undefined,
  ) {}

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

  async import(grantId: string): Promise<TerminalTheme> {
    const host = this.requireHost();
    const file = await host.readGrantedText(grantId);
    if (Buffer.byteLength(file.content, 'utf8') > 64 * 1024)
      throw new ApplicationError('PAYLOAD_TOO_LARGE', 'Theme file exceeds 64 KiB', 413);
    return this.repository.create(parseElectermTheme(file.content, file.name));
  }

  async export(id: string, grantId: string) {
    const host = this.requireHost();
    const theme = this.requireTheme(id);
    const grant = await host.resolveGrant(grantId);
    if (grant.kind !== 'save-target' || !grant.permissions.includes('write'))
      throw new ApplicationError('INVALID_STATE', 'A writable save grant is required', 409);
    const output = serializeElectermTheme(theme);
    await writeAtomic(grant.path, output);
    return terminalThemeExportResultSchema.parse({
      themeId: theme.id,
      bytes: Buffer.byteLength(output, 'utf8'),
      createdAt: new Date().toISOString(),
    });
  }

  private requireTheme(id: string): TerminalTheme {
    const builtIn = builtIns.find((theme) => theme.id === id);
    return builtIn ?? this.repository.get(id);
  }

  private requireHost(): HostCapabilityClient {
    if (!this.host)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Theme file access is unavailable', 503);
    return this.host;
  }
}

export function parseElectermTheme(text: string, fileName = 'Imported theme'): TerminalThemeInput {
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new ApplicationError('VALIDATION_ERROR', 'Invalid theme line', 400);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!value) throw new ApplicationError('VALIDATION_ERROR', `Theme value is empty: ${key}`, 400);
    if (key.startsWith('terminal:selection')) values.set('terminal:selectionBackground', value);
    else values.set(key, value);
  }
  const allowed = new Set([
    'themeName',
    ...uiKeys,
    ...terminalKeys.map((key) => `terminal:${key}`),
  ]);
  for (const key of values.keys())
    if (!allowed.has(key))
      throw new ApplicationError('VALIDATION_ERROR', `Unsupported theme property: ${key}`, 400);
  const ui = Object.fromEntries(uiKeys.map((key) => [key, values.get(key)]));
  const terminal = Object.fromEntries(
    terminalKeys.map((key) => [key, values.get(`terminal:${key}`)]),
  );
  const fallbackName = fileName.replace(/\.[^.]+$/u, '').trim() || 'Imported theme';
  return terminalThemeInputSchema.parse({
    name: (values.get('themeName') || fallbackName).slice(0, 30),
    ui,
    terminal,
  });
}

export function serializeElectermTheme(theme: TerminalTheme): string {
  return (
    [
      `themeName=${theme.name}`,
      ...uiKeys.map((key) => `${key}=${theme.ui[key]}`),
      ...terminalKeys.map((key) => `terminal:${key}=${theme.terminal[key]}`),
    ].join('\n') + '\n'
  );
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
