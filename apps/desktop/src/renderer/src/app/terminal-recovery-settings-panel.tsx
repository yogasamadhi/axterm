import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type {
  RemoteMonitorItem,
  Settings,
  TerminalInformationGroupName,
} from '@workspace/contracts';
import { useI18n } from '../i18n/context';
import type { AxtermMessageKey } from '../i18n/core';
import {
  DEFAULT_REMOTE_MONITOR_ITEMS,
  DEFAULT_TERMINAL_INFORMATION_ITEMS,
} from '@workspace/contracts';

type Client = ReturnType<typeof createRuntimeClient>;
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

export function TerminalRecoverySettingsPanel({ client }: { client: Client }) {
  const { x } = useI18n();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: client.settings });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');

  async function update(patch: Partial<TerminalRecoverySettings>) {
    if (!settings.data || busy) return;
    const key = Object.keys(patch)[0] as keyof TerminalRecoverySettings | undefined;
    if (!key) return;
    setBusy(key);
    setError('');
    try {
      const next = await client.updateSettings(settings.data, { terminal: patch });
      queryClient.setQueryData(['settings'], next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : x('terminalRecovery.saveFailed'));
    } finally {
      setBusy(undefined);
    }
  }

  async function updateMonitor(patch: Partial<MonitorSettings>) {
    if (!settings.data || busy) return;
    const key = Object.keys(patch)[0];
    if (!key) return;
    setBusy(key);
    setError('');
    try {
      const next = await client.updateSettings(settings.data, { monitor: patch });
      queryClient.setQueryData(['settings'], next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : x('terminalRecovery.monitorSaveFailed'));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section
      className="surface stack terminal-recovery-settings-panel"
      aria-labelledby="terminal-recovery-settings-title"
    >
      <h3 id="terminal-recovery-settings-title">{x('terminalRecovery.title')}</h3>
      <p className="hint">{x('terminalRecovery.description')}</p>
      <label className="check">
        <input
          checked={settings.data?.terminal.autoReconnectTerminal ?? false}
          disabled={!settings.data || !!busy}
          onChange={(event) => void update({ autoReconnectTerminal: event.target.checked })}
          type="checkbox"
        />
        {x('terminalRecovery.autoReconnect')}
      </label>
      <label className="check">
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
      <label className="check">
        <input
          checked={settings.data?.terminal.shortcutBarEnabled ?? true}
          disabled={!settings.data || !!busy}
          onChange={(event) => void update({ shortcutBarEnabled: event.target.checked })}
          type="checkbox"
        />
        {x('terminalRecovery.shortcutBar')}
      </label>
      <label className="check">
        <input
          checked={settings.data?.terminal.commandSuggestionsEnabled ?? false}
          disabled={!settings.data || !!busy}
          onChange={(event) => void update({ commandSuggestionsEnabled: event.target.checked })}
          type="checkbox"
        />
        {x('terminalRecovery.commandSuggestions')}
      </label>
      <label className="field compact-field">
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
      <fieldset className="monitor-settings-group">
        <legend>{x('terminalRecovery.information')}</legend>
        <p className="hint">{x('terminalRecovery.informationHint')}</p>
        <div className="monitor-settings-options">
          {DEFAULT_TERMINAL_INFORMATION_ITEMS.map((item) => (
            <label className="check" key={item}>
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
          <label className="check">
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
      <fieldset className="monitor-settings-group remote-monitor-setting">
        <legend>{x('terminalRecovery.remoteMonitor')}</legend>
        <label className="check">
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
          className="monitor-settings-list"
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
        <label className="field compact-field">
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
      {error && (
        <p className="danger-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
