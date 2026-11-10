import { expect, it, vi } from 'vitest';
import { parseLegacyShortcut } from '@axterm/plugin-api/shortcuts';
import { legacyShortcutDocument } from '../../packages/plugins/configuration/src/client/shortcuts.ts';
import {
  gestureChord,
  wheelAction,
  replaceGestureBindings,
} from '../../packages/plugins/terminals/src/client/gestures/model.ts';
import { installTerminalGestures } from '../../packages/plugins/terminals/src/client/gestures/input.ts';
it('preserves physical legacy bindings in all six device profiles and separates wheel metadata', () => {
  expect(parseLegacyShortcut('CmdOrCtrl+Shift+K', 'macos')).toEqual({
    kind: 'keyboard',
    binding: { code: 'KeyK', modifiers: ['shift', 'meta'] },
  });
  expect(parseLegacyShortcut('CTRL+WHEELUP', 'linux')).toEqual({
    kind: 'wheel',
    direction: 'up',
    modifiers: ['control'],
  });
  const doc = legacyShortcutDocument(
    { app_newTab: ['alt+z'], terminal_zoominTerminal: ['meta+wheelup', 'ctrl+equal'] },
    'desktop',
    'macos',
  );
  expect(Object.keys(doc.profiles)).toHaveLength(6);
  for (const profile of Object.values(doc.profiles)) {
    expect(profile?.['app.newTab']).toEqual({ code: 'KeyZ', modifiers: ['alt'] });
    expect(profile?.['terminal.zoominTerminal.alternate']).toEqual({
      code: 'Equal',
      modifiers: ['control'],
    });
    expect(profile?.['terminal.zoominTerminal']).toBeUndefined();
  }
  for (const value of [
    'x',
    'ctrl+bogus',
    'ctrl+wheelright',
    'alt+meta+shift+ctrl+' + 'x'.repeat(100),
  ])
    expect(parseLegacyShortcut(value, 'macos')).toBeUndefined();
});
const wheel = (
  deltaY: number,
  modifiers: Partial<Pick<WheelEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>> = {},
) => ({ deltaY, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers });
it('matches exact modifiers, retained platform defaults and explicit disablement', () => {
  expect(wheelAction(wheel(-1, { metaKey: true }), {}, 'macos')).toBe('terminal_zoominTerminal');
  expect(wheelAction(wheel(1, { ctrlKey: true }), {}, 'windows')).toBe('terminal_zoomoutTerminal');
  expect(wheelAction(wheel(-1, { ctrlKey: true, shiftKey: true }), {}, 'linux')).toBeUndefined();
  expect(
    wheelAction(wheel(-1, { ctrlKey: true }), { terminal_zoominTerminal: [] }, 'linux'),
  ).toBeUndefined();
  expect(
    wheelAction(wheel(-1, { altKey: true }), { terminal_zoominTerminal: ['alt+wheelup'] }, 'linux'),
  ).toBe('terminal_zoominTerminal');
  expect(gestureChord(wheel(0, { metaKey: true }))).toBeUndefined();
  expect(gestureChord(wheel(-1))).toBeUndefined();
});
it('preserves reviewed unrelated/physical bindings and refuses overflow or invalid gestures', () => {
  const original = {
    app_newTab: ['alt+q'],
    terminal_zoominTerminal: ['ctrl+equal', 'meta+wheelup'],
  };
  expect(
    replaceGestureBindings(original, 'terminal_zoominTerminal', ['alt+wheelup'], 'macos'),
  ).toEqual({ app_newTab: ['alt+q'], terminal_zoominTerminal: ['ctrl+equal', 'alt+wheelup'] });
  expect(original.terminal_zoominTerminal).toEqual(['ctrl+equal', 'meta+wheelup']);
  expect(() =>
    replaceGestureBindings(
      original,
      'terminal_zoominTerminal',
      ['meta+wheelup', 'alt+wheelup'],
      'macos',
    ),
  ).toThrow('CAPACITY');
  expect(() =>
    replaceGestureBindings(original, 'terminal_zoominTerminal', ['alt+k'], 'macos'),
  ).toThrow('INVALID');
});
it('consumes only accepted live-view wheel input and withdraws its exact listener', async () => {
  const target = new EventTarget(),
    run = vi.fn(async () => {});
  let live = true;
  const dispose = installTerminalGestures(target as HTMLElement, {
    platform: 'macos',
    current: () => (live ? {} : undefined),
    run,
  });
  const dispatch = (props: ReturnType<typeof wheel>) => {
    const event = Object.assign(new Event('wheel', { cancelable: true }), props);
    target.dispatchEvent(event);
    return event;
  };
  expect(dispatch(wheel(-1)).defaultPrevented).toBe(false);
  expect(run).not.toHaveBeenCalled();
  expect(dispatch(wheel(-1, { metaKey: true })).defaultPrevented).toBe(true);
  expect(run).toHaveBeenCalledWith('zoom-in');
  live = false;
  expect(dispatch(wheel(-1, { metaKey: true })).defaultPrevented).toBe(false);
  expect(run).toHaveBeenCalledOnce();
  live = true;
  dispose();
  expect(dispatch(wheel(-1, { metaKey: true })).defaultPrevented).toBe(false);
  expect(run).toHaveBeenCalledOnce();
  await Promise.resolve();
});
