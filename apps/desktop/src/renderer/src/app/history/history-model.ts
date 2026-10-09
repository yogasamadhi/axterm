import type { ConnectionHistoryItem } from '@workspace/contracts';
import type { AxtermMessageKey, Variables } from '../../i18n/core';
import { maskHostAddress } from '../privacy';

type Translate = (key: AxtermMessageKey, variables?: Variables) => string;

export function connectionHistoryTarget(
  item: ConnectionHistoryItem,
  hideAddresses = false,
): string {
  return `${item.username}@${hideAddresses ? maskHostAddress(item.hostname) : item.hostname}:${item.port}`;
}

export function connectionHistoryFrequency(item: ConnectionHistoryItem, x: Translate): string {
  return x(item.count === 1 ? 'history.connectionCountOne' : 'history.connectionCount', {
    count: item.count,
  });
}

export function connectionHistoryRelativeTime(
  value: string,
  x: Translate,
  now = Date.now(),
): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return x('history.unknownTime');
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return x('history.justNow');
  if (elapsed < 3_600_000) return x('history.minutesAgo', { count: Math.floor(elapsed / 60_000) });
  if (elapsed < 86_400_000)
    return x('history.hoursAgo', { count: Math.floor(elapsed / 3_600_000) });
  if (elapsed < 604_800_000)
    return x('history.daysAgo', { count: Math.floor(elapsed / 86_400_000) });
  return new Date(timestamp).toISOString().slice(0, 10);
}
