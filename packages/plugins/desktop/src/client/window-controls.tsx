import { useEffect, useState, useSyncExternalStore } from 'react';
import { Scan, Minus, Minimize2, Maximize2, X } from 'lucide-react';
import type { Context } from '@deepseek-ai/cordis';
import type { PropsLocale } from '@axterm/ui';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@axterm/ui/controls';
import { WindowControlsOwner } from './window-controls-owner.ts';
import { dictionaries } from './window-control-locales.ts';
import styles, { cssText } from './window-controls.module.css';
const cx = (value: string) =>
  value
    .split(/\s+/u)
    .map((name) => `${name} ${styles[name] ?? ''}`)
    .join(' ');
export function installWindowControls(ctx: Context): void {
  ctx.inject(
    ['slots', 'workspaceUi', 'desktopWindowUi', 'desktopWindow', 'desktopRuntimeModel'],
    (scope) => {
      const owner = new WindowControlsOwner(scope.desktopWindowUi);
      scope.effect(() => () => owner.close());
      scope.effect(() => scope.desktopRuntimeModel.subscribe(owner.schedule));
      scope.effect(() => scope.locale.register('desktopChrome', dictionaries));
      scope.effect(() => {
        const style = document.createElement('style');
        style.dataset.axtermOwner = '@axterm/plugin-desktop/window-controls';
        style.textContent = cssText;
        document.head.append(style);
        return () => style.remove();
      });
      scope.effect(() => {
        window.addEventListener('focus', owner.schedule);
        window.addEventListener('resize', owner.schedule);
        document.addEventListener('visibilitychange', owner.schedule);
        void owner.refresh().catch(() => {});
        return () => {
          window.removeEventListener('focus', owner.schedule);
          window.removeEventListener('resize', owner.schedule);
          document.removeEventListener('visibilitychange', owner.schedule);
        };
      });
      scope.slots.inject('workspace.toolbar', function* () {
        yield scope.slots.register(
          {
            name: 'workspace.toolbar',
            id: 'desktop.window-controls',
            order: 1000,
            locale: 'desktopChrome',
          },
          function Controls({ t }: PropsLocale<'desktopChrome'>) {
            const presentation = useSyncExternalStore(owner.subscribe, owner.getSnapshot),
              workspace = useSyncExternalStore(
                scope.workspaceUi.subscribe,
                scope.workspaceUi.getSnapshot,
              );
            const [confirmation, setConfirmation] = useState(false),
              isMac = /darwin|mac/iu.test(
                document.documentElement.dataset.platform ?? navigator.platform,
              );
            useEffect(() => {
              if (confirmation && !presentation.busy && document.visibilityState === 'hidden')
                setConfirmation(false);
            }, [confirmation, presentation]);
            const perform = (action: 'fullscreen' | 'minimize' | 'toggle-maximize' | 'close') => {
              void owner.perform(action).then(
                () => {
                  if (action === 'close') setConfirmation(false);
                },
                () => {},
              );
            };
            const state = presentation.value,
              disabled = presentation.busy || !state;
            return (
              <div
                className={cx('window-controls')}
                aria-label={t('shell.windowControls')}
                data-desktop-window-controls=""
              >
                <button
                  data-window-action="toggle-fullscreen"
                  title={t(state?.fullScreen ? 'shell.exitFullscreen' : 'shell.fullscreen')}
                  aria-label={t(state?.fullScreen ? 'shell.exitFullscreen' : 'shell.fullscreen')}
                  disabled={disabled}
                  onClick={() => perform('fullscreen')}
                >
                  <Scan size={13} />
                </button>
                {!isMac && (
                  <>
                    <button
                      data-window-action="minimize"
                      title={t('shell.minimize')}
                      aria-label={t('shell.minimize')}
                      disabled={disabled || !state.canMinimize}
                      onClick={() => perform('minimize')}
                    >
                      <Minus size={13} />
                    </button>
                    <button
                      data-window-action="toggle-maximize"
                      title={t(state?.maximized ? 'shell.restore' : 'shell.maximize')}
                      aria-label={t(state?.maximized ? 'shell.restore' : 'shell.maximize')}
                      disabled={disabled || !state.canMaximize}
                      onClick={() => perform('toggle-maximize')}
                    >
                      {state?.maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                    </button>
                    <button
                      className={cx('window-control-close')}
                      data-window-action="close"
                      title={t('shell.closeWindow')}
                      aria-label={t('shell.closeWindow')}
                      disabled={disabled || !state.canClose}
                      onClick={() =>
                        workspace.tabs.length > 1 ? setConfirmation(true) : perform('close')
                      }
                    >
                      <X size={14} />
                    </button>
                  </>
                )}
                {presentation.error && !confirmation && (
                  <span className={cx('window-close-error')} role="alert">
                    {t('shell.closeWindowFailed')}
                  </span>
                )}
                <Dialog
                  open={confirmation}
                  onOpenChange={(open) => {
                    if (!presentation.busy) setConfirmation(open);
                  }}
                >
                  <DialogContent asChild>
                    <section
                      className={cx('modal window-close-confirmation')}
                      role="alertdialog"
                      aria-labelledby="window-close-confirmation-title"
                      aria-describedby="window-close-confirmation-description"
                    >
                      <header>
                        <DialogTitle asChild>
                          <h2 id="window-close-confirmation-title">
                            {t('shell.confirmCloseTabsTitle', { count: workspace.tabs.length })}
                          </h2>
                        </DialogTitle>
                      </header>
                      <div className={cx('window-close-confirmation-body')}>
                        <DialogDescription asChild>
                          <p id="window-close-confirmation-description">
                            {t('shell.confirmCloseTabsDescription')}
                          </p>
                        </DialogDescription>
                        {presentation.error && <p role="alert">{t('shell.closeWindowFailed')}</p>}
                        <div className={cx('modal-actions')}>
                          <button
                            autoFocus
                            disabled={presentation.busy}
                            onClick={() => setConfirmation(false)}
                          >
                            {t('common.cancel')}
                          </button>
                          <button
                            className={cx('danger')}
                            disabled={presentation.busy}
                            onClick={() => perform('close')}
                          >
                            {t('shell.closeWindow')}
                          </button>
                        </div>
                      </div>
                    </section>
                  </DialogContent>
                </Dialog>
              </div>
            );
          },
        );
      });
    },
  );
}
declare module '@axterm/ui' {
  interface LocaleNamespaceMap {
    desktopChrome: keyof typeof dictionaries.en;
  }
}
