import type { QuickCommand, ShortcutActionId, ShortcutBindings } from '@workspace/contracts';
import type { AxtermMessageKey, Variables } from '../../i18n/core';

export type ShortcutPlatform = 'mac' | 'windows' | 'linux';
export type ShortcutScope = 'app' | 'terminal';

export interface ShortcutActionDefinition {
  id: ShortcutActionId;
  labelKey: AxtermMessageKey;
  scope: ShortcutScope;
  readonly: boolean;
  mac: readonly string[];
  other: readonly string[];
}

export interface ShortcutConflict {
  chord: string;
  ownerId: string;
  ownerLabel: string;
  source: 'action' | 'quick-command' | 'reserved';
}

export const SHORTCUT_ACTIONS: readonly ShortcutActionDefinition[] = [
  action('app_closeCurrentTab', 'shortcuts.action.closeCurrentTab', 'app', ['alt+w']),
  action('app_mouseWheelDownCloseTab', 'shortcuts.action.middleClickCloseTab', 'app', [], [], true),
  action('app_reloadCurrentTab', 'shortcuts.action.reloadCurrentTab', 'app', ['alt+r']),
  action('app_reloadAll', 'shortcuts.action.reloadAllTabs', 'app', ['alt+y']),
  action('app_cloneToNextLayout', 'shortcuts.action.cloneToNextPane', 'app', ['alt+slash']),
  action('app_duplicateTab', 'shortcuts.action.duplicateCurrentTab', 'app', ['alt+c']),
  action('app_newBookmark', 'shortcuts.action.newBookmark', 'app', ['ctrl+n'], ['meta+n']),
  action('app_newTab', 'shortcuts.action.newLocalTerminal', 'app', ['alt+q']),
  action('app_toggleAddBtn', 'shortcuts.action.openNewSession', 'app', ['alt+n']),
  action('app_togglefullscreen', 'shortcuts.action.toggleFullscreen', 'app', ['alt+f']),
  action('app_zoomin', 'shortcuts.action.zoomInWindow', 'app', ['ctrl+equal'], ['meta+equal']),
  action('app_zoomout', 'shortcuts.action.zoomOutWindow', 'app', ['ctrl+minus'], ['meta+minus']),
  action('app_prevTab', 'shortcuts.action.previousTab', 'app', ['ctrl+shift+tab']),
  action('app_nextTab', 'shortcuts.action.nextTab', 'app', ['ctrl+tab']),
  action(
    'terminal_clear',
    'shortcuts.action.clearScrollback',
    'terminal',
    ['ctrl+l', 'ctrl+shift+l'],
    ['meta+l'],
  ),
  action(
    'terminal_copy',
    'shortcuts.action.copySelection',
    'terminal',
    ['ctrl+c', 'ctrl+shift+c'],
    ['meta+c'],
    true,
  ),
  action(
    'terminal_paste',
    'shortcuts.action.paste',
    'terminal',
    ['ctrl+v', 'ctrl+shift+v'],
    ['meta+v'],
    true,
  ),
  action('terminal_search', 'shortcuts.action.searchTerminal', 'terminal', ['ctrl+f'], ['meta+f']),
  action('terminal_pasteSelected', 'shortcuts.action.pasteSelection', 'terminal', ['alt+insert']),
  action(
    'terminal_showNormalBuffer',
    'shortcuts.action.showNormalBuffer',
    'terminal',
    ['ctrl+arrowup'],
    ['meta+arrowup'],
  ),
  action(
    'terminal_zoominTerminal',
    'shortcuts.action.zoomInTerminal',
    'terminal',
    ['ctrl+wheelup'],
    ['meta+wheelup'],
  ),
  action(
    'terminal_zoomoutTerminal',
    'shortcuts.action.zoomOutTerminal',
    'terminal',
    ['ctrl+wheeldown'],
    ['meta+wheeldown'],
  ),
  action('terminal_syncSftpPath', 'shortcuts.action.syncSftpPath', 'terminal', ['alt+shift+f11']),
] as const;

const ACTION_BY_ID = new Map(SHORTCUT_ACTIONS.map((definition) => [definition.id, definition]));

function action(
  id: ShortcutActionId,
  labelKey: AxtermMessageKey,
  scope: ShortcutScope,
  other: readonly string[],
  mac: readonly string[] = other,
  readonly = false,
): ShortcutActionDefinition {
  return { id, labelKey, scope, readonly, other, mac };
}

