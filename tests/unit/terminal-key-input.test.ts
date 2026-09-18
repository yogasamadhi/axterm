import { describe, expect, it } from 'vitest';
import {
  TERMINAL_CTRL_C_DOUBLE_PRESS_MS,
  terminalBackspaceSequence,
  terminalCtrlCPress,
  terminalShiftEnterSequence,
} from '../../apps/desktop/src/renderer/src/components/terminal-key-input';

describe('Electerm terminal key input compatibility', () => {
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

  it('decodes only the escape sequences accepted by the pinned Electerm helper', () => {
    expect(terminalShiftEnterSequence('A\\nB\\rC\\tD\\\\E\\x')).toBe('A\nB\rC\tD\\E\\x');
    expect(terminalShiftEnterSequence('')).toBe('\n');
    expect(terminalShiftEnterSequence('tail\\')).toBe('tail\\');
  });
});
