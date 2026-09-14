import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type { RemoteMonitorItem, TerminalInformationSnapshot } from '@workspace/contracts';
import { AlertTriangle, BarChart3, Settings, X } from 'lucide-react';
import {
  compactDuration,
  formatBytes,
  formatRate,
  selectPrimaryInterface,
  sortedDisks,
  usageLevel,
  type RemoteMonitorLevel,
} from './remote-monitor-model';
import './remote-monitor-bar.css';
import { useI18n } from '../../i18n/context';
import type { AxtermMessageKey } from '../../i18n/core';

const LABEL_KEYS: Record<RemoteMonitorItem, AxtermMessageKey> = {
  hostname: 'remoteMonitor.hostname',
  cpu: 'remoteMonitor.cpu',
  cpuHistory: 'remoteMonitor.cpuHistory',
  memory: 'remoteMonitor.memory',
  upload: 'remoteMonitor.upload',
  download: 'remoteMonitor.download',
  uptime: 'remoteMonitor.uptime',
  users: 'remoteMonitor.users',
  disks: 'remoteMonitor.disks',
};

export function RemoteMonitorBar({
  client,
  visible,
  terminal,
  items,
  onOpenInformation,
  onOpenSettings,
  onDisable,
}: {
  client: ReturnType<typeof createRuntimeClient>;
  visible: boolean;
  terminal: { id: string; title: string; kind: string; disconnected?: boolean } | undefined;
  items: RemoteMonitorItem[];
  onOpenInformation(): void;
  onOpenSettings(): void;
  onDisable(): void;
}) {
  const { x } = useI18n();
  const [openId, setOpenId] = useState<RemoteMonitorItem>();
  const [pinnedId, setPinnedId] = useState<RemoteMonitorItem>();
  const query = useQuery({
    queryKey: ['terminal-information', terminal?.id],
    queryFn: ({ signal }) => client.terminalInformation(terminal!.id, signal),
    enabled: visible && terminal?.kind === 'ssh' && !terminal.disconnected,
    refetchInterval: visible && !terminal?.disconnected ? 5_000 : false,
    refetchIntervalInBackground: false,
  });

  if (!visible) return null;
  const snapshot = query.data;
  const cpuLevel = snapshot ? usageLevel(snapshot.groups.cpu.data) : 'unknown';
  const memoryLevel = snapshot ? usageLevel(snapshot.groups.memory.data?.percent) : 'unknown';

  function open(item: RemoteMonitorItem) {
    setOpenId(item);
    if (pinnedId && pinnedId !== item) setPinnedId(undefined);
  }

  function pin(item: RemoteMonitorItem) {
    if (pinnedId === item) {
      setPinnedId(undefined);
      setOpenId(undefined);
    } else {
      setPinnedId(item);
      setOpenId(item);
    }
  }

  return (
    <section
      aria-label={x('remoteMonitor.bar')}
      className="remote-monitor-bar"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpenId(undefined);
          setPinnedId(undefined);
        }
      }}
      onMouseLeave={() => {
        if (!pinnedId) setOpenId(undefined);
      }}
    >
      <div className="remote-monitor-scroll">
        {terminal?.disconnected ? (
          <span className="remote-monitor-message">{x('remoteMonitor.disconnected')}</span>
        ) : query.isPending ? (
          <span className="remote-monitor-message">{x('remoteMonitor.loading')}</span>
        ) : query.isError || !snapshot ? (
          <span className="remote-monitor-message">{x('remoteMonitor.unavailable')}</span>
        ) : items.length ? (
          items.map((item) => {
            const level = levelFor(item, snapshot, cpuLevel, memoryLevel);
            return (
              <button
                aria-label={x('remoteMonitor.itemSummary', {
                  label: x(LABEL_KEYS[item]),
                  summary: accessibleSummary(item, snapshot),
                  level: levelLabel(level, x),
                })}
                className={`remote-monitor-item remote-monitor-item-${item} remote-monitor-level-${level}`}
                data-monitor-item={item}
                key={item}
                onClick={() => pin(item)}
                onFocus={() => open(item)}
                onMouseEnter={() => open(item)}
                title={x(LABEL_KEYS[item])}
                type="button"
              >
                {(level === 'warning' || level === 'critical') && <AlertTriangle size={10} />}
                <MonitorSummary id={item} snapshot={snapshot} />
              </button>
            );
          })
        ) : (
          <span className="remote-monitor-message">{x('remoteMonitor.noItems')}</span>
        )}
      </div>
      <div className="remote-monitor-controls">
        <button
          aria-label={x('remoteMonitor.configure')}
          onClick={onOpenSettings}
          title={x('remoteMonitor.configure')}
        >
          <Settings size={12} />
        </button>
        <button
          aria-label={x('remoteMonitor.disable')}
          onClick={onDisable}
          title={x('remoteMonitor.disable')}
        >
          <X size={12} />
        </button>
      </div>
      {openId && snapshot && (
        <MonitorPopover
          id={openId}
          snapshot={snapshot}
          onClose={() => {
            setOpenId(undefined);
            setPinnedId(undefined);
          }}
          onOpenInformation={onOpenInformation}
        />
      )}
    </section>
  );
}

