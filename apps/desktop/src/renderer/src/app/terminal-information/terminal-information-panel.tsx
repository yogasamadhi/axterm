import { useQuery } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type {
  TerminalInformationGroupName,
  TerminalInformationSnapshot,
} from '@workspace/contracts';
import { DEFAULT_TERMINAL_INFORMATION_ITEMS } from '@workspace/contracts';
import {
  Activity,
  Check,
  Cpu,
  Filter,
  Gauge,
  HardDrive,
  MemoryStick,
  Network,
  RefreshCw,
  Server,
  Users,
  X,
} from 'lucide-react';
import './terminal-information-panel.css';
import { useI18n } from '../../i18n/context';
import type { AxtermMessageKey } from '../../i18n/core';

const ITEMS: Array<{
  id: TerminalInformationGroupName;
  labelKey: AxtermMessageKey;
  icon: typeof Activity;
}> = [
  { id: 'sysinfo', labelKey: 'terminalInfo.system', icon: Server },
  { id: 'uptime', labelKey: 'terminalInfo.uptime', icon: Gauge },
  { id: 'cpu', labelKey: 'terminalInfo.cpu', icon: Cpu },
  { id: 'memory', labelKey: 'terminalInfo.memory', icon: MemoryStick },
  { id: 'activities', labelKey: 'terminalInfo.activities', icon: Activity },
  { id: 'network', labelKey: 'terminalInfo.network', icon: Network },
  { id: 'users', labelKey: 'terminalInfo.users', icon: Users },
  { id: 'disks', labelKey: 'terminalInfo.disks', icon: HardDrive },
];
export function TerminalInformationPanel({
  client,
  open,
  terminal,
  selectedItems = [...DEFAULT_TERMINAL_INFORMATION_ITEMS],
  onSelectedItemsChange,
  onClose,
}: {
  client: ReturnType<typeof createRuntimeClient>;
  open: boolean;
  terminal:
    | {
        id: string;
        title: string;
        kind: string;
        disconnected?: boolean;
      }
    | undefined;
  selectedItems?: TerminalInformationGroupName[];
  onSelectedItemsChange?(items: TerminalInformationGroupName[]): void;
  onClose(): void;
}) {
  const { x } = useI18n();
  const selected = new Set(selectedItems);
  const eligible = terminal?.kind === 'local' || terminal?.kind === 'ssh';
  const query = useQuery({
    queryKey: ['terminal-information', terminal?.id],
    queryFn: ({ signal }) => client.terminalInformation(terminal!.id, signal),
    enabled: open && eligible && !terminal?.disconnected,
    refetchInterval: open && terminal?.kind === 'ssh' ? 5_000 : false,
    refetchIntervalInBackground: false,
  });

  if (!open) return null;
  const snapshot = query.data;
  return (
    <aside className="terminal-information-panel" aria-label={x('terminalInfo.title')}>
      <header>
        <span>
          <Activity size={14} /> {x('terminalInfo.title')}
        </span>
        <div>
          <button
            aria-label={x('terminalInfo.refresh')}
            disabled={!eligible || !!terminal?.disconnected || query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw size={13} className={query.isFetching ? 'spinning' : ''} />
          </button>
          <button aria-label={x('terminalInfo.close')} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </header>
      <div className="terminal-information-body">
        <section className="terminal-information-base">
          <strong>{terminal?.title ?? x('terminalInfo.noTerminal')}</strong>
          <span>ID: {terminal?.id ?? '—'}</span>
          <span>{x('terminalInfo.type', { type: terminal?.kind?.toUpperCase() ?? '—' })}</span>
          <details className="terminal-information-filter">
            <summary>
              <Filter size={12} />{' '}
              {x('terminalInfo.filter', { selected: selected.size, total: ITEMS.length })}
            </summary>
            <div role="menu" aria-label={x('terminalInfo.filterMenu')}>
              {ITEMS.map(({ id, labelKey }) => (
                <button
                  aria-checked={selected.has(id)}
                  key={id}
                  role="menuitemcheckbox"
                  onClick={() => {
                    const next = new Set(selected);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    onSelectedItemsChange?.(
                      ITEMS.map((item) => item.id).filter((item) => next.has(item)),
                    );
                  }}
                >
                  <span>{selected.has(id) ? <Check size={11} /> : null}</span>
                  {x(labelKey)}
                </button>
              ))}
            </div>
          </details>
        </section>

        {!terminal && <PanelMessage>{x('terminalInfo.selectTerminal')}</PanelMessage>}
        {terminal?.disconnected && <PanelMessage>{x('terminalInfo.disconnected')}</PanelMessage>}
        {terminal && !eligible && (
          <PanelMessage>{x('terminalInfo.unsupportedSession')}</PanelMessage>
        )}
        {query.isPending && eligible && !terminal?.disconnected && (
          <PanelMessage>{x('terminalInfo.loading')}</PanelMessage>
        )}
        {query.isError && <PanelMessage>{x('terminalInfo.loadFailed')}</PanelMessage>}

        {snapshot &&
          ITEMS.filter(({ id }) => selected.has(id)).map(({ id, labelKey, icon: Icon }) => (
            <InformationSection
              key={id}
              title={x(labelKey)}
              icon={<Icon size={13} />}
              snapshot={snapshot}
              id={id}
            />
          ))}
      </div>
    </aside>
  );
}

function InformationSection({
  id,
  title,
  icon,
  snapshot,
}: {
  id: TerminalInformationGroupName;
  title: string;
  icon: React.ReactNode;
  snapshot: TerminalInformationSnapshot;
}) {
  const { x } = useI18n();
  const group = snapshot.groups[id];
  return (
    <section className="terminal-information-section" data-information-group={id}>
      <header>
        <span>
          {icon} {title}
        </span>
        <small className={`information-state ${group.state}`}>{stateLabel(group.state, x)}</small>
      </header>
      {group.data === null ? (
        <p className="terminal-information-empty">
          {group.state === 'unsupported'
            ? x('terminalInfo.groupUnsupported')
            : x('terminalInfo.dataUnavailable')}
        </p>
      ) : (
        <InformationData id={id} snapshot={snapshot} />
      )}
    </section>
  );
}

function InformationData({
  id,
  snapshot,
}: {
  id: TerminalInformationGroupName;
  snapshot: TerminalInformationSnapshot;
}) {
  const { language, x } = useI18n();
  if (id === 'sysinfo') {
    const value = snapshot.groups.sysinfo.data!;
    return (
      <dl className="terminal-information-grid">
        <InfoValue label={x('terminalInfo.host')} value={value.hostname} />
        <InfoValue label={x('terminalInfo.system')} value={value.os} />
        <InfoValue label={x('terminalInfo.kernel')} value={value.kernel} />
        <InfoValue label={x('terminalInfo.architecture')} value={value.arch} />
        <InfoValue label="Shell" value={value.shell || '—'} />
      </dl>
    );
  }
  if (id === 'cpu') {
    const value = snapshot.groups.cpu.data!;
    return (
      <>
        <UsageMeter value={value} label={`CPU ${Math.round(value)}%`} />
        <CpuSparkline history={snapshot.cpuHistory.map(({ percent }) => percent)} />
      </>
    );
  }
  if (id === 'memory') {
    const value = snapshot.groups.memory.data!;
    return (
      <>
        <UsageMeter
          value={value.percent}
          label={x('terminalInfo.usedPercent', { percent: Math.round(value.percent) })}
        />
        <p>
          {formatBytes(value.usedBytes)} / {formatBytes(value.totalBytes)}
        </p>
        {value.swapTotalBytes !== null && (
          <small>
            Swap {formatBytes(value.swapUsedBytes)} / {formatBytes(value.swapTotalBytes)}
          </small>
        )}
      </>
    );
  }
  if (id === 'uptime') {
    const value = snapshot.groups.uptime.data!;
    return (
      <dl className="terminal-information-grid">
        <InfoValue label={x('terminalInfo.runningFor')} value={formatDuration(value.seconds, x)} />
        <InfoValue
          label={x('terminalInfo.bootedAt')}
          value={value.bootTime ? new Date(value.bootTime).toLocaleString(language) : '—'}
        />
      </dl>
    );
  }
  if (id === 'users') {
    const value = snapshot.groups.users.data!;
    return value.sessions.length ? (
      <div className="terminal-information-list">
        {value.sessions.map((session, index) => (
          <span key={`${session.username}:${session.terminal}:${index}`}>
            <b>{session.username}</b>
            <small>
              {session.terminal} · {session.startedAt}
              {session.source ? ` · ${session.source}` : ''}
            </small>
          </span>
        ))}
      </div>
    ) : (
      <p>{x('terminalInfo.noUsers')}</p>
    );
  }
  if (id === 'network') {
    const value = snapshot.groups.network.data!;
    return (
      <div className="terminal-information-list">
        {value.interfaces.map((entry) => (
          <span key={entry.name}>
            <b>
              {entry.name}
              {entry.name === value.defaultInterface
                ? x('terminalInfo.defaultInterfaceSuffix')
                : ''}
            </b>
            <small>{entry.ipv4 ?? entry.state ?? '—'}</small>
            <small>
              ↑ {formatRate(entry.transmitRate)} · ↓ {formatRate(entry.receiveRate)}
            </small>
          </span>
        ))}
      </div>
    );
  }
  if (id === 'disks') {
    return (
      <div className="terminal-information-list">
        {snapshot.groups.disks.data!.map((disk) => (
          <span key={`${disk.filesystem}:${disk.mount}`}>
            <b>{disk.mount}</b>
            <UsageMeter
              value={disk.percent}
              label={`${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}`}
            />
          </span>
        ))}
      </div>
    );
  }
  return (
    <div
      className="terminal-information-activities"
      role="table"
      aria-label={x('terminalInfo.activities')}
    >
      <div role="row">
        <b>PID</b>
        <b>{x('terminalInfo.user')}</b>
        <b>CPU</b>
        <b>{x('terminalInfo.memoryCommand')}</b>
      </div>
      {snapshot.groups.activities.data!.slice(0, 20).map((process) => (
        <div role="row" key={process.pid}>
          <span>{process.pid}</span>
          <span>{process.username}</span>
          <span>{process.cpuPercent.toFixed(1)}%</span>
          <span title={process.command}>
            {formatBytes(process.memoryBytes)} · {process.command}
          </span>
        </div>
      ))}
    </div>
  );
}

function InfoValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function UsageMeter({ value, label }: { value: number; label: string }) {
  const level = value >= 90 ? 'critical' : value >= 80 ? 'warning' : 'normal';
  return (
    <div className={`terminal-information-meter ${level}`} aria-label={label}>
      <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      <span>{label}</span>
    </div>
  );
}

function CpuSparkline({ history }: { history: number[] }) {
  const { x } = useI18n();
  if (history.length < 2) return null;
  const points = history
    .map((value, index) => `${(index / (history.length - 1)) * 100},${30 - (value / 100) * 28}`)
    .join(' ');
  return (
    <svg
      className="terminal-information-sparkline"
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      aria-label={x('terminalInfo.cpuHistory')}
    >
      <polyline points={points} />
    </svg>
  );
}

function PanelMessage({ children }: { children: React.ReactNode }) {
  return <p className="terminal-information-message">{children}</p>;
}

function stateLabel(
  state: 'ready' | 'stale' | 'unsupported' | 'error',
  x: ReturnType<typeof useI18n>['x'],
) {
  if (state === 'ready') return x('terminalInfo.live');
  if (state === 'stale') return x('terminalInfo.stale');
  if (state === 'unsupported') return x('terminalInfo.unsupported');
  return x('terminalInfo.failed');
}

function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value;
  let index = 0;
  while (scaled >= 1_024 && index < units.length - 1) {
    scaled /= 1_024;
    index += 1;
  }
  return `${scaled >= 10 || index === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[index]}`;
}

function formatRate(value: number | null) {
  return value === null ? '—' : `${formatBytes(value)}/s`;
}

function formatDuration(input: number, x: ReturnType<typeof useI18n>['x']) {
  let seconds = Math.max(0, Math.floor(input));
  const days = Math.floor(seconds / 86_400);
  seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  return [
    days ? x('terminalInfo.days', { count: days }) : '',
    hours ? x('terminalInfo.hours', { count: hours }) : '',
    minutes ? x('terminalInfo.minutes', { count: minutes }) : '',
    x('terminalInfo.seconds', { count: seconds }),
  ]
    .filter(Boolean)
    .join(' ');
}
