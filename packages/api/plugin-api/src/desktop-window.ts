import { z } from 'zod';
export const desktopWindowBoundsSchema = z
  .object({
    x: z.number().int().min(-100_000).max(100_000),
    y: z.number().int().min(-100_000).max(100_000),
    width: z.number().int().min(320).max(32768),
    height: z.number().int().min(240).max(32768),
  })
  .strict();
export const desktopWindowPreferencesSchema = z
  .object({
    titleBarStyle: z.enum(['custom', 'system']),
    opacity: z.number().min(0).max(1),
    zoomFactor: z.number().min(0.5).max(8),
    bounds: desktopWindowBoundsSchema.nullable(),
    rememberWindowSize: z.boolean(),
    globalHotkey: z.string().trim().max(80),
    allowMultiInstance: z.boolean(),
    confirmBeforeExit: z.boolean(),
  })
  .strict();
export const desktopWindowPreferencesPatchSchema = desktopWindowPreferencesSchema
  .partial()
  .refine(
    (value) => Object.values(value).some((entry) => entry !== undefined),
    'Expected a window preference',
  );
export const desktopWindowPreferenceRecordSchema = z
  .object({
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    preferences: desktopWindowPreferencesSchema,
  })
  .strict();
export const nativeDesktopWindowStateSchema = z
  .object({
    appliedVersion: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
    globalHotkeyRegistered: z.boolean(),
    requiresRestart: z.boolean(),
    bounds: desktopWindowBoundsSchema.nullable(),
  })
  .strict();
export type DesktopWindowBounds = z.infer<typeof desktopWindowBoundsSchema>;
export type DesktopWindowPreferences = z.infer<typeof desktopWindowPreferencesSchema>;
export type DesktopWindowPreferencesPatch = z.infer<typeof desktopWindowPreferencesPatchSchema>;
export type DesktopWindowPreferenceRecord = z.infer<typeof desktopWindowPreferenceRecordSchema>;
export type NativeDesktopWindowState = z.infer<typeof nativeDesktopWindowStateSchema>;
export const DEFAULT_DESKTOP_WINDOW_PREFERENCES: Readonly<DesktopWindowPreferences> = Object.freeze(
  {
    titleBarStyle: 'custom',
    opacity: 1,
    zoomFactor: 1,
    bounds: null,
    rememberWindowSize: false,
    globalHotkey: 'Control+2',
    allowMultiInstance: false,
    confirmBeforeExit: false,
  },
);
export interface NativeDesktopWindows {
  configure(
    record: DesktopWindowPreferenceRecord,
    signal: AbortSignal,
    applyBounds?: boolean,
  ): Promise<NativeDesktopWindowState>;
  state(signal: AbortSignal): Promise<NativeDesktopWindowState>;
}
export interface DesktopWindowStateData {
  readonly generation: string;
  readonly cursor: number;
  readonly record: DesktopWindowPreferenceRecord;
  readonly native: NativeDesktopWindowState | null;
  readonly application: 'ready' | 'pending' | 'failed' | 'unavailable';
}
export interface DesktopWindowBaseline extends DesktopWindowStateData {
  readonly type: 'baseline';
}
export interface DesktopWindowReplacement extends DesktopWindowStateData {
  readonly type: 'replace';
}
export type DesktopWindowUpdate = DesktopWindowBaseline | DesktopWindowReplacement;
export interface DesktopWindowReceipt {
  readonly version: number;
  readonly cursor: number;
}