function MonitorSummary({
  id,
  snapshot,
}: {
  id: RemoteMonitorItem;
  snapshot: TerminalInformationSnapshot;
}) {
  const { x } = useI18n();
  if (id === 'hostname') return snapshot.groups.sysinfo.data?.hostname ?? '—';
  if (id === 'cpu') return <>CPU {percent(snapshot.groups.cpu.data)}</>;
  if (id === 'cpuHistory') return <Sparkline snapshot={snapshot} />;
  if (id === 'memory') {
    const memory = snapshot.groups.memory.data;
    return (
      <>
        {x('remoteMonitor.memoryShort')}{' '}
        {memory ? `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}` : '—'}
      </>
    );
  }
  if (id === 'upload' || id === 'download') {
    const primary = selectPrimaryInterface(snapshot);
    const rate = id === 'upload' ? primary?.transmitRate : primary?.receiveRate;
    return (
      <>
        {id === 'upload' ? '↑' : '↓'} {formatRate(rate)}
      </>
    );
  }
  if (id === 'uptime')
    return (
      <>
        {x('remoteMonitor.uptimeSummary', {
          value: compactDuration(snapshot.groups.uptime.data?.seconds),
        })}
      </>
    );
  if (id === 'users') {
    const users = snapshot.groups.users.data?.users ?? [];
    return (
      <>
        {x('remoteMonitor.usersSummary', {
          value: users.length
            ? `${users[0]}${users.length > 1 ? ` +${users.length - 1}` : ''}`
            : '0',
        })}
      </>
    );
  }
  const disks = sortedDisks(snapshot);
  return (
    <span className="remote-monitor-disk-summary">
      {disks.slice(0, 3).map((disk) => (
        <span key={disk.mount}>
          {disk.mount}:{Math.round(disk.percent)}%
        </span>
      ))}
      {disks.length > 3 && <span>+{disks.length - 3}</span>}
      {!disks.length && x('remoteMonitor.noDisk')}
    </span>
  );
}

function MonitorPopover({
  id,
  snapshot,
  onClose,
  onOpenInformation,
}: {
  id: RemoteMonitorItem;
  snapshot: TerminalInformationSnapshot;
  onClose(): void;
  onOpenInformation(): void;
}) {
  const { x } = useI18n();
  return (
    <div
      className="remote-monitor-popover"
      data-monitor-detail={id}
      role="dialog"
      aria-label={x('remoteMonitor.detail', { label: x(LABEL_KEYS[id]) })}
    >
      <header>
        <strong>{x(LABEL_KEYS[id])}</strong>
        <button aria-label={x('remoteMonitor.closeDetail')} onClick={onClose}>
          <X size={12} />
        </button>
      </header>
      <MonitorDetails id={id} snapshot={snapshot} />
      <button className="remote-monitor-open-information" onClick={onOpenInformation}>
        <BarChart3 size={12} /> {x('remoteMonitor.openTerminalInfo')}
      </button>
    </div>
  );
}

