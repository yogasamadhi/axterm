import { z } from 'zod';
const idSchema = z.uuid();
export const DEFAULT_TERMINAL_THEME_ID = '00000000-0000-4000-8000-000000000001';

export const terminalBackgroundSchema = z
  .object({
    kind: z.enum(['none', 'text', 'image']),
    assetId: idSchema.nullable(),
    text: z.string().max(240),
    textSize: z.number().int().min(12).max(240),
    textColor: z.string().regex(/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i),
    textFontFamily: z.string().trim().min(1).max(256),
    opacity: z.number().min(0).max(1),
    blur: z.number().min(0).max(50),
    brightness: z.number().min(0).max(10),
    grayscale: z.number().min(0).max(1),
    contrast: z.number().min(0).max(10),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'image' && !value.assetId)
      context.addIssue({ code: 'custom', path: ['assetId'], message: 'Image asset is required' });
    if (value.kind !== 'image' && value.assetId)
      context.addIssue({
        code: 'custom',
        path: ['assetId'],
        message: 'Only image backgrounds may reference an asset',
      });
    if (value.kind === 'text' && !value.text.trim())
      context.addIssue({ code: 'custom', path: ['text'], message: 'Background text is required' });
  });

export const DEFAULT_TERMINAL_BACKGROUND = {
  kind: 'none',
  assetId: null,
  text: '',
  textSize: 48,
  textColor: '#ffffff',
  textFontFamily: 'Maple Mono',
  opacity: 1,
  blur: 0,
  brightness: 1,
  grayscale: 0,
  contrast: 1,
} as const;

export const terminalVisualSettingsSchema = z
  .object({
    themeId: idSchema.default(DEFAULT_TERMINAL_THEME_ID),
    background: terminalBackgroundSchema.default(DEFAULT_TERMINAL_BACKGROUND),
  })
  .strict();

export type TerminalBackground = z.infer<typeof terminalBackgroundSchema>;
export type TerminalVisualSettings = z.infer<typeof terminalVisualSettingsSchema>;
