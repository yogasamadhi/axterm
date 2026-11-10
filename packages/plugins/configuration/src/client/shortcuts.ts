import { parseLegacyShortcut } from '@axterm/plugin-api/shortcuts';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/ui/shortcuts';
import type {
  ShortcutBinding,
  ShortcutDocument,
  ShortcutPlatform,
  ShortcutRuntime,
  ShortcutProfile,
} from '@axterm/plugin-api/shortcuts';
import type { ShortcutBindings } from '@axterm/plugin-api/configuration';
import type { SettingsModel } from './index.ts';
import { ShortcutDocumentCommands } from './shortcut-commands.ts';
/** Existing serialized product bindings stay unchanged until an explicit accepted DSH document is saved. */
export function legacyShortcutDocument(
  bindings: ShortcutBindings,
  _runtime: ShortcutRuntime,
  _platform: ShortcutPlatform,
): ShortcutDocument {
  const profiles: Partial<Record<ShortcutProfile, Record<string, ShortcutBinding | null>>> = {};
  for (const deviceRuntime of ['desktop', 'web'] as const)
    for (const devicePlatform of ['macos', 'windows', 'linux'] as const) {
      const overrides: Record<string, ShortcutBinding | null> = {};
      for (const [legacy, chords] of Object.entries(bindings)) {
        if (legacy === 'terminal_copy' || legacy === 'terminal_paste' || legacy.includes('Wheel'))
          continue;
        const id = legacy.replace('_', '.');
        for (let index = 0; index < 2; index++) {
          const target = index === 0 ? id : id + '.alternate',
            chord = chords?.[index];
          if (!chord) {
            overrides[target] = null;
            continue;
          }
          const parsed = parseLegacyShortcut(chord, devicePlatform);
          if (parsed?.kind === 'wheel') continue;
          if (!parsed) throw Error('SHORTCUT_LEGACY_KEY_UNSUPPORTED');
          overrides[target] = parsed.binding;
        }
      }

      profiles[`${deviceRuntime}:${devicePlatform}`] = overrides;
    }
  return { schemaVersion: 1, profiles };
}
export function installShortcutPreferences(ctx: Context, model: SettingsModel): void {
  ctx.inject(['shortcuts'], (owner) => {
    const commands = new ShortcutDocumentCommands(model);
    owner.effect(() => () => commands.close());
    owner.effect(() =>
      owner.shortcuts.attachPreference({
        getSnapshot: () => {
          const state = model.getSnapshot();
          if (state.status !== 'ready') return { available: false, raw: null };
          const shortcuts = state.baseline.settings.shortcuts;
          const document =
            shortcuts.document ??
            legacyShortcutDocument(
              shortcuts.bindings,
              owner.shortcuts.runtime,
              owner.shortcuts.platform,
            );
          return {
            available: true,
            generation: state.baseline.generation,
            raw:
              shortcuts.document === undefined && Object.keys(shortcuts.bindings).length === 0
                ? null
                : JSON.stringify(document),
          };
        },
        subscribe: model.subscribe,
        write: (raw, generation, edit) =>
          commands.writeRaw(raw, generation, edit?.type === 'reset-all'),
      }),
    );
  });
}
