import type { TerminalInformationSnapshot } from '@workspace/contracts';

export type RemoteMonitorLevel = 'normal' | 'warning' | 'critical' | 'unknown';
export type MonitoredResource = 'cpu' | 'memory' | 'disk';
export type MonitorPressureState = {
  terminalId: string | null;
  sampledAt: string | null;
  cpu: RemoteMonitorLevel;
  memory: RemoteMonitorLevel;
  disks: ReadonlyMap<string, RemoteMonitorLevel>;
  disk: RemoteMonitorLevel;
};

// Different resources need different headroom: sustained CPU load is less urgent
// than a nearly full disk. A five-point recovery band prevents color flicker.
const PRESSURE_LIMITS: Record<MonitoredResource, { warning: number; critical: number }> = {
  cpu: { warning: 85, critical: 95 },
  memory: { warning: 80, critical: 92 },
  disk: { warning: 75, critical: 90 },
};
const RECOVERY_BAND = 5;
const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;
export const EMPTY_MONITOR_PRESSURE: MonitorPressureState = {
  terminalId: null,
  sampledAt: null,
  cpu: 'unknown',
  memory: 'unknown',
  disks: new Map(),
  disk: 'unknown',
};

export function usageLevel(
  value: number | null | undefined,
  previous: RemoteMonitorLevel = 'normal',
  resource: MonitoredResource = 'cpu',
): RemoteMonitorLevel {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0 || value > 100)
    return 'unknown';

  const { warning, critical } = PRESSURE_LIMITS[resource];
  const criticalExit = previous === 'critical' ? critical - RECOVERY_BAND : critical;
  const warningExit =
    previous === 'warning' || previous === 'critical' ? warning - RECOVERY_BAND : warning;
  if (value >= criticalExit) return 'critical';
  if (value >= warningExit) return 'warning';
  return 'normal';
}

export function monitorPressure(
  snapshot: TerminalInformationSnapshot | undefined,
  previous: MonitorPressureState,
  active: boolean,
): MonitorPressureState {
  if (!active || !snapshot) return EMPTY_MONITOR_PRESSURE;
  if (previous.terminalId === snapshot.terminalId && previous.sampledAt === snapshot.sampledAt)
    return previous;

  const sameTerminal = previous.terminalId === snapshot.terminalId;
  const disks = new Map<string, RemoteMonitorLevel>();
  let disk: RemoteMonitorLevel = 'unknown';
  if (snapshot.groups.disks.state === 'ready' && snapshot.groups.disks.data) {
    disk = 'normal';
    for (const entry of snapshot.groups.disks.data) {
      const key = `${entry.filesystem}\0${entry.mount}`;
      const level = usageLevel(
        entry.percent,
        sameTerminal ? previous.disks.get(key) : undefined,
        'disk',
      );
      disks.set(key, level);
      if (level === 'critical' || (level === 'warning' && disk === 'normal')) disk = level;
    }
  }
  return {
    terminalId: snapshot.terminalId,
    sampledAt: snapshot.sampledAt,
    cpu:
      snapshot.groups.cpu.state === 'ready'
        ? usageLevel(snapshot.groups.cpu.data, sameTerminal ? previous.cpu : undefined, 'cpu')
        : 'unknown',
    memory:
      snapshot.groups.memory.state === 'ready'
        ? usageLevel(
            snapshot.groups.memory.data?.percent,
            sameTerminal ? previous.memory : undefined,
            'memory',
          )
        : 'unknown',
    disks,
    disk,
  };
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
  if (value > 0 && value < 1) return '<1 B';
  const magnitude =
    value === 0
      ? 0
      : Math.max(0, Math.min(Math.floor(Math.log2(value) / 10), BYTE_UNITS.length - 1));
  const amount = value / 1_024 ** magnitude;
  const formatter = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: magnitude === 0 || amount >= 10 ? 0 : 1,
  });
  return `${formatter.format(amount)} ${BYTE_UNITS[magnitude]}`;
}

export function formatRate(value: number | null | undefined): string {
  const bytes = formatBytes(value);
  return bytes === '—' ? bytes : `${bytes}/s`;
}

export function compactDuration(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '—';
  const wholeSeconds = Math.floor(value);
  const components = [
    { suffix: 'd', seconds: 86_400 },
    { suffix: 'h', seconds: 3_600 },
    { suffix: 'm', seconds: 60 },
    { suffix: 's', seconds: 1 },
  ];
  const first = components.findIndex(({ seconds }) => wholeSeconds >= seconds);
  if (first < 0) return '0s';
  let remainder = wholeSeconds;
  const parts: string[] = [];
  for (const { suffix, seconds } of components.slice(first, first + 2)) {
    const count = Math.floor(remainder / seconds);
    parts.push(`${count}${suffix}`);
    remainder %= seconds;
  }
  return parts.join(' ');
}

export function sortedDisks(snapshot: TerminalInformationSnapshot) {
  return [...(snapshot.groups.disks.data ?? [])].sort(
    (left, right) => right.percent - left.percent || left.mount.localeCompare(right.mount),
  );
}
