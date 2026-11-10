import { expect, it } from 'vitest';
import { terminalClipboardShortcut } from '../../packages/plugins/terminals/src/client/rendering/key-input.ts';
const key = (code: string, modifiers: Partial<KeyboardEvent> = {}) => ({
  code,
  key: code.slice(3).toLowerCase(),
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  isComposing: false,
  ...modifiers,
});
it('routes the macOS fixed copy and paste keys while leaving composition and unrelated chords intact', () => {
  expect(terminalClipboardShortcut(key('KeyC', { metaKey: true }), 'darwin', true)).toBe('copy');
  expect(terminalClipboardShortcut(key('KeyV', { metaKey: true }), 'darwin', false)).toBe('paste');
  expect(
    terminalClipboardShortcut(key('KeyC', { metaKey: true, isComposing: true }), 'darwin', true),
  ).toBeUndefined();
  expect(
    terminalClipboardShortcut(key('KeyC', { metaKey: true, altKey: true }), 'darwin', true),
  ).toBeUndefined();
  expect(
    terminalClipboardShortcut(key('KeyC', { metaKey: true, shiftKey: true }), 'darwin', true),
  ).toBeUndefined();
  expect(terminalClipboardShortcut(key('KeyC', { ctrlKey: true }), 'darwin', true)).toBeUndefined();
});
it('preserves plain Linux interrupt input without selection and explicit shifted clipboard keys', () => {
  expect(terminalClipboardShortcut(key('KeyC', { ctrlKey: true }), 'linux', false)).toBeUndefined();
  expect(terminalClipboardShortcut(key('KeyC', { ctrlKey: true }), 'linux', true)).toBe('copy');
  expect(
    terminalClipboardShortcut(key('KeyC', { ctrlKey: true, shiftKey: true }), 'linux', false),
  ).toBe('copy');
  expect(terminalClipboardShortcut(key('KeyV', { ctrlKey: true }), 'linux', false)).toBe('paste');
  expect(
    terminalClipboardShortcut(key('KeyV', { ctrlKey: true, shiftKey: true }), 'linux', false),
  ).toBe('paste');
});
it('keeps every Windows copy/paste chord with the existing copy/interruption owner', () => {
  for (const code of ['KeyC', 'KeyV'])
    for (const shiftKey of [false, true])
      expect(
        terminalClipboardShortcut(key(code, { ctrlKey: true, shiftKey }), 'win32', true),
      ).toBeUndefined();
});
