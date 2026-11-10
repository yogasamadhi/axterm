import { parseLegacyShortcut, type ShortcutPlatform } from '@axterm/plugin-api/shortcuts';
import type { ShortcutBindings } from '@axterm/plugin-api/configuration';
export const GESTURE_ACTIONS = ['terminal_zoominTerminal', 'terminal_zoomoutTerminal'] as const;
export type GestureAction = (typeof GESTURE_ACTIONS)[number];
export type WheelInput = Pick<WheelEvent, 'deltaY' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;
export function gestureDefaults(
  action: GestureAction,
  platform: ShortcutPlatform,
): readonly string[] {
  return [
    (platform === 'macos' ? 'meta' : 'ctrl') +
      (action === 'terminal_zoominTerminal' ? '+wheelup' : '+wheeldown'),
  ];
}
export function gestureChord(event: WheelInput): string | undefined {
  if (!event.deltaY || !Number.isFinite(event.deltaY)) return;
  const modifiers = (['ctrl', 'alt', 'shift', 'meta'] as const).filter(
    (value) =>
      ({ ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey })[
        value
      ],
  );
  return modifiers.length
    ? [...modifiers, event.deltaY < 0 ? 'wheelup' : 'wheeldown'].join('+')
    : undefined;
}
export function wheelAction(
  event: WheelInput,
  bindings: ShortcutBindings,
  platform: ShortcutPlatform,
): GestureAction | undefined {
  const chord = gestureChord(event);
  if (!chord) return;
  return GESTURE_ACTIONS.find((action) =>
    (bindings[action] ?? gestureDefaults(action, platform)).some((value) => {
      const parsed = parseLegacyShortcut(value, platform);
      return (
        parsed?.kind === 'wheel' &&
        [
          ...parsed.modifiers.map((value) => (value === 'control' ? 'ctrl' : value)),
          'wheel' + parsed.direction,
        ].join('+') === chord
      );
    }),
  );
}
/** Edit only wheel entries, preserving existing physical overrides and every other reviewed action. */
export function replaceGestureBindings(
  bindings: ShortcutBindings,
  action: GestureAction,
  wheels: readonly string[],
  platform: ShortcutPlatform,
): ShortcutBindings {
  if (
    wheels.length > 2 ||
    wheels.some((value) => parseLegacyShortcut(value, platform)?.kind !== 'wheel') ||
    new Set(wheels).size !== wheels.length
  )
    throw Error('TERMINAL_GESTURE_INVALID');
  const physical = (bindings[action] ?? []).filter(
    (value) => parseLegacyShortcut(value, platform)?.kind !== 'wheel',
  );
  if (physical.length + wheels.length > 2) throw Error('TERMINAL_GESTURE_CAPACITY');
  return { ...structuredClone(bindings), [action]: [...physical, ...wheels] };
}
