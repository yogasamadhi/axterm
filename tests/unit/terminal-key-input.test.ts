import { describe, expect, it } from 'vitest';
import {
  terminalBackspaceSequence,
  terminalShiftEnterSequence,
} from '../../apps/desktop/src/renderer/src/components/terminal-key-input';

describe('Electerm terminal key input compatibility', () => {
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
