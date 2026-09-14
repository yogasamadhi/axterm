import { describe, expect, it } from 'vitest';
import {
  clampUnixTimestampTooltip,
  detectUnixTimestampSelection,
  formatUnixTimestampSelection,
  UNIX_TIMESTAMP_MAX_MILLISECONDS,
  UNIX_TIMESTAMP_MIN_MILLISECONDS,
} from '../../apps/desktop/src/renderer/src/components/terminal-timestamp';

describe('terminal Unix timestamp selection model', () => {
  it.each([
    ['946684800', 946_684_800_000, 'seconds'],
    ['9999999999', 9_999_999_999_000, 'seconds'],
    [' 1704067200\n', 1_704_067_200_000, 'seconds'],
    ['1000000000000', 1_000_000_000_000, 'milliseconds'],
    ['1704067200123', 1_704_067_200_123, 'milliseconds'],
    ['9999999999999', 9_999_999_999_999, 'milliseconds'],
  ] as const)('recognizes %j as a %s timestamp', (selection, epochMilliseconds, precision) => {
    expect(detectUnixTimestampSelection(selection)).toEqual({ epochMilliseconds, precision });
  });

  it.each([
    '',
    '   ',
    '946684799',
    '946684800000',
    '32503680000',
    '32503680000000',
    '17040672001',
    '170406720012',
    '17040672001234',
    '-1704067200',
    '+1704067200',
    '1704067200.0',
    '1e1704067200',
    '17040 67200',
    '１７０４０６７２００',
  ])('rejects invalid or out-of-shape selection %j', (selection) => {
    expect(detectUnixTimestampSelection(selection)).toBeUndefined();
  });

  it('keeps the documented UTC bounds while formatting the live result in local time', () => {
    expect(new Date(UNIX_TIMESTAMP_MIN_MILLISECONDS).toISOString()).toBe(
      '2000-01-01T00:00:00.000Z',
    );
    expect(new Date(UNIX_TIMESTAMP_MAX_MILLISECONDS).toISOString()).toBe(
      '3000-01-01T00:00:00.000Z',
    );
    expect(formatUnixTimestampSelection('1704067200', (date) => date.toISOString())).toBe(
      '2024-01-01T00:00:00.000Z',
    );
    expect(formatUnixTimestampSelection('1704067200123', (date) => date.toISOString())).toBe(
      '2024-01-01T00:00:00.123Z',
    );
    expect(formatUnixTimestampSelection('1704067200')).toBe(
      new Date(1_704_067_200_000).toLocaleString(),
    );
  });

  it.each([
    [{ x: 500, y: 400 }, { width: 160, height: 24 }, { width: 1_000, height: 760 }, 420, 364],
    [{ x: 0, y: 0 }, { width: 160, height: 24 }, { width: 1_000, height: 760 }, 8, 8],
    [{ x: 1_000, y: 1_000 }, { width: 160, height: 24 }, { width: 1_000, height: 760 }, 832, 728],
    [{ x: 5, y: 5 }, { width: 160, height: 24 }, { width: 100, height: 20 }, 8, 8],
  ] as const)(
    'keeps the measured tooltip within its viewport',
    (pointer, size, viewport, left, top) => {
      expect(clampUnixTimestampTooltip(pointer, size, viewport)).toEqual({ left, top });
    },
  );
});
