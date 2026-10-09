import { describe, expect, it } from 'vitest';
import type { TerminalInformationSnapshot } from '../../packages/contracts/src';
import {
  compactDuration,
  EMPTY_MONITOR_PRESSURE,
  formatBytes,
  formatRate,
  monitorPressure,
  sortedDisks,
  usageLevel,
} from '../../apps/desktop/src/renderer/src/app/remote-monitor/remote-monitor-model';

const sampledAt = '2026-09-25T00:00:00.000Z';
const ready = <T>(data: T) => ({
  state: 'ready' as const,
  updatedAt: sampledAt,
  errorCode: null,
  data,
});
const unsupported = { state: 'unsupported' as const, updatedAt: null, errorCode: null, data: null };

function snapshot(
  terminalId: string,
  sample: string,
  cpu: number,
  memory: number,
  rootPercent: number,
): TerminalInformationSnapshot {
  return {
    terminalId,
    kind: 'ssh',
    sampledAt: sample,
    cpuHistory: [],
    groups: {
      sysinfo: unsupported,
      cpu: ready(cpu),
      memory: ready({
        totalBytes: 1_000,
        availableBytes: 1_000 - memory * 10,
        usedBytes: memory * 10,
        swapTotalBytes: null,
        swapUsedBytes: null,
        percent: memory,
      }),
      uptime: unsupported,
      users: unsupported,
      network: unsupported,
      disks: ready([
        {
          filesystem: 'rootfs',
          mount: '/',
          totalBytes: 1_000,
          usedBytes: rootPercent * 10,
          availableBytes: 1_000 - rootPercent * 10,
          percent: rootPercent,
        },
        {
          filesystem: 'datafs',
          mount: '/data',
          totalBytes: 1_000,
          usedBytes: 400,
          availableBytes: 600,
          percent: 40,
        },
      ]),
      activities: unsupported,
    },
  };
}

describe('remote monitor presentation model', () => {
  it('uses resource-specific pressure and five-point recovery bands', () => {
    expect(usageLevel(84, 'normal', 'cpu')).toBe('normal');
    expect(usageLevel(85, 'normal', 'cpu')).toBe('warning');
    expect(usageLevel(95, 'warning', 'cpu')).toBe('critical');
    expect(usageLevel(90, 'critical', 'cpu')).toBe('critical');
    expect(usageLevel(89, 'critical', 'cpu')).toBe('warning');
    expect(usageLevel(79, 'warning', 'cpu')).toBe('normal');
    expect(usageLevel(92, 'normal', 'memory')).toBe('critical');
    expect(usageLevel(75, 'normal', 'disk')).toBe('warning');
    expect(usageLevel(101, 'critical', 'disk')).toBe('unknown');
  });

  it('tracks hysteresis per terminal and per disk, resetting on disconnect', () => {
    const first = monitorPressure(
      snapshot('ssh-a', sampledAt, 95, 92, 90),
      EMPTY_MONITOR_PRESSURE,
      true,
    );
    expect(first).toMatchObject({ cpu: 'critical', memory: 'critical', disk: 'critical' });
    expect(monitorPressure(snapshot('ssh-a', sampledAt, 1, 1, 1), first, true)).toBe(first);

    const second = monitorPressure(
      snapshot('ssh-a', '2026-09-25T00:00:05.000Z', 91, 88, 86),
      first,
      true,
    );
    expect(second).toMatchObject({ cpu: 'critical', memory: 'critical', disk: 'critical' });
    const third = monitorPressure(
      snapshot('ssh-a', '2026-09-25T00:00:10.000Z', 89, 86, 84),
      second,
      true,
    );
    expect(third).toMatchObject({ cpu: 'warning', memory: 'warning', disk: 'warning' });
    const otherTerminal = monitorPressure(snapshot('ssh-b', sampledAt, 91, 88, 86), second, true);
    expect(otherTerminal).toMatchObject({ cpu: 'warning', memory: 'warning', disk: 'warning' });
    expect(monitorPressure(undefined, third, false)).toBe(EMPTY_MONITOR_PRESSURE);
  });

  it('shows the fullest disks first without mutating the snapshot', () => {
    const current = snapshot('ssh-a', sampledAt, 50, 50, 30);
    expect(sortedDisks(current).map(({ mount }) => mount)).toEqual(['/data', '/']);
    expect(current.groups.disks.data?.map(({ mount }) => mount)).toEqual(['/', '/data']);
  });

  it('formats compact bounded summaries', () => {
    expect(formatBytes(1_536)).toBe('1.5 KiB');
    expect(formatBytes(1_024 ** 2 * 1.25)).toBe('1.3 MiB');
    expect(formatBytes(0.5)).toBe('<1 B');
    expect(formatBytes(null)).toBe('—');
    expect(formatRate(-1)).toBe('—');
    expect(compactDuration(90_061)).toBe('1d 1h');
    expect(compactDuration(61)).toBe('1m 1s');
  });
});
