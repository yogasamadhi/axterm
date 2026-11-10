import { describe, expect, it } from 'vitest';
import {
  TRANSFER_PAGE_SIZE,
  visibleTransferCount,
} from '../../packages/plugins/transfers/src/client/ui/paging.ts';

describe('transfer center paging', () => {
  it('renders one bounded page and grows only on request', () => {
    expect(TRANSFER_PAGE_SIZE).toBe(20);
    expect(visibleTransferCount(0, 0)).toBe(0);
    expect(visibleTransferCount(5, 0)).toBe(5);
    expect(visibleTransferCount(20, 0)).toBe(20);
    expect(visibleTransferCount(500, 0)).toBe(20);
    expect(visibleTransferCount(500, 20)).toBe(40);
    expect(visibleTransferCount(500, 1000)).toBe(500);
  });

  it('never renders more rows than the Runtime returned', () => {
    expect(visibleTransferCount(3, 100)).toBe(3);
    expect(visibleTransferCount(-1, 0)).toBe(0);
    expect(visibleTransferCount(10, -5)).toBe(10);
    expect(visibleTransferCount(10.7, 0)).toBe(10);
  });
});