function MonitorDetails({
  id,
  snapshot,
}: {
  id: RemoteMonitorItem;
  snapshot: TerminalInformationSnapshot;
}) {
  const { language, x } = useI18n();
  if (id === 'hostname') {
    const system = snapshot.groups.sysinfo.data;
    return (
      <DetailList
        rows={[
          [x('remoteMonitor.hostname'), system?.hostname],
          [x('terminalInfo.system'), system?.os],
          [x('terminalInfo.kernel'), system?.kernel],
          [x('terminalInfo.architecture'), system?.arch],
          ['Shell', system?.shell],
        ]}
      />
    );
  }
  if (id === 'cpu' || id === 'cpuHistory') {
    const values = snapshot.cpuHistory.map(({ percent: value }) => value);
    return (
      <>
        <DetailList
          rows={[
            [x('remoteMonitor.current'), percent(snapshot.groups.cpu.data)],
            [
              x('remoteMonitor.average'),
              values.length
                ? percent(values.reduce((sum, value) => sum + value, 0) / values.length)
                : '—',
            ],
            [x('remoteMonitor.minimum'), values.length ? percent(Math.min(...values)) : '—'],
            [x('remoteMonitor.maximum'), values.length ? percent(Math.max(...values)) : '—'],
          ]}
        />
        <Sparkline snapshot={snapshot} large />
        {id === 'cpu' && <ActivityTable snapshot={snapshot} sort="cpu" />}
      </>
    );
  }
  if (id === 'memory') {
    const memory = snapshot.groups.memory.data;
    return (
      <>
        <DetailList
          rows={
            memory
              ? [
                  [
                    x('remoteMonitor.used'),
                    `${formatBytes(memory.usedBytes)} (${memory.percent.toFixed(1)}%)`,
                  ],
                  [x('remoteMonitor.available'), formatBytes(memory.availableBytes)],
                  [x('remoteMonitor.total'), formatBytes(memory.totalBytes)],
                  [
                    'Swap',
                    `${formatBytes(memory.swapUsedBytes)} / ${formatBytes(memory.swapTotalBytes)}`,
                  ],
                ]
              : []
          }
        />
        <ActivityTable snapshot={snapshot} sort="memory" />
      </>
    );
  }
  if (id === 'upload' || id === 'download') {
    const interfaces = snapshot.groups.network.data?.interfaces ?? [];
    return (
      <table>
        <thead>
          <tr>
            <th>{x('remoteMonitor.interface')}</th>
            <th>{x('remoteMonitor.address')}</th>
            <th>{x(id === 'upload' ? 'remoteMonitor.upload' : 'remoteMonitor.download')}</th>
            <th>{x('remoteMonitor.total')}</th>
          </tr>
        </thead>
        <tbody>
          {interfaces.map((entry) => (
            <tr key={entry.name}>
              <td>{entry.name}</td>
              <td>{entry.ipv4 ?? '—'}</td>
              <td>{formatRate(id === 'upload' ? entry.transmitRate : entry.receiveRate)}</td>
              <td>{formatBytes(id === 'upload' ? entry.transmittedBytes : entry.receivedBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (id === 'uptime') {
    const uptime = snapshot.groups.uptime.data;
    return (
      <DetailList
        rows={[
          [x('terminalInfo.runningFor'), compactDuration(uptime?.seconds)],
          [
            x('terminalInfo.bootedAt'),
            uptime?.bootTime ? new Date(uptime.bootTime).toLocaleString(language) : '—',
          ],
        ]}
      />
    );
  }
  if (id === 'users') {
    const sessions = snapshot.groups.users.data?.sessions ?? [];
    return sessions.length ? (
      <table>
        <thead>
          <tr>
            <th>{x('terminalInfo.user')}</th>
            <th>TTY</th>
            <th>{x('remoteMonitor.loginTime')}</th>
            <th>{x('remoteMonitor.source')}</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session, index) => (
            <tr key={`${session.username}:${session.terminal}:${index}`}>
              <td>{session.username}</td>
              <td>{session.terminal}</td>
              <td>{session.startedAt}</td>
              <td>{session.source ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <p className="remote-monitor-empty">{x('terminalInfo.noUsers')}</p>
    );
  }
  const disks = sortedDisks(snapshot);
  return (
    <table>
      <thead>
        <tr>
          <th>{x('remoteMonitor.mountPoint')}</th>
          <th>{x('remoteMonitor.usage')}</th>
          <th>{x('remoteMonitor.used')}</th>
          <th>{x('remoteMonitor.available')}</th>
          <th>{x('remoteMonitor.total')}</th>
        </tr>
      </thead>
      <tbody>
        {disks.map((disk) => (
          <tr key={`${disk.filesystem}:${disk.mount}`}>
            <td>{disk.mount}</td>
            <td>{disk.percent.toFixed(1)}%</td>
            <td>{formatBytes(disk.usedBytes)}</td>
            <td>{formatBytes(disk.availableBytes)}</td>
            <td>{formatBytes(disk.totalBytes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ActivityTable({
  snapshot,
  sort,
}: {
  snapshot: TerminalInformationSnapshot;
  sort: 'cpu' | 'memory';
}) {
  const { x } = useI18n();
  const rows = [...(snapshot.groups.activities.data ?? [])]
    .sort((left, right) =>
      sort === 'cpu' ? right.cpuPercent - left.cpuPercent : right.memoryBytes - left.memoryBytes,
    )
    .slice(0, 10);
  if (!rows.length) return null;
  return (
    <div className="remote-monitor-activity">
      <strong>{x('terminalInfo.activities')}</strong>
      <table>
        <thead>
          <tr>
            <th>PID</th>
            <th>{x('terminalInfo.user')}</th>
            <th>CPU</th>
            <th>{x('terminalInfo.memory')}</th>
            <th>{x('remoteMonitor.process')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((process) => (
            <tr key={process.pid}>
              <td>{process.pid}</td>
              <td>{process.username}</td>
              <td>{process.cpuPercent.toFixed(1)}%</td>
              <td>{formatBytes(process.memoryBytes)}</td>
              <td title={process.command}>{process.command}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailList({ rows }: { rows: Array<[string, string | undefined]> }) {
  return (
    <dl className="remote-monitor-details-list">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd title={value}>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

function Sparkline({
  snapshot,
  large = false,
}: {
  snapshot: TerminalInformationSnapshot;
  large?: boolean;
}) {
  const { x } = useI18n();
  const history = snapshot.cpuHistory;
  if (!history.length) return <span className="remote-monitor-empty">—</span>;
  const points = history
    .map(
      ({ percent: value }, index) =>
        `${history.length === 1 ? 0 : (index / (history.length - 1)) * 100},${20 - (value / 100) * 18}`,
    )
    .join(' ');
  return (
    <svg
      aria-label={x('remoteMonitor.cpuHistorySummary', {
        percent: Math.round(history.at(-1)!.percent),
      })}
      className={large ? 'remote-monitor-sparkline large' : 'remote-monitor-sparkline'}
      preserveAspectRatio="none"
      viewBox="0 0 100 20"
    >
      <polyline points={points} />
    </svg>
  );
}

function percent(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : `${value.toFixed(1)}%`;
}

function accessibleSummary(id: RemoteMonitorItem, snapshot: TerminalInformationSnapshot) {
  if (id === 'cpuHistory') return percent(snapshot.cpuHistory.at(-1)?.percent);
  const summary = id === 'hostname' ? snapshot.groups.sysinfo.data?.hostname : undefined;
  if (summary) return summary;
  if (id === 'cpu') return percent(snapshot.groups.cpu.data);
  if (id === 'memory') return percent(snapshot.groups.memory.data?.percent);
  if (id === 'uptime') return compactDuration(snapshot.groups.uptime.data?.seconds);
  if (id === 'users') return String(snapshot.groups.users.data?.users.length ?? 0);
  if (id === 'upload' || id === 'download') {
    const primary = selectPrimaryInterface(snapshot);
    return formatRate(id === 'upload' ? primary?.transmitRate : primary?.receiveRate);
  }
  return (
    sortedDisks(snapshot)
      .slice(0, 3)
      .map((disk) => `${disk.mount}: ${disk.percent}%`)
      .join(', ') || '—'
  );
}

function levelFor(
  id: RemoteMonitorItem,
  snapshot: TerminalInformationSnapshot,
  cpu: RemoteMonitorLevel,
  memory: RemoteMonitorLevel,
) {
  if (id === 'cpu' || id === 'cpuHistory')
    return snapshot.groups.cpu.state === 'ready' ? cpu : 'unknown';
  if (id === 'memory') return snapshot.groups.memory.state === 'ready' ? memory : 'unknown';
  if (id === 'disks') {
    if (snapshot.groups.disks.state !== 'ready') return 'unknown';
    return sortedDisks(snapshot).reduce<RemoteMonitorLevel>((level, disk) => {
      const next = usageLevel(disk.percent);
      const order = { unknown: -1, normal: 0, warning: 1, critical: 2 };
      return order[next] > order[level] ? next : level;
    }, 'normal');
  }
  return 'normal';
}

function levelLabel(level: RemoteMonitorLevel, x: ReturnType<typeof useI18n>['x']) {
  if (level === 'critical') return x('remoteMonitor.critical');
  if (level === 'warning') return x('remoteMonitor.warning');
  if (level === 'unknown') return x('remoteMonitor.unknown');
  return x('remoteMonitor.normal');
}
