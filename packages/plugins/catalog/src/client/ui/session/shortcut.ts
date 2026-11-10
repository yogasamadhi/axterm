import type { ShortcutSettings } from '@axterm/plugin-api/configuration';
export function matchesSessionShortcut(
  event: Pick<KeyboardEvent, 'code' | 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>,
  action: 'app_toggleAddBtn' | 'app_newBookmark',
  settings: ShortcutSettings,
  mac: boolean,
): boolean {
  const bindings =
    settings.bindings[action] ??
    (action === 'app_toggleAddBtn' ? ['alt+n'] : [mac ? 'meta+n' : 'ctrl+n']);
  const key = /^Key[A-Z]$/.test(event.code)
    ? event.code.slice(3).toLowerCase()
    : /^Digit[0-9]$/.test(event.code)
      ? event.code.slice(5)
      : ((
          { Backquote: 'backquote', Minus: 'minus', Equal: 'equal', Slash: 'slash' } as Record<
            string,
            string
          >
        )[event.code] ?? event.key.toLowerCase());
  const matches = (chord: string) => {
    const parts = chord.split('+'),
      expected = parts.pop();
    return (
      key === expected &&
      event.altKey === parts.includes('alt') &&
      event.ctrlKey === parts.includes('ctrl') &&
      event.metaKey === parts.includes('meta') &&
      event.shiftKey === parts.includes('shift')
    );
  };
  if (
    settings.bindings[action] === undefined &&
    Object.entries(settings.bindings).some(([id, chords]) => id !== action && chords?.some(matches))
  )
    return false;
  return bindings.some(matches);
}
