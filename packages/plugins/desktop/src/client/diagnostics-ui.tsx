import type { Context } from '@deepseek-ai/cordis';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PropsLocale } from '@axterm/ui';
import type { DesktopDiagnosticsModel } from './diagnostics-model.ts';
import type { DiagnosticExportCommands } from './diagnostics-commands.ts';
import { dictionaries } from './diagnostics-locales.ts';
import styles, { cssText } from './diagnostics.module.css';
const cx = (value: string) =>
  value
    .split(/\s+/u)
    .map((name) => `${name} ${styles[name] ?? ''}`)
    .join(' ');
type Translate = PropsLocale<'desktopDiagnostics'>['t'];
function DiagnosticsPanel({
  model,
  commands,
  t,
}: {
  model: DesktopDiagnosticsModel;
  commands: DiagnosticExportCommands;
  t: Translate;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className={cx('surface settings-advanced-diagnostics')}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>{t('settings.advancedTitle')}</summary>
      {expanded && <DiagnosticsContent model={model} commands={commands} t={t} />}
    </details>
  );
}
function DiagnosticsContent({
  model,
  commands,
  t,
}: {
  model: DesktopDiagnosticsModel;
  commands: DiagnosticExportCommands;
  t: Translate;
}) {
  const facts = useSyncExternalStore(model.subscribe, model.getSnapshot),
    command = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const [failed, setFailed] = useState(false);
  useEffect(() => model.acquire(), [model]);
  const data = facts.status === 'ready' ? facts.baseline.diagnostics : undefined;
  async function write() {
    setFailed(false);
    try {
      if (command.uncertain) await commands.retry();
      else await commands.export();
    } catch {
      setFailed(true);
    }
  }
  return (
    <div className={cx('stack settings-diagnostics-content')}>
      <p className="hint">{t('settings.advancedDescription')}</p>
      {facts.status === 'connecting' && <p role="status">{t('settings.updaterLoading')}</p>}
      {facts.status === 'error' && (
        <div role="alert" className="stack">
          <p>{t('settings.diagnosticsLoadFailed')}</p>
          <button type="button" onClick={() => model.retry()}>
            {t('settings.diagnosticsRetry')}
          </button>
        </div>
      )}
      {data && (
        <div className={cx('diagnostic-grid')}>
          <Metric label={t('settings.database')} value={data.database} />
          <Metric
            label={t('settings.uptime')}
            value={t('settings.uptimeSeconds', { seconds: Math.round(data.uptimeSeconds) })}
          />
          {Object.entries(data.resources).map(([key, value]) => (
            <Metric key={key} label={key} value={String(value)} />
          ))}
        </div>
      )}
      <button
        type="button"
        disabled={command.busy || facts.status !== 'ready'}
        aria-busy={command.busy}
        onClick={() => void write()}
      >
        {t(command.uncertain ? 'settings.diagnosticsCheckOutcome' : 'settings.exportDiagnostics')}
      </button>
      {command.uncertain && <p role="alert">{t('settings.diagnosticsUncertain')}</p>}
      {failed && !command.uncertain && <p role="alert">{t('settings.diagnosticsExportFailed')}</p>}
      {command.result && (
        <p role="status">
          {t('settings.diagnosticsExported', { bytes: formatBytes(command.result.bytes) })}
        </p>
      )}
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={cx('metric')}>
      <span title={label}>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function formatBytes(value: number): string {
  return value < 1024
    ? `${value} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KiB`
      : `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
export function installDiagnosticsUi(
  ctx: Context,
  model: DesktopDiagnosticsModel,
  commands: DiagnosticExportCommands,
): void {
  ctx.inject(['slots', 'locale'], (owner) => {
    owner.effect(() => owner.locale.register('desktopDiagnostics', dictionaries));
    owner.effect(() => {
      const style = document.createElement('style');
      style.dataset.axtermOwner = '@axterm/plugin-desktop/diagnostics';
      style.textContent = cssText;
      document.head.append(style);
      return () => style.remove();
    });
    owner.slots.inject('settings.common', function* () {
      yield owner.slots.register(
        {
          name: 'settings.common',
          id: 'desktop.diagnostics',
          order: 90,
          locale: 'desktopDiagnostics',
        },
        ({ t }: PropsLocale<'desktopDiagnostics'>) => (
          <DiagnosticsPanel model={model} commands={commands} t={t} />
        ),
      );
    });
  });
}
declare module '@axterm/ui' {
  interface LocaleNamespaceMap {
    desktopDiagnostics: keyof typeof dictionaries.en;
  }
}
