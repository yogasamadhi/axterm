import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const transferNonce = require('./transfer-nonce.cjs') as () => string;

describe('transfer staging nonce', () => {
  it('produces independent 128-bit hex names', () => {
    const values = Array.from({ length: 256 }, transferNonce);
    expect(values.every((value) => /^[0-9a-f]{32}$/u.test(value))).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });
});
