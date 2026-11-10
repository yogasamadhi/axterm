import type { ShortcutCommand, ShortcutMessageKey } from '@axterm/ui/shortcuts';
import { dictionaries } from './locales.ts';
/** Only explicit shared keys gain aliases; labels are never reverse-matched or persisted. */
export function localizedShortcut(command: ShortcutCommand): ShortcutCommand {
  if (!command.messageKey) return command;
  return {
    ...command,
    aliases: [...new Set([...command.aliases, ...shortcutAliases(command.messageKey)])],
  };
}

export function shortcutAliases(key: ShortcutMessageKey): readonly string[] {
  return [
    ...new Set(
      Object.values(dictionaries)
        .map((dictionary) => (dictionary as Readonly<Record<string, string>>)[key])
        .filter((value): value is string => typeof value === 'string'),
    ),
  ];
}
