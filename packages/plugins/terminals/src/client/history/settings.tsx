import { useState, useSyncExternalStore } from 'react';
import type { TranslateNS } from '@axterm/ui';
import type { ConfigurationClientActions } from '@axterm/plugin-api/configuration';
import type { TerminalHistoryCommands } from './commands.ts';
import styles from './history.module.css';
const cx = (value: string) =>
  value
    .split(/\s+/u)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
export function CommandHistorySettingsPanel({
  configuration,
  commands,
  x,
}: {
  configuration: ConfigurationClientActions;
  commands: TerminalHistoryCommands;
  x: TranslateNS<'terminals'>;
}) {
  const state = useSyncExternalStore(configuration.subscribe, configuration.getSnapshot),
    command = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const settings = { data: state.status === 'ready' ? state.baseline.settings : undefined };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function setEnabled(enabled: boolean) {
    if (!settings.data || busy) return;
    setBusy(true);
    setError('');
    try {
      await commands.setEnabled(enabled);
      if (commands.getSnapshot().failed) throw Error(x('commandHistory.saveError'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : x('commandHistory.saveError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={cx('surface stack')} aria-labelledby="command-history-settings-title">
      <h3 id="command-history-settings-title">{x('commandHistory.title')}</h3>
      <p className={cx('hint')}>{x('commandHistory.description')}</p>
      <label className={cx('check')}>
        <input
          checked={settings.data?.privacy.commandHistoryEnabled ?? false}
          disabled={!settings.data || busy || command.busy || command.uncertain}
          onChange={(event) => void setEnabled(event.target.checked)}
          type="checkbox"
        />
        {x('commandHistory.enabled')}
      </label>
      {command.uncertain && <button onClick={() => void commands.retry()}>{x('retry')}</button>}
      {error && (
        <p className={cx('danger-text')} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
