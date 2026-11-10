import { ActivityRailSettingsPanel } from './rail-settings.tsx';
import railDictionaries from './rail-locales.json' with { type: 'json' };
import { useState, useSyncExternalStore, type FormEvent } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import type { SettingsModel } from './index.ts';
import { BehaviorPreferenceCommands, type BehaviorPreferences } from './behavior-commands.ts';
import dictionaries from './behavior-locales.json' with { type: 'json' };
import styles, { cssText } from './behavior.module.css';
declare module '@axterm/ui' {
  interface LocaleNamespaceMap {
    activityRail: keyof typeof railDictionaries.en;
    behaviorSettings: keyof typeof dictionaries.en;
  }
}
const cls = (...names: string[]) =>
  names.map((name) => name + ' ' + (styles[name] ?? '')).join(' ');
export function installBehaviorPreferences(ctx: Context, model: SettingsModel): void {
  const commands = new BehaviorPreferenceCommands(model);
  ctx.effect(() => () => commands.close());
  ctx.effect(() => ctx.locale.register('behaviorSettings', dictionaries));
  ctx.effect(() => ctx.locale.register('activityRail', railDictionaries));
  ctx.slots.inject('settings.common', function* () {
    yield ctx.slots.register(
      { name: 'settings.common', id: 'configuration.activityRail', locale: 'activityRail' },
      function RailSettings({ t }: PropsLocale<'activityRail'>) {
        return <ActivityRailSettingsPanel model={model} commands={commands} t={t} />;
      },
    );
  });
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = '@axterm/plugin-configuration';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('settings.common', function* () {
    yield ctx.slots.register(
      { name: 'settings.common', id: 'configuration.behavior', locale: 'behaviorSettings' },
      function BehaviorSettings({ t }: PropsLocale<'behaviorSettings'>) {
        const state = useSyncExternalStore(model.subscribe, model.getSnapshot),
          command = useSyncExternalStore(commands.subscribe, commands.getSnapshot),
          [notice, setNotice] = useState(false),
          [error, setError] = useState<'behavior' | 'tabs'>();
        const settings = state.status === 'ready' ? state.baseline.settings : undefined,
          busy = command.busy || command.uncertain;
        const update = (_key: string, input: BehaviorPreferences) => {
          setNotice(false);
          setError(undefined);
          return commands.save(input).then(
            () => setNotice(true),
            () => setError(['tabs', 'restoreLayout'].includes(_key) ? 'tabs' : 'behavior'),
          );
        };
        const saveEditor = (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          void update('externalEditor', {
            fileManager: {
              externalEditor: String(
                new FormData(event.currentTarget).get('editorExecutable') ?? '',
              ).trim(),
            },
          });
        };
        const failure = error && (
          <p role="alert">
            {t(error === 'tabs' ? 'tabPreferences.saveError' : 'behaviorSettings.saveFailed')}
            {command.uncertain && (
              <button
                disabled={command.busy}
                onClick={() => {
                  void commands.retry().then(
                    () => {
                      setError(undefined);
                      setNotice(true);
                    },
                    () => undefined,
                  );
                }}
              >
                {t('common.retry')}
              </button>
            )}
          </p>
        );
        return (
          <div data-behavior-settings="">
            <section className={cls('surface', 'stack', 'behavior-settings')}>
              <fieldset className={cls('monitor-settings-group')}>
                <legend>{t('behaviorSettings.fileBehavior')}</legend>
                <label className={cls('check')}>
                  <input
                    checked={settings?.fileManager.refreshOnFocus ?? false}
                    disabled={!settings || busy}
                    onChange={(event) =>
                      void update('refreshOnFocus', {
                        fileManager: { refreshOnFocus: event.currentTarget.checked },
                      })
                    }
                    type="checkbox"
                  />
                  {t('behaviorSettings.refreshOnFocus')}
                </label>
                <label className={cls('check')}>
                  <input
                    checked={settings?.fileManager.followTerminalCwd ?? false}
                    disabled={!settings || busy}
                    onChange={(event) =>
                      void update('followTerminalCwd', {
                        fileManager: { followTerminalCwd: event.currentTarget.checked },
                      })
                    }
                    type="checkbox"
                  />
                  {t('behaviorSettings.followTerminalCwd')}
                </label>
                <label className={cls('check')}>
                  <input
                    checked={settings?.fileManager.sshSplitView ?? false}
                    disabled={!settings || busy}
                    onChange={(event) =>
                      void update('sshSplitView', {
                        fileManager: { sshSplitView: event.currentTarget.checked },
                      })
                    }
                    type="checkbox"
                  />
                  {t('behaviorSettings.sshSplitView')}
                </label>
                <form
                  className={cls('stack')}
                  key={settings?.fileManager.externalEditor ?? 'system-editor'}
                  onSubmit={saveEditor}
                >
                  <label className={cls('field', 'compact-field')}>
                    <span>{t('behaviorSettings.externalEditor')}</span>
                    <input
                      autoComplete="off"
                      disabled={!settings || busy}
                      maxLength={4096}
                      defaultValue={settings?.fileManager.externalEditor ?? ''}
                      name="editorExecutable"
                      aria-label={t('behaviorSettings.externalEditor')}
                      placeholder={t('behaviorSettings.systemEditor')}
                    />
                    <small className={cls('hint')}>
                      {t('behaviorSettings.externalEditorHint')}
                    </small>
                  </label>
                  <div className={cls('modal-actions')}>
                    <button className={cls('primary')} disabled={!settings || busy} type="submit">
                      {t('behaviorSettings.saveEditor')}
                    </button>
                  </div>
                </form>
              </fieldset>

              <fieldset className={cls('monitor-settings-group')}>
                <legend>{t('behaviorSettings.accessibility')}</legend>
                <label className={cls('check')}>
                  <input
                    checked={settings?.terminal.screenReaderMode ?? false}
                    disabled={!settings || busy}
                    onChange={(event) =>
                      void update('screenReaderMode', {
                        terminal: { screenReaderMode: event.currentTarget.checked },
                      })
                    }
                    type="checkbox"
                  />
                  {t('behaviorSettings.screenReaderMode')}
                </label>
                <p className={cls('hint')}>{t('behaviorSettings.screenReaderHint')}</p>
              </fieldset>
              {error === 'behavior' && failure}
            </section>{' '}
            <section
              className={cls('surface', 'tab-preferences-panel')}
              aria-labelledby="tab-preferences-title"
            >
              <header>
                <div>
                  <h3 id="tab-preferences-title">{t('tabPreferences.title')}</h3>
                  <p>{t('tabPreferences.description')}</p>
                </div>
              </header>
              <label className={cls('check')}>
                <input
                  type="checkbox"
                  checked={settings?.workspace.restoreLayout ?? false}
                  disabled={!settings || busy}
                  onChange={(event) =>
                    void update('restoreLayout', {
                      workspace: { restoreLayout: event.currentTarget.checked },
                    })
                  }
                />
                {t('tabPreferences.restoreLayout')}
              </label>
              <label className={cls('check')}>
                <input
                  checked={settings?.workspace.showTabNumber ?? true}
                  disabled={!settings || busy}
                  onChange={(event) =>
                    void update('tabs', { workspace: { showTabNumber: event.target.checked } })
                  }
                  type="checkbox"
                />
                {t('tabPreferences.showNumber')}
              </label>
              <label className={cls('check')}>
                <input
                  checked={settings?.workspace.switchTabOnHover ?? false}
                  disabled={!settings || busy}
                  onChange={(event) =>
                    void update('tabs', { workspace: { switchTabOnHover: event.target.checked } })
                  }
                  type="checkbox"
                />
                {t('tabPreferences.switchOnHover')}
              </label>
              {error === 'tabs' && failure}
            </section>
            {notice && (
              <p className={cls('hint')} role="status">
                {t('behaviorSettings.saved')}
              </p>
            )}
          </div>
        );
      },
    );
  });
}
