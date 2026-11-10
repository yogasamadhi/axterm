import type { Context } from '@deepseek-ai/cordis';
import { useState, useSyncExternalStore } from 'react';
import { Download, RefreshCw, Square, Upload } from 'lucide-react';
import type { PropsLocale } from '@axterm/ui';
import type { UpdaterAction, UpdaterStatus } from '@axterm/plugin-api/desktop';
import type { DesktopUpdaterModel } from './updater-model.ts';
import type { DesktopUpdateCommands } from './updater-commands.ts';
import { dictionaries } from './updater-locales.ts';
import styles, { cssText } from './updater.module.css';
const cx = (value: string) =>
  value
    .split(/\s+/u)
    .map((name) => `${name} ${styles[name] ?? ''}`)
    .join(' ');
type Translate = PropsLocale<'desktopUpdater'>['t'];
const labels: Record<UpdaterStatus['state'], keyof typeof dictionaries.en> = {
  disabled: 'settings.updaterDisabled',
  idle: 'settings.updaterIdle',
  checking: 'settings.updaterChecking',
  available: 'settings.updaterAvailable',
  downloading: 'settings.updaterDownloading',
  ready: 'settings.updaterReady',
  error: 'settings.updaterError',
};
function UpdaterPanel({
  model,
  commands,
  t,
}: {
  model: DesktopUpdaterModel;
  commands: DesktopUpdateCommands;
  t: Translate;
}) {
  const facts = useSyncExternalStore(model.subscribe, model.getSnapshot),
    command = useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const [failed, setFailed] = useState(false);
  const data = facts.status === 'ready' ? facts.baseline.status : undefined;
  async function perform(action?: UpdaterAction) {
    setFailed(false);
    try {
      if (action) await commands.perform(action);
      else await commands.retry();
    } catch {
      setFailed(true);
    }
  }
  return (
    <section className={cx('surface updater-panel')} aria-label={t('settings.updater')}>
      <header>
        <div>
          <small>{t('settings.updater')}</small>
          <h2>
            {t(
              data
                ? labels[data.state]
                : facts.status === 'connecting'
                  ? 'settings.updaterLoading'
                  : 'settings.updaterError',
            )}
          </h2>
          {data && (
            <p>
              {t(
                data.state === 'disabled'
                  ? 'settings.updaterDisabledHint'
                  : 'settings.updaterConfiguredHint',
              )}
            </p>
          )}
        </div>
        <div className={cx('updater-actions')}>
          {data && ['idle', 'available', 'ready', 'error'].includes(data.state) && (
            <button
              type="button"
              disabled={command.busy || command.uncertain}
              onClick={() => void perform('check')}
            >
              <RefreshCw size={13} /> {t('settings.updaterCheck')}
            </button>
          )}
          {data?.state === 'available' && (
            <button
              className="primary"
              type="button"
              disabled={command.busy || command.uncertain}
              onClick={() => void perform('download')}
            >
              <Download size={13} /> {t('settings.updaterDownload')}
            </button>
          )}
          {data && ['checking', 'downloading'].includes(data.state) && (
            <button
              type="button"
              disabled={command.uncertain}
              onClick={() => void perform('cancel')}
            >
              <Square size={11} /> {t('settings.updaterCancel')}
            </button>
          )}
          {data?.state === 'ready' && (
            <button
              className="primary"
              type="button"
              disabled={command.busy || command.uncertain}
              onClick={() => void perform('install')}
            >
              <Upload size={13} /> {t('settings.updaterInstall')}
            </button>
          )}
          {command.uncertain && (
            <button type="button" disabled={command.busy} onClick={() => void perform()}>
              {t('settings.updaterRetry')}
            </button>
          )}
          {facts.status === 'error' && (
            <button type="button" onClick={() => void model.retry().catch(() => setFailed(true))}>
              {t('settings.updaterReload')}
            </button>
          )}
        </div>
      </header>
      {data?.availableVersion && (
        <div className={cx('updater-detail')}>
          <span>{t('settings.updaterVersion')}</span>
          <strong>{data.availableVersion}</strong>
        </div>
      )}
      {data?.state === 'downloading' && (
        <div className={cx('updater-progress')}>
          <progress
            aria-label={t('settings.updaterDownloading')}
            max={100}
            value={data.progress ?? 0}
          />
          <span>{t('settings.updaterProgress', { progress: data.progress ?? 0 })}</span>
        </div>
      )}
      {data?.errorCode && <code className={cx('updater-error')}>{data.errorCode}</code>}
      {command.uncertain && <p role="alert">{t('settings.updaterUncertain')}</p>}
      {failed && !command.uncertain && <p role="alert">{t('settings.updaterError')}</p>}
    </section>
  );
}
export function installDesktopUpdaterUi(
  ctx: Context,
  model: DesktopUpdaterModel,
  commands: DesktopUpdateCommands,
): void {
  ctx.inject(['slots', 'locale'], (owner) => {
    owner.effect(() => owner.locale.register('desktopUpdater', dictionaries));
    owner.effect(() => {
      const style = document.createElement('style');
      style.dataset.axtermOwner = '@axterm/plugin-desktop/updater';
      style.textContent = cssText;
      document.head.append(style);
      return () => style.remove();
    });
    owner.slots.inject('settings.common', function* () {
      yield owner.slots.register(
        { name: 'settings.common', id: 'desktop.updater', order: 5, locale: 'desktopUpdater' },
        ({ t }: PropsLocale<'desktopUpdater'>) => (
          <UpdaterPanel model={model} commands={commands} t={t} />
        ),
      );
    });
  });
}
declare module '@axterm/ui' {
  interface LocaleNamespaceMap {
    desktopUpdater: keyof typeof dictionaries.en;
  }
}
