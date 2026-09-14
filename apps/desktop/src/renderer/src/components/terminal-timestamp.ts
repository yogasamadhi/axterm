export const UNIX_TIMESTAMP_MIN_MILLISECONDS = Date.UTC(2000, 0, 1);
export const UNIX_TIMESTAMP_MAX_MILLISECONDS = Date.UTC(3000, 0, 1);

export interface UnixTimestampMatch {
  epochMilliseconds: number;
  precision: 'seconds' | 'milliseconds';
}

export interface TerminalPointerPosition {
  x: number;
  y: number;
}

export interface TerminalTooltipSize {
  width: number;
  height: number;
}

export interface TerminalTooltipViewport {
  width: number;
  height: number;
}

export interface TerminalTooltipPosition {
  left: number;
  top: number;
}

export type UnixTimestampFormatter = (value: Date) => string;

const DIGITS_ONLY = /^\d+$/;
const TOOLTIP_MARGIN = 8;
const ELECTERM_TOOLTIP_TOP_OFFSET = 36;

/**
 * Match the pinned Electerm selection rules. The date bounds are applied after
 * the strict 9/10-digit seconds or 13-digit milliseconds shape check.
 */
export function detectUnixTimestampSelection(selection: string): UnixTimestampMatch | undefined {
  const value = selection.trim();
  const seconds = value.length === 9 || value.length === 10;
  const milliseconds = value.length === 13;
  if ((!seconds && !milliseconds) || !DIGITS_ONLY.test(value)) return undefined;

  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return undefined;
  const epochMilliseconds = seconds ? numeric * 1_000 : numeric;
  if (
    epochMilliseconds < UNIX_TIMESTAMP_MIN_MILLISECONDS ||
    epochMilliseconds > UNIX_TIMESTAMP_MAX_MILLISECONDS
  )
    return undefined;

  return {
    epochMilliseconds,
    precision: seconds ? 'seconds' : 'milliseconds',
  };
}

export function formatUnixTimestampSelection(
  selection: string,
  formatter: UnixTimestampFormatter = (value) => value.toLocaleString(),
): string | undefined {
  const match = detectUnixTimestampSelection(selection);
  return match ? formatter(new Date(match.epochMilliseconds)) : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Electerm centers the tooltip on the pointer and places its top 36 px above
 * it. Axterm retains that geometry, then clamps the measured box to the live
 * viewport so edge selections remain readable.
 */
export function clampUnixTimestampTooltip(
  pointer: TerminalPointerPosition,
  size: TerminalTooltipSize,
  viewport: TerminalTooltipViewport,
): TerminalTooltipPosition {
  const width = Math.max(0, size.width);
  const height = Math.max(0, size.height);
  const maximumLeft = Math.max(TOOLTIP_MARGIN, viewport.width - width - TOOLTIP_MARGIN);
  const maximumTop = Math.max(TOOLTIP_MARGIN, viewport.height - height - TOOLTIP_MARGIN);
  return {
    left: clamp(pointer.x - width / 2, TOOLTIP_MARGIN, maximumLeft),
    top: clamp(pointer.y - ELECTERM_TOOLTIP_TOP_OFFSET, TOOLTIP_MARGIN, maximumTop),
  };
}
