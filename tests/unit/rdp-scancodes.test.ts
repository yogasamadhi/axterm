import { describe, expect, it } from 'vitest';
import { RDP_SCANCODES } from '../../apps/desktop/src/renderer/src/components/rdp-scancodes';

describe('RDP browser-code to Windows scan-code mapping', () => {
  it('retains the established 84-key input surface', () => {
    expect(Object.keys(RDP_SCANCODES)).toHaveLength(84);
    for (const code of [
      'KeyA',
      'KeyZ',
      'Digit0',
      'Enter',
      'Escape',
      'Backspace',
      'ControlLeft',
      'ControlRight',
      'AltLeft',
      'AltRight',
      'MetaLeft',
      'MetaRight',
      'F1',
      'F12',
      'ArrowLeft',
      'ArrowRight',
      'Insert',
      'Delete',
    ]) {
      expect(RDP_SCANCODES[code], code).toBeDefined();
    }
    expect(RDP_SCANCODES.Unidentified).toBeUndefined();
  });

  it('uses the Chromium Windows scan-code column for base and extended keys', () => {
    expect(RDP_SCANCODES.KeyA).toBe(0x001e);
    expect(RDP_SCANCODES.Enter).toBe(0x001c);
    expect(RDP_SCANCODES.F12).toBe(0x0058);
    expect(RDP_SCANCODES.ControlRight).toBe(0xe01d);
    expect(RDP_SCANCODES.AltRight).toBe(0xe038);
    expect(RDP_SCANCODES.MetaLeft).toBe(0xe05b);
    expect(RDP_SCANCODES.ArrowUp).toBe(0xe048);
    expect(RDP_SCANCODES.Delete).toBe(0xe053);
    expect(Object.values(RDP_SCANCODES).every((value) => value > 0 && value <= 0xe0ff)).toBe(true);
  });
});
