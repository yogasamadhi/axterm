import { describe, expect, it } from 'vitest';
import {
  buildTerminalShortcutCombo,
  defaultTerminalShortcutButtons,
  moveTerminalShortcutButton,
  resolveTerminalShortcutCursorMode,
  shortcutKeyboardDetected,
  shortcutKeyboardOffset,
  TERMINAL_SHORTCUT_CANDIDATES,
} from '../../apps/desktop/src/renderer/src/components/terminal-shortcut-bar-model';

describe('terminal shortcut bar model', () => {
  it('matches the pinned default order and keeps every candidate ID unique', () => {
    const defaults = defaultTerminalShortcutButtons();
    expect(defaults).toHaveLength(34);
    expect(defaults.slice(0, 5).map(({ id }) => id)).toEqual([
      'esc',
      'tab',
      'ctrl+c',
      'ctrl+v',
      'ctrl+z',
    ]);
    expect(defaults.at(-1)).toMatchObject({ id: 'f12', data: '\u001b[24~' });
    expect(new Set(TERMINAL_SHORTCUT_CANDIDATES.map(({ id }) => id)).size).toBe(
      TERMINAL_SHORTCUT_CANDIDATES.length,
    );
  });

  it('builds the pinned modifier combinations without interpreting user text', () => {
    expect(buildTerminalShortcutCombo(['ctrl', 'shift'], 'key-c', 'custom-c')).toEqual({
      id: 'custom-c',
      label: 'Ctrl+Shift+C',
      data: '\u0003',
      custom: true,
    });
    expect(buildTerminalShortcutCombo(['shift'], 'key-a', 'custom-a')).toMatchObject({
      label: 'Shift+A',
      data: 'A',
    });
    expect(buildTerminalShortcutCombo(['alt'], 'arrow-up', 'custom-up')).toMatchObject({
      label: 'Alt+↑',
      data: '\u001b\u001b[A',
    });
    expect(buildTerminalShortcutCombo(['meta', 'meta'], 'key-z', 'custom-z')).toMatchObject({
      label: 'Meta+Z',
      data: 'z',
    });
    expect(buildTerminalShortcutCombo([], 'unknown')).toBeUndefined();
  });

  it('uses SS3 only for cursor, Home and End while application cursor mode is active', () => {
    expect(resolveTerminalShortcutCursorMode('\u001b[A', false)).toBe('\u001b[A');
    expect(resolveTerminalShortcutCursorMode('\u001b[A', true)).toBe('\u001bOA');
    expect(resolveTerminalShortcutCursorMode('\u001b[H', true)).toBe('\u001bOH');
    expect(resolveTerminalShortcutCursorMode('\u001b[5~', true)).toBe('\u001b[5~');
  });

  it('reorders around the target and leaves invalid moves unchanged', () => {
    const buttons = defaultTerminalShortcutButtons().slice(0, 4);
    expect(moveTerminalShortcutButton(buttons, 'esc', 'ctrl+c', true).map(({ id }) => id)).toEqual([
      'tab',
      'ctrl+c',
      'esc',
      'ctrl+v',
    ]);
    expect(moveTerminalShortcutButton(buttons, 'missing', 'tab', false)).toBe(buttons);
  });

  it('distinguishes overlay and touch-triggered resized keyboards from window resizing', () => {
    const base = {
      baselineHeight: 900,
      baselineWidth: 1440,
      visualHeight: 620,
      visualWidth: 1440,
    };
    expect(shortcutKeyboardDetected({ ...base, layoutHeight: 900, recentTouch: false })).toBe(true);
    expect(shortcutKeyboardDetected({ ...base, layoutHeight: 620, recentTouch: true })).toBe(true);
    expect(shortcutKeyboardDetected({ ...base, layoutHeight: 620, recentTouch: false })).toBe(
      false,
    );
    expect(
      shortcutKeyboardDetected({ ...base, visualWidth: 900, layoutHeight: 900, recentTouch: true }),
    ).toBe(false);
    expect(shortcutKeyboardOffset({ ...base, offsetTop: 20 })).toBe(260);
    expect(shortcutKeyboardOffset({ ...base, visualWidth: 900, offsetTop: 0 })).toBe(0);
  });
});
