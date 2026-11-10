// First-party adaptation of frozen Axterm shortcut normalization; DSH continues to own physical arbitration.
import type { ShortcutBinding, ShortcutPlatform } from './binding.ts';
export type LegacyShortcut =
  | { readonly kind: 'keyboard'; readonly binding: ShortcutBinding }
  | {
      readonly kind: 'wheel';
      readonly direction: 'up' | 'down';
      readonly modifiers: readonly ('control' | 'alt' | 'shift' | 'meta')[];
    };
const names: Readonly<Record<string, string>> = {
  tab: 'Tab',
  enter: 'Enter',
  insert: 'Insert',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  backquote: 'Backquote',
  minus: 'Minus',
  equal: 'Equal',
  slash: 'Slash',
};
/** Bounded legacy metadata conversion, without event listeners, persistence or execution. */
export function parseLegacyShortcut(
  value: string,
  platform: ShortcutPlatform,
): LegacyShortcut | undefined {
  if (value.length > 80) return;
  const aliases: Readonly<Record<string, string>> = {
    command: 'meta',
    cmd: 'meta',
    commandorcontrol: platform === 'macos' ? 'meta' : 'ctrl',
    cmdorctrl: platform === 'macos' ? 'meta' : 'ctrl',
    control: 'ctrl',
    option: 'alt',
    '=': 'equal',
    '-': 'minus',
    '/': 'slash',
    '↑': 'arrowup',
    '↓': 'arrowdown',
    '▲': 'wheelup',
    '▼': 'wheeldown',
  };
  const parts = value
      .trim()
      .toLowerCase()
      .replaceAll(' ', '')
      .split('+')
      .filter(Boolean)
      .map((part) => aliases[part] ?? part),
    key = parts.pop();
  if (
    !key ||
    !parts.length ||
    parts.some((part) => !['ctrl', 'alt', 'shift', 'meta'].includes(part))
  )
    return;
  const set = new Set(parts),
    modifiers = (['ctrl', 'alt', 'shift', 'meta'] as const)
      .filter((value) => set.has(value))
      .map((value) => (value === 'ctrl' ? ('control' as const) : value));
  if (key === 'wheelup' || key === 'wheeldown')
    return { kind: 'wheel', direction: key === 'wheelup' ? 'up' : 'down', modifiers };
  const code =
    names[key] ??
    (/^[a-z]$/u.test(key)
      ? 'Key' + key.toUpperCase()
      : /^[0-9]$/u.test(key)
        ? 'Digit' + key
        : /^f(?:[1-9]|1[0-2])$/u.test(key)
          ? key.toUpperCase()
          : undefined);
  return code ? { kind: 'keyboard', binding: { code, modifiers } } : undefined;
}