export function shortcutPlatform(userAgent: string): ShortcutPlatform {
  if (/Macintosh|Mac OS X/u.test(userAgent)) return 'mac';
  if (/Windows/u.test(userAgent)) return 'windows';
  return 'linux';
}

export function shortcutAction(id: ShortcutActionId): ShortcutActionDefinition {
  const definition = ACTION_BY_ID.get(id);
  if (!definition) throw new Error(`Unknown shortcut action: ${id}`);
  return definition;
}

export function effectiveShortcutBindings(
  definition: ShortcutActionDefinition,
  bindings: ShortcutBindings | undefined,
  platform: ShortcutPlatform,
): readonly string[] {
  if (!definition.readonly && bindings && definition.id in bindings)
    return bindings[definition.id] ?? [];
  return platform === 'mac' ? definition.mac : definition.other;
}

export function shortcutActionForChord(
  chord: string,
  bindings: ShortcutBindings | undefined,
  platform: ShortcutPlatform,
): ShortcutActionDefinition | undefined {
  return SHORTCUT_ACTIONS.find((definition) =>
    effectiveShortcutBindings(definition, bindings, platform).includes(chord),
  );
}

export function shortcutFromKeyboardEvent(
  event: Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
): string | undefined {
  const key = shortcutKey(event.code, event.key);
  if (!key || isModifierKey(key)) return undefined;
  return chord([...modifiers(event), key]);
}

export function shortcutFromWheelEvent(
  event: Pick<WheelEvent, 'altKey' | 'ctrlKey' | 'deltaY' | 'metaKey' | 'shiftKey'>,
): string | undefined {
  if (!event.deltaY) return undefined;
  return chord([...modifiers(event), event.deltaY < 0 ? 'wheelup' : 'wheeldown']);
}

export function normalizeShortcut(value: string, platform: ShortcutPlatform): string | undefined {
  const aliases: Record<string, string> = {
    command: 'meta',
    cmd: 'meta',
    commandorcontrol: platform === 'mac' ? 'meta' : 'ctrl',
    cmdorctrl: platform === 'mac' ? 'meta' : 'ctrl',
    control: 'ctrl',
    option: 'alt',
    '+': 'equal',
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
    .map((part) => aliases[part] ?? part)
    .filter(Boolean);
  const key = parts.at(-1);
  if (!key || isModifierKey(key)) return undefined;
  const modifierSet = new Set(parts.slice(0, -1));
  if ([...modifierSet].some((part) => !isModifierKey(part)) || modifierSet.size === 0)
    return undefined;
  return chord([...MODIFIER_ORDER.filter((modifier) => modifierSet.has(modifier)), key]);
}

export function shortcutConflicts(
  actionId: string,
  proposed: readonly string[],
  bindings: ShortcutBindings | undefined,
  quickCommands: readonly Pick<QuickCommand, 'id' | 'name' | 'shortcut'>[],
  platform: ShortcutPlatform,
  x: (key: AxtermMessageKey, variables?: Variables) => string,
): ShortcutConflict[] {
  const owners = shortcutOwners(bindings, quickCommands, platform, x);
  return proposed.flatMap((candidate) => {
    const owner = owners.get(candidate);
    if (!owner || owner.ownerId === actionId) return [];
    return [{ chord: candidate, ...owner }];
  });
}

export function shortcutToElectronAccelerator(shortcut: string): string {
  const keys: Record<string, string> = {
    arrowdown: 'Down',
    arrowleft: 'Left',
    arrowright: 'Right',
    arrowup: 'Up',
    backquote: '`',
    enter: 'Return',
    equal: '=',
    insert: 'Insert',
    minus: '-',
    slash: '/',
    tab: 'Tab',
  };
  const modifiers: Record<string, string> = {
    alt: 'Alt',
    ctrl: 'Control',
    meta: 'Command',
    shift: 'Shift',
  };
  return shortcut
    .split('+')
    .map((part, index, parts) => {
      if (index < parts.length - 1) return modifiers[part] ?? part;
      return keys[part] ?? (/^f\d+$/u.test(part) ? part.toUpperCase() : part.toUpperCase());
    })
    .join('+');
}

export function formatShortcut(
  chordValue: string,
  platform: ShortcutPlatform,
  x?: (key: AxtermMessageKey, variables?: Variables) => string,
): string {
  const labels: Record<string, string> =
    platform === 'mac'
      ? {
          ctrl: '⌃',
          meta: '⌘',
          alt: '⌥',
          shift: '⇧',
          arrowup: '↑',
          arrowdown: '↓',
          wheelup: x?.('shortcuts.wheelUp') ?? 'Wheel↑',
          wheeldown: x?.('shortcuts.wheelDown') ?? 'Wheel↓',
          equal: '=',
          minus: '−',
          slash: '/',
        }
      : {
          ctrl: 'Ctrl',
          meta: 'Meta',
          alt: 'Alt',
          shift: 'Shift',
          arrowup: '↑',
          arrowdown: '↓',
          wheelup: x?.('shortcuts.wheelUp') ?? 'Wheel↑',
          wheeldown: x?.('shortcuts.wheelDown') ?? 'Wheel↓',
          equal: '=',
          minus: '−',
          slash: '/',
        };
  const separator = platform === 'mac' ? '' : '+';
  return chordValue
    .split('+')
    .map((part) => labels[part] ?? (/^f\d+$/u.test(part) ? part.toUpperCase() : part.toUpperCase()))
    .join(separator);
}

export function isShortcutInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('[data-shortcut-capture="true"]')) return true;
  if (target.closest('.xterm')) return false;
  return !!target.closest('input, textarea, select, [contenteditable="true"]');
}

