import { CheckCircle2, RefreshCw, X } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@axterm/infra-connection/client';
import type { PropsLocale } from '@axterm/ui';
import type {} from '@axterm/ui/workspace';
import type { DesktopRuntimeModel } from './index.ts';
import dictionaries from './power-locales.json' with { type: 'json' };
import styles, { cssText } from './power.module.css';
declare module '@axterm/ui' {
  interface LocaleNamespaceMap {
    desktopPower: keyof typeof dictionaries.en;
  }
}
export function installDesktopPowerUi(ctx: Context, model: DesktopRuntimeModel) {
  ctx.inject(['slots', 'locale'], (scope) => {
    scope.effect(() => scope.locale.register('desktopPower', dictionaries));
    scope.effect(() => {
      const style = document.createElement('style');
      style.dataset.plugin = '@axterm/plugin-desktop/power';
      style.textContent = cssText;
      document.head.append(style);
      return () => style.remove();
    });
    scope.slots.inject('workspace.overlay', function* () {
      yield scope.slots.register(
        { name: 'workspace.overlay', id: 'desktop.power', locale: 'desktopPower' },
        function Power({ t }: PropsLocale<'desktopPower'>) {
          const notice = useSyncExternalStore(model.subscribe, model.getResumeNotice);
          useEffect(() => {
            if (!notice) return;
            const timer = setTimeout(model.dismissResume, 10000);
            return () => clearTimeout(timer);
          }, [notice]);
          if (!notice) return null;
          return (
            <div
              className={styles.banner}
              data-testid="session-recovery"
              data-recovery-kind="resumed"
              role="status"
              aria-live="polite"
            >
              <span className={styles.icon} aria-hidden="true">
                <CheckCircle2 size={16} />
              </span>
              <span className={styles.copy}>
                <strong>{t('title')}</strong>
                <small>{t('message')}</small>
              </span>
              <span className={styles.actions}>
                <button
                  type="button"
                  onClick={() => {
                    (
                      scope.get('connection') as unknown as ConnectionHandle | undefined
                    )?.reconnect();
                    if (model.getSnapshot().status === 'error') void model.retry().catch(() => {});
                  }}
                >
                  <RefreshCw size={12} />
                  {t('refresh')}
                </button>
                <button
                  type="button"
                  className={styles.dismiss}
                  aria-label={t('dismiss')}
                  title={t('dismiss')}
                  onClick={model.dismissResume}
                >
                  <X size={13} />
                </button>
              </span>
            </div>
          );
        },
      );
    });
  });
}
