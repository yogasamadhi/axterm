import {
  parseLegacyShortcut,
  normalizeBinding,
  overlappingBindings,
} from '@axterm/plugin-api/shortcuts';
import type {
  NormalizedBinding,
  ShortcutPlatform,
  ShortcutCommandId,
} from '@axterm/plugin-api/shortcuts';
import type { QuickCommand } from '@axterm/plugin-api/automation';
/** Frozen first matching metadata owner. No execution or cached business facts. */
export function quickCommandReference(
  binding: NormalizedBinding,
  commands: readonly Pick<QuickCommand, 'id' | 'name' | 'shortcut'>[],
  platform: ShortcutPlatform,
  label: (name: string) => string,
) {
  for (const command of commands) {
    if (!command.shortcut) continue;
    const parsed = parseLegacyShortcut(command.shortcut, platform);
    if (
      parsed?.kind === 'keyboard' &&
      overlappingBindings(normalizeBinding(parsed.binding, platform), binding)
    )
      return [
        { id: `quick-command.${command.id}` as ShortcutCommandId, label: label(command.name) },
      ];
  }
  return [];
}
