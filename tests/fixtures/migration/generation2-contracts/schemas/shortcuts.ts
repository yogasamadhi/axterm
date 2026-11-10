import { z } from 'zod';

export const SHORTCUT_ACTION_IDS = [
  'app_closeCurrentTab',
  'app_mouseWheelDownCloseTab',
  'app_reloadCurrentTab',
  'app_reloadAll',
  'app_cloneToNextLayout',
  'app_duplicateTab',
  'app_newBookmark',
  'app_newTab',
  'app_toggleAddBtn',
  'app_togglefullscreen',
  'app_zoomin',
  'app_zoomout',
  'app_prevTab',
  'app_nextTab',
  'terminal_clear',
  'terminal_copy',
  'terminal_paste',
  'terminal_search',
  'terminal_pasteSelected',
  'terminal_showNormalBuffer',
  'terminal_zoominTerminal',
  'terminal_zoomoutTerminal',
  'terminal_syncSftpPath',
] as const;

export const shortcutActionIdSchema = z.enum(SHORTCUT_ACTION_IDS);
export const shortcutChordSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(80)
  .regex(
    /^(?:(?:ctrl|meta|alt|shift)\+){1,4}(?:[a-z0-9]|f(?:[1-9]|1[0-2])|tab|enter|insert|arrow(?:up|down|left|right)|backquote|minus|equal|slash|wheel(?:up|down))$/u,
    'Expected a canonical shortcut with a modifier',
  )
  .refine((value) => {
    const parts = value.split('+').slice(0, -1);
    return new Set(parts).size === parts.length;
  }, 'Shortcut modifiers must be unique');
const shortcutChordListSchema = z
  .array(shortcutChordSchema)
  .max(2)
  .refine((values) => new Set(values).size === values.length, 'Shortcut bindings must be unique');
export const shortcutBindingsSchema = z
  .partialRecord(shortcutActionIdSchema, shortcutChordListSchema)
  .superRefine((bindings, context) => {
    const owners = new Map<string, string>();
    for (const [actionId, chords] of Object.entries(bindings)) {
      for (const chord of chords ?? []) {
        const owner = owners.get(chord);
        if (owner)
          context.addIssue({
            code: 'custom',
            path: [actionId],
            message: `Shortcut is already assigned to ${owner}`,
          });
        else owners.set(chord, actionId);
      }
    }
  });
export const shortcutSettingsSchema = z
  .object({ bindings: shortcutBindingsSchema.default({}) })
  .strict()
  .default({ bindings: {} });

export type ShortcutActionId = z.infer<typeof shortcutActionIdSchema>;
export type ShortcutChord = z.infer<typeof shortcutChordSchema>;
export type ShortcutBindings = z.infer<typeof shortcutBindingsSchema>;
export type ShortcutSettings = z.infer<typeof shortcutSettingsSchema>;
