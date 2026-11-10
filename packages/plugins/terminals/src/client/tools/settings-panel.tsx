import { useState, useSyncExternalStore } from 'react';
import type { TranslateNS } from '@axterm/ui';
import type { ConfigurationClientActions, Settings } from '@axterm/plugin-api/configuration';
import type { RemoteMonitorItem, TerminalInformationGroupName } from '@axterm/plugin-api/terminals';
import {
  DEFAULT_REMOTE_MONITOR_ITEMS,
  DEFAULT_TERMINAL_INFORMATION_ITEMS,
} from '@axterm/plugin-api/terminals';
import type { TerminalMonitorCommands } from './preferences.ts';
import type { TerminalRecoveryCommands } from './recovery-preferences.ts';
import { cx } from './styles.ts';
type AxtermMessageKey = Parameters<TranslateNS<'terminals'>>[0];
type TerminalRecoverySettings = Settings['terminal'];
type MonitorSettings = Settings['monitor'];

const INFORMATION_LABEL_KEYS: Record<TerminalInformationGroupName, AxtermMessageKey> = {
  sysinfo: 'terminalRecovery.system',
  uptime: 'terminalRecovery.uptime',
  cpu: 'terminalRecovery.cpu',
  memory: 'terminalRecovery.memory',
  activities: 'terminalRecovery.activities',
  network: 'terminalRecovery.network',
  users: 'terminalRecovery.users',
  disks: 'terminalRecovery.disks',
};
const MONITOR_LABEL_KEYS: Record<RemoteMonitorItem, AxtermMessageKey> = {
  hostname: 'terminalRecovery.hostname',
  cpu: 'terminalRecovery.cpu',
  cpuHistory: 'terminalRecovery.cpuHistory',
  memory: 'terminalRecovery.memory',
  upload: 'terminalRecovery.uploadRate',
  download: 'terminalRecovery.downloadRate',
  uptime: 'terminalRecovery.uptime',
  users: 'terminalRecovery.users',
  disks: 'terminalRecovery.disks',
};

