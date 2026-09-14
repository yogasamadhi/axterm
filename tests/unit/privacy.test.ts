import { describe, expect, it } from 'vitest';
import { maskHostAddress } from '../../apps/desktop/src/renderer/src/app/privacy';

describe('privacy address mask', () => {
  it('matches the Electerm IPv4/hostname behavior and masks IPv6 compactly', () => {
    expect(maskHostAddress('192.168.100.25')).toBe('192.168.*.*');
    expect(maskHostAddress('server.example.test')).toBe('***ver.example.test');
    expect(maskHostAddress('ab')).toBe('***');
    expect(maskHostAddress('2001:db8:abcd::1')).toBe('2001:db8:…');
  });
});