function shortcutOwners(
  bindings: ShortcutBindings | undefined,
  quickCommands: readonly Pick<QuickCommand, 'id' | 'name' | 'shortcut'>[],
  platform: ShortcutPlatform,
  x: (key: AxtermMessageKey, variables?: Variables) => string,
): Map<string, Omit<ShortcutConflict, 'chord'>> {
  const owners = new Map<string, Omit<ShortcutConflict, 'chord'>>();
  for (const definition of SHORTCUT_ACTIONS)
    for (const candidate of effectiveShortcutBindings(definition, bindings, platform))
      owners.set(candidate, {
        ownerId: definition.id,
        ownerLabel: x(definition.labelKey),
        source: 'action',
      });
  for (const command of quickCommands) {
    if (!command.shortcut) continue;
    const candidate = normalizeShortcut(command.shortcut, platform);
    if (candidate && !owners.has(candidate))
      owners.set(candidate, {
        ownerId: `quick-command:${command.id}`,
        ownerLabel: x('shortcuts.quickCommandNamed', { name: command.name }),
        source: 'quick-command',
      });
  }
  for (const [candidate, label] of reservedShortcuts(platform, x))
    if (!owners.has(candidate))
      owners.set(candidate, {
        ownerId: `reserved:${candidate}`,
        ownerLabel: label,
        source: 'reserved',
      });
  return owners;
}

function reservedShortcuts(
  platform: ShortcutPlatform,
  x: (key: AxtermMessageKey, variables?: Variables) => string,
): ReadonlyMap<string, string> {
  const primary = platform === 'mac' ? 'meta' : 'ctrl';
  return new Map([
    [`${primary}+k`, x('shortcuts.commandPalette')],
    [`${primary}+b`, x('shortcuts.toggleSidebar')],
  ]);
}

const MODIFIER_ORDER = ['ctrl', 'meta', 'alt', 'shift'] as const;

function modifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): string[] {
  return MODIFIER_ORDER.filter((modifier) =>
    modifier === 'ctrl'
      ? event.ctrlKey
      : modifier === 'meta'
        ? event.metaKey
        : modifier === 'alt'
          ? event.altKey
          : event.shiftKey,
  );
}

function shortcutKey(code: string, key: string): string | undefined {
  if (/^Key[A-Z]$/u.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/u.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-2])$/u.test(code)) return code.toLowerCase();
  const codes: Record<string, string> = {
    ArrowDown: 'arrowdown',
    ArrowLeft: 'arrowleft',
    ArrowRight: 'arrowright',
    ArrowUp: 'arrowup',
    Backquote: 'backquote',
    Enter: 'enter',
    Equal: 'equal',
    Insert: 'insert',
    Minus: 'minus',
    Slash: 'slash',
    Tab: 'tab',
  };
  return codes[code] ?? (key.length === 1 ? key.toLowerCase() : undefined);
}

function isModifierKey(value: string): boolean {
  return (MODIFIER_ORDER as readonly string[]).includes(value);
}

function chord(parts: readonly string[]): string | undefined {
  if (parts.length < 2) return undefined;
  return parts.join('+');
}
