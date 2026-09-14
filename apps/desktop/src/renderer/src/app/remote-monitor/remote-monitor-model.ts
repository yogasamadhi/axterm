import type { TerminalInformationSnapshot } from '@workspace/contracts';

export type RemoteMonitorLevel = 'normal' | 'warning' | 'critical' | 'unknown';

export function usageLevel(
  value: number | null | undefined,
  previous: RemoteMonitorLevel = 'normal',
): RemoteMonitorLevel {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0)
    return 'unknown';
  if (previous === 'critical') {
    if (value >= 85) return 'critical';
    if (value >= 80) return 'warning';
    return 'normal';
  }
  if (previous === 'warning') {
    if (value >= 90) return 'critical';
    if (value >= 75) return 'warning';
    return 'normal';
  }
  if (value >= 90) return 'critical';
  if (value >= 80) return 'warning';
  return 'normal';
}

export function selectPrimaryInterface(snapshot: TerminalInformationSnapshot) {
  const network = snapshot.groups.network.data;
  if (!network) return undefined;
  return (
    network.interfaces.find(({ name }) => name === network.defaultInterface) ??
    network.interfaces.find(({ state }) => state === 'up') ??
    network.interfaces[0]
  );
}

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let scaled = value;
  let index = 0;
  while (scaled >= 1_024 && index < units.length - 1) {
    scaled /= 1_024;
    index += 1;
  }
  const digits = index === 0 || scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits).replace(/(\.\d*?[1-9])0+$|\.0+$/u, '$1')} ${units[index]}`;
}

export function formatRate(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${formatBytes(value)}/s`;
}

export function compactDuration(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '—';
  let seconds = Math.floor(value);
  const days = Math.floor(seconds / 86_400);
  seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  if (days) return `${days}d ${String(hours).padStart(2, '0')}h`;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export function sortedDisks(snapshot: TerminalInformationSnapshot) {
  const priority = ['/', '/home', '/var', '/data'];
  return [...(snapshot.groups.disks.data ?? [])].sort((left, right) => {
    const leftIndex = priority.indexOf(left.mount);
    const rightIndex = priority.indexOf(right.mount);
    return (
      (leftIndex < 0 ? priority.length : leftIndex) -
        (rightIndex < 0 ? priority.length : rightIndex) || left.mount.localeCompare(right.mount)
    );
  });
}
