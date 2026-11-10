import { expect, it } from 'vitest';
import { clampFileManagerSplitPercent } from '../../packages/plugins/files/src/client/ui/arrangement-policy.ts';
it('retains the reviewed 25–75 percent split bounds for keyboard and pointer state without invalid layout values', () => {
  expect(clampFileManagerSplitPercent(10)).toBe(25);
  expect(clampFileManagerSplitPercent(82)).toBe(75);
  expect(clampFileManagerSplitPercent(50)).toBe(50);
  expect(clampFileManagerSplitPercent(64.5)).toBe(64.5);
  expect(clampFileManagerSplitPercent(NaN)).toBe(50);
});
