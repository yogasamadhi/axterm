import { z } from 'zod';
import { entityFields, idSchema, timestampSchema } from './resources';

const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i, 'Expected a three or six digit hex color');

const rgbaColorSchema = z.string().refine((value) => {
  const match =
    /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|0?\.\d+|1(?:\.0+)?)\s*\)$/i.exec(
      value,
    );
  if (!match) return false;
  return match.slice(1, 4).every((part) => Number(part) <= 255) && Number(match[4]) <= 1;
}, 'Expected a valid rgba color');

export const terminalThemeColorSchema = z.union([hexColorSchema, rgbaColorSchema]);

export const terminalThemePaletteSchema = z
  .object({
    foreground: terminalThemeColorSchema,
    background: terminalThemeColorSchema,
    cursor: terminalThemeColorSchema,
    cursorAccent: terminalThemeColorSchema,
    selectionBackground: terminalThemeColorSchema,
    black: terminalThemeColorSchema,
    red: terminalThemeColorSchema,
    green: terminalThemeColorSchema,
    yellow: terminalThemeColorSchema,
    blue: terminalThemeColorSchema,
    magenta: terminalThemeColorSchema,
    cyan: terminalThemeColorSchema,
    white: terminalThemeColorSchema,
    brightBlack: terminalThemeColorSchema,
    brightRed: terminalThemeColorSchema,
    brightGreen: terminalThemeColorSchema,
    brightYellow: terminalThemeColorSchema,
    brightBlue: terminalThemeColorSchema,
    brightMagenta: terminalThemeColorSchema,
    brightCyan: terminalThemeColorSchema,
    brightWhite: terminalThemeColorSchema,
  })
  .strict();

export const uiThemePaletteSchema = z
  .object({
    main: hexColorSchema,
    'main-dark': hexColorSchema,
    'main-light': hexColorSchema,
    text: hexColorSchema,
    'text-light': hexColorSchema,
    'text-dark': hexColorSchema,
    'text-disabled': hexColorSchema,
    primary: hexColorSchema,
    info: hexColorSchema,
    success: hexColorSchema,
    error: hexColorSchema,
    warn: hexColorSchema,
  })
  .strict();

export const terminalThemeInputSchema = z
  .object({
    name: z.string().trim().min(1).max(30),
    terminal: terminalThemePaletteSchema,
    ui: uiThemePaletteSchema,
  })
  .strict();

export const aiTerminalThemeDraftSchema = terminalThemeInputSchema.superRefine((theme, context) => {
  if (colorContrast(theme.terminal.foreground, theme.terminal.background) < 4.5)
    context.addIssue({
      code: 'custom',
      path: ['terminal', 'foreground'],
      message: 'Terminal foreground and background contrast must be at least 4.5:1',
    });
  if (colorContrast(theme.ui.text, theme.ui.main) < 4.5)
    context.addIssue({
      code: 'custom',
      path: ['ui', 'text'],
      message: 'Interface text and main background contrast must be at least 4.5:1',
    });
});

export const terminalThemePatchSchema = terminalThemeInputSchema.partial().strict();

export const terminalThemeSchema = z
  .object({
    ...entityFields,
    ...terminalThemeInputSchema.shape,
    builtIn: z.boolean(),
  })
  .strict();

export const cloneTerminalThemeSchema = z
  .object({ name: terminalThemeInputSchema.shape.name.optional() })
  .strict();
export const terminalThemeGrantRequestSchema = z.object({ grantId: z.string().min(1) }).strict();
export const terminalThemeExportResultSchema = z
  .object({
    themeId: idSchema,
    bytes: z.number().int().nonnegative(),
    createdAt: timestampSchema,
  })
  .strict();
export const terminalBackgroundAssetSchema = z
  .object({
    id: idSchema,
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    bytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
  })
  .strict();

export type TerminalTheme = z.infer<typeof terminalThemeSchema>;
export type TerminalThemeInput = z.input<typeof terminalThemeInputSchema>;
export type TerminalThemePatch = z.input<typeof terminalThemePatchSchema>;

function colorContrast(foreground: string, background: string): number {
  const backgroundChannels = composite(parseColor(background), [0, 0, 0]);
  const foregroundChannels = composite(parseColor(foreground), backgroundChannels);
  const foregroundLuminance = luminance(foregroundChannels);
  const backgroundLuminance = luminance(backgroundChannels);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

function parseColor(value: string): [number, number, number, number] {
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    const expanded =
      hex.length === 3
        ? hex
            .split('')
            .map((part) => part.repeat(2))
            .join('')
        : hex;
    return [
      Number.parseInt(expanded.slice(0, 2), 16),
      Number.parseInt(expanded.slice(2, 4), 16),
      Number.parseInt(expanded.slice(4, 6), 16),
      1,
    ];
  }
  const match = value.match(
    /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|0?\.\d+|1(?:\.0+)?)\s*\)$/iu,
  );
  if (!match) return [0, 0, 0, 1];
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
}

function composite(
  [red, green, blue, alpha]: [number, number, number, number],
  background: [number, number, number],
): [number, number, number] {
  return [
    red * alpha + background[0] * (1 - alpha),
    green * alpha + background[1] * (1 - alpha),
    blue * alpha + background[2] * (1 - alpha),
  ];
}

function luminance(channels: [number, number, number]): number {
  const [red, green, blue] = channels.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return red! * 0.2126 + green! * 0.7152 + blue! * 0.0722;
}