export function TerminalRecoverySettingsPanel({
  configuration,
  commands,
  recovery,
  x,
}: {
  configuration: ConfigurationClientActions;
  commands: TerminalMonitorCommands;
  recovery: TerminalRecoveryCommands;
  x: TranslateNS<'terminals'>;
}) {
  const current = useSyncExternalStore(configuration.subscribe, configuration.getSnapshot),
    monitor = useSyncExternalStore(commands.subscribe, commands.getSnapshot),
    terminal = useSyncExternalStore(recovery.subscribe, recovery.getSnapshot);
  const settings = { data: current.status === 'ready' ? current.baseline.settings : undefined },
    busy = monitor.busy || monitor.uncertain || terminal.busy || terminal.uncertain;
  const [error, setError] = useState('');
  async function update(patch: Partial<TerminalRecoverySettings>) {
    if (busy) return;
    setError('');
    try {
      await recovery.save(patch);
    } catch {
      setError(x('terminalRecovery.saveFailed'));
    }
  }
  async function updateMonitor(patch: Partial<MonitorSettings>) {
    if (!settings.data || busy) return;
    setError('');
    try {
      await commands.save({ ...settings.data.monitor, ...patch });
    } catch {
      setError(x('terminalRecovery.monitorSaveFailed'));
    }
  }
  return (
    <section
      className={cx('surface stack terminal-recovery-settings-panel')}
      aria-labelledby="terminal-recovery-settings-title"
    >
      <h3 id="terminal-recovery-settings-title">{x('terminalRecovery.title')}</h3>
      <p className={cx('hint')}>{x('terminalRecovery.description')}</p>
      <label className={cx('check')}>
        <input
          checked={settings.data?.terminal.autoReconnectTerminal ?? false}
          disabled={!settings.data || !!busy}
          onChange={(event) => void update({ autoReconnectTerminal: event.target.checked })}
          type="checkbox"
        />
        {x('terminalRecovery.autoReconnect')}
      </label>
      <label className={cx('check')}>
        <input
          checked={settings.data?.terminal.restoreTerminalSessionOnReload ?? false}
          disabled={!settings.data || !!busy}
          onChange={(event) =>
            void update({ restoreTerminalSessionOnReload: event.target.checked })
          }
          type="checkbox"
        />
        {x('terminalRecovery.restoreOnReload')}
      </label>
      <label className={cx('check')}>
        <input
          checked={settings.data?.terminal.shortcutBarEnabled ?? true}
          disabled={!settings.data || !!busy}
          onChange={(event) => void update({ shortcutBarEnabled: event.target.checked })}
          type="checkbox"
        />
        {x('terminalRecovery.shortcutBar')}
      </label>
      <label className={cx('check')}>
        <input
          checked={settings.data?.terminal.commandSuggestionsEnabled ?? false}
          disabled={!settings.data || !!busy}
          onChange={(event) => void update({ commandSuggestionsEnabled: event.target.checked })}
          type="checkbox"
        />
        {x('terminalRecovery.commandSuggestions')}
      </label>
      <label className={cx('field compact-field')}>
        <span>{x('terminalRecovery.dragDrop')}</span>
        <select
          value={settings.data?.terminal.dragDropBehavior ?? 'ask'}
          disabled={!settings.data || !!busy}
          onChange={(event) =>
            void update({
              dragDropBehavior: event.target.value as TerminalRecoverySettings['dragDropBehavior'],
            })
          }
        >
          <option value="ask">{x('terminalRecovery.dragAsk')}</option>
          <option value="upload">{x('terminalRecovery.dragUpload')}</option>
          <option value="path-insert">{x('terminalRecovery.dragPath')}</option>
        </select>
      </label>
      <fieldset className={cx('monitor-settings-group')}>
        <legend>{x('terminalRecovery.information')}</legend>
        <p className={cx('hint')}>{x('terminalRecovery.informationHint')}</p>
        <div className={cx('monitor-settings-options')}>
          {DEFAULT_TERMINAL_INFORMATION_ITEMS.map((item) => (
            <label className={cx('check')} key={item}>
              <input
                checked={settings.data?.monitor.terminalInformationItems.includes(item) ?? true}
                disabled={!settings.data || !!busy}
                onChange={(event) => {
                  const current = settings.data?.monitor.terminalInformationItems ?? [];
                  void updateMonitor({
                    terminalInformationItems: event.target.checked
                      ? [...current, item]
                      : current.filter((candidate) => candidate !== item),
                  });
                }}
                type="checkbox"
              />
              {x(INFORMATION_LABEL_KEYS[item])}
            </label>
          ))}
          <label className={cx('check')}>
            <input
              checked={settings.data?.monitor.terminalInformationItems.includes('users') ?? false}
              disabled={!settings.data || !!busy}
              onChange={(event) => {
                const current = settings.data?.monitor.terminalInformationItems ?? [];
                void updateMonitor({
                  terminalInformationItems: event.target.checked
                    ? [...current, 'users']
                    : current.filter((candidate) => candidate !== 'users'),
                });
              }}
              type="checkbox"
            />
            {x('terminalRecovery.users')}
          </label>
        </div>
      </fieldset>
      <fieldset className={cx('monitor-settings-group remote-monitor-setting')}>
        <legend>{x('terminalRecovery.remoteMonitor')}</legend>
        <label className={cx('check')}>
          <input
            checked={settings.data?.monitor.remoteMonitorBarEnabled ?? false}
            disabled={!settings.data || !!busy}
            onChange={(event) =>
              void updateMonitor({ remoteMonitorBarEnabled: event.target.checked })
            }
            type="checkbox"
          />
          {x('terminalRecovery.showRemoteMonitor')}
        </label>
        <div
          className={cx('monitor-settings-list')}
          aria-label={x('terminalRecovery.remoteMonitorItems')}
        >
          {(settings.data?.monitor.remoteMonitorBarItems ?? []).map((item, index, items) => (
            <div key={item}>
              <span>{x(MONITOR_LABEL_KEYS[item])}</span>
              <button
                aria-label={x('terminalRecovery.moveUp', { item: x(MONITOR_LABEL_KEYS[item]) })}
                disabled={!!busy || index === 0}
                onClick={() => {
                  const next = [...items];
                  [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                  void updateMonitor({ remoteMonitorBarItems: next });
                }}
                type="button"
              >
                ↑
              </button>
              <button
                aria-label={x('terminalRecovery.moveDown', { item: x(MONITOR_LABEL_KEYS[item]) })}
                disabled={!!busy || index === items.length - 1}
                onClick={() => {
                  const next = [...items];
                  [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                  void updateMonitor({ remoteMonitorBarItems: next });
                }}
                type="button"
              >
                ↓
              </button>
              <button
                aria-label={x('terminalRecovery.hideItem', { item: x(MONITOR_LABEL_KEYS[item]) })}
                disabled={!!busy}
                onClick={() =>
                  void updateMonitor({
                    remoteMonitorBarItems: items.filter((candidate) => candidate !== item),
                  })
                }
                type="button"
              >
                {x('terminalRecovery.hide')}
              </button>
            </div>
          ))}
        </div>
        <label className={cx('field compact-field')}>
          <span>{x('terminalRecovery.addMonitorItem')}</span>
          <select
            aria-label={x('terminalRecovery.addRemoteMonitorItem')}
            disabled={!settings.data || !!busy}
            value=""
            onChange={(event) => {
              const item = event.target.value as RemoteMonitorItem;
              if (!item) return;
              void updateMonitor({
                remoteMonitorBarItems: [
                  ...(settings.data?.monitor.remoteMonitorBarItems ?? []),
                  item,
                ],
              });
            }}
          >
            <option value="">{x('terminalRecovery.selectItem')}</option>
            {DEFAULT_REMOTE_MONITOR_ITEMS.filter(
              (item) => !settings.data?.monitor.remoteMonitorBarItems.includes(item),
            ).map((item) => (
              <option key={item} value={item}>
                {x(MONITOR_LABEL_KEYS[item])}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      {(monitor.uncertain || terminal.uncertain) && (
        <button
          type="button"
          onClick={() => {
            void Promise.all([
              ...(monitor.uncertain ? [commands.retry()] : []),
              ...(terminal.uncertain ? [recovery.retry()] : []),
            ]).catch(() => {});
          }}
        >
          {x('common.retry')}
        </button>
      )}
      {error && (
        <p className={cx('danger-text')} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
