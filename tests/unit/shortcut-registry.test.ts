import { describe, expect, it } from 'vitest';
import {
  SHORTCUT_ACTIONS,
  effectiveShortcutBindings,
  formatShortcut,
  normalizeShortcut,
  shortcutAction,
  shortcutActionForChord,
  shortcutConflicts,
  shortcutFromKeyboardEvent,
  shortcutFromWheelEvent,
} from '../../apps/desktop/src/renderer/src/app/shortcuts/shortcut-registry';
import { translateAxterm } from '../../apps/desktop/src/renderer/src/i18n/core';

const x = (
  key: Parameters<typeof translateAxterm>[1],
  variables?: Parameters<typeof translateAxterm>[2],
) => translateAxterm('zh-CN', key, variables);

describe('shortcut registry', () => {
  it('maps every pinned Electerm action and platform default', () => {
    expect(SHORTCUT_ACTIONS).toHaveLength(23);
    expect(new Set(SHORTCUT_ACTIONS.map(({ id }) => id)).size).toBe(23);
    expect(effectiveShortcutBindings(shortcutAction('app_newBookmark'), {}, 'mac')).toEqual([
      'meta+n',
    ]);
    expect(effectiveShortcutBindings(shortcutAction('app_newBookmark'), {}, 'windows')).toEqual([
      'ctrl+n',
    ]);
    expect(effectiveShortcutBindings(shortcutAction('terminal_clear'), {}, 'linux')).toEqual([
      'ctrl+l',
      'ctrl+shift+l',
    ]);
  });

  it('uses sparse editable overrides, supports disabling and protects readonly defaults', () => {
    expect(
      effectiveShortcutBindings(
        shortcutAction('app_closeCurrentTab'),
        { app_closeCurrentTab: ['ctrl+shift+w'] },
        'linux',
      ),
    ).toEqual(['ctrl+shift+w']);
    expect(
      effectiveShortcutBindings(
        shortcutAction('app_closeCurrentTab'),
        { app_closeCurrentTab: [] },
        'linux',
      ),
    ).toEqual([]);
    expect(
      effectiveShortcutBindings(
        shortcutAction('terminal_copy'),
        { terminal_copy: ['alt+c'] },
        'mac',
      ),
    ).toEqual(['meta+c']);
  });

  it('canonicalizes physical keyboard keys and wheel directions', () => {
    expect(
      shortcutFromKeyboardEvent({
        altKey: true,
        code: 'Slash',
        ctrlKey: false,
        key: '/',
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe('alt+slash');
    expect(
      shortcutFromKeyboardEvent({
        altKey: true,
        code: 'F11',
        ctrlKey: false,
        key: 'F11',
        metaKey: false,
        shiftKey: true,
      }),
    ).toBe('alt+shift+f11');
    expect(
      shortcutFromWheelEvent({
        altKey: false,
        ctrlKey: false,
        deltaY: -2,
        metaKey: true,
        shiftKey: false,
      }),
    ).toBe('meta+wheelup');
  });

  it('normalizes accelerator aliases and resolves actions', () => {
    expect(normalizeShortcut('CommandOrControl+Shift+L', 'mac')).toBe('meta+shift+l');
    expect(normalizeShortcut('CommandOrControl+Shift+L', 'linux')).toBe('ctrl+shift+l');
    expect(normalizeShortcut('Alt+/', 'linux')).toBe('alt+slash');
    expect(shortcutActionForChord('alt+r', {}, 'linux')?.id).toBe('app_reloadCurrentTab');
    expect(formatShortcut('meta+shift+l', 'mac')).toBe('⌘⇧L');
    expect(formatShortcut('ctrl+shift+l', 'linux')).toBe('Ctrl+Shift+L');
  });

  it('reports action, quick-command and reserved shortcut collisions', () => {
    expect(shortcutConflicts('app_newTab', ['alt+r'], {}, [], 'linux', x)[0]).toMatchObject({
      ownerId: 'app_reloadCurrentTab',
      source: 'action',
    });
    expect(
      shortcutConflicts(
        'app_newTab',
        ['ctrl+shift+p'],
        {},
        [{ id: 'qc-1', name: '部署', shortcut: 'CommandOrControl+Shift+P' }],
        'linux',
        x,
      )[0],
    ).toMatchObject({ ownerId: 'quick-command:qc-1', source: 'quick-command' });
    expect(shortcutConflicts('app_newTab', ['ctrl+k'], {}, [], 'linux', x)[0]).toMatchObject({
      ownerId: 'reserved:ctrl+k',
      source: 'reserved',
    });
  });
});
