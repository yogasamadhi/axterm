import { describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_CTRL_C_DOUBLE_PRESS_MS,
  installTerminalCompositionGuard,
  terminalBackspaceSequence,
  terminalCtrlCPress,
  terminalShiftEnterSequence,
} from '../../apps/desktop/src/renderer/src/components/terminal-key-input';

describe('terminal IME key ownership', () => {
  const key = (name: string, options: Partial<KeyboardEvent> = {}) => ({
    type: 'keydown',
    key: name,
    code: name,
    keyCode: 0,
    isComposing: false,
    ...options,
  });

  it('leaves deletion, confirmation, navigation and shortcuts to an active composition even without a flag', () => {
    const textarea = new EventTarget();
    const guard = installTerminalCompositionGuard(textarea);
    textarea.dispatchEvent(new Event('compositionstart'));
    for (const name of ['Backspace', 'Delete', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'KeyC'])
      expect(guard.handleKey(key(name))).toBe(false);
    textarea.dispatchEvent(new Event('compositionend'));
    expect(guard.handleKey(key('Backspace'))).toBeUndefined();
    expect(guard.handleKey(key('Enter'))).toBeUndefined();
    guard.dispose();
  });

  it('recognizes the event flag and delegates legacy Process keys to xterm outside preedit', () => {
    const guard = installTerminalCompositionGuard(undefined);
    expect(guard.handleKey(key('Backspace', { isComposing: true }))).toBe(false);
    expect(guard.handleKey(key('Enter', { keyCode: 229 }))).toBe(true);
    expect(guard.handleKey(key('Backspace', { keyCode: 229 }))).toBe(true);
    expect(guard.handleKey(key('Backspace', { keyCode: 8 }))).toBeUndefined();
    guard.dispose();
  });

  it('keeps the confirming keypress and keyup owned after compositionend, then releases the next real key', () => {
    const textarea = new EventTarget();
    const guard = installTerminalCompositionGuard(textarea);
    textarea.dispatchEvent(new Event('compositionstart'));
    expect(guard.handleKey(key('Enter'))).toBe(false);
    textarea.dispatchEvent(new Event('compositionend'));
    expect(guard.handleKey(key('Enter', { type: 'keypress' }))).toBe(false);
    expect(guard.handleKey(key('Enter', { type: 'keyup' }))).toBe(false);
    expect(guard.handleKey(key('Enter'))).toBeUndefined();
    guard.dispose();
  });

  it('does not swallow the next key when the IME omits keyup, and clears ownership on blur', () => {
    const textarea = new EventTarget();
    const guard = installTerminalCompositionGuard(textarea);
    textarea.dispatchEvent(new Event('compositionstart'));
    expect(guard.handleKey(key('Backspace'))).toBe(false);
    textarea.dispatchEvent(new Event('compositionend'));
    expect(guard.handleKey(key('Backspace'))).toBeUndefined();
    textarea.dispatchEvent(new Event('compositionstart'));
    guard.handleKey(key('Enter'));
    textarea.dispatchEvent(new Event('blur'));
    expect(guard.handleKey(key('Enter', { type: 'keyup' }))).toBeUndefined();
    guard.dispose();
  });

  it('removes the exact composition and blur listeners on disposal', () => {
    const textarea = new EventTarget();
    const add = vi.spyOn(textarea, 'addEventListener');
    const remove = vi.spyOn(textarea, 'removeEventListener');
    const guard = installTerminalCompositionGuard(textarea);
    textarea.dispatchEvent(new Event('compositionstart'));
    guard.dispose();
    expect(remove.mock.calls).toEqual(add.mock.calls);
    textarea.dispatchEvent(new Event('compositionstart'));
    expect(guard.handleKey(key('Backspace'))).toBeUndefined();
  });
});

describe('Legacy Prototype terminal key input compatibility', () => {
  it('copies selected text, interrupts without selection, and keeps double-press interrupt', () => {
    const first = terminalCtrlCPress(undefined, 1_000, true);
    expect(first).toEqual({ action: 'copy', nextPressAt: 1_000 });
    expect(
      terminalCtrlCPress(first.nextPressAt, 1_000 + TERMINAL_CTRL_C_DOUBLE_PRESS_MS, true),
    ).toEqual({ action: 'interrupt', nextPressAt: undefined });
    expect(terminalCtrlCPress(undefined, 1_600, false)).toEqual({
      action: 'interrupt',
      nextPressAt: 1_600,
    });
    expect(terminalCtrlCPress(1_600, 1_700, true)).toEqual({
      action: 'interrupt',
      nextPressAt: undefined,
    });
    expect(terminalCtrlCPress(1_000, 1_000 + TERMINAL_CTRL_C_DOUBLE_PRESS_MS + 1, true)).toEqual({
      action: 'copy',
      nextPressAt: 1_000 + TERMINAL_CTRL_C_DOUBLE_PRESS_MS + 1,
    });
  });

  it('uses the configured Backspace sequence and reverses it for Shift+Backspace', () => {
    expect(terminalBackspaceSequence('^?', false).charCodeAt(0)).toBe(0x7f);
    expect(terminalBackspaceSequence('^?', true).charCodeAt(0)).toBe(0x08);
    expect(terminalBackspaceSequence('^H', false).charCodeAt(0)).toBe(0x08);
    expect(terminalBackspaceSequence('^H', true).charCodeAt(0)).toBe(0x7f);
  });

  it('decodes only the escape sequences accepted by the pinned Legacy Prototype helper', () => {
    expect(terminalShiftEnterSequence('A\\nB\\rC\\tD\\\\E\\x')).toBe('A\nB\rC\tD\\E\\x');
    expect(terminalShiftEnterSequence('')).toBe('\n');
    expect(terminalShiftEnterSequence('tail\\')).toBe('tail\\');
  });
});
