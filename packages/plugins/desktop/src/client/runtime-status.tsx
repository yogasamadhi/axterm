import { Activity, RefreshCw } from 'lucide-react';
import { useRef, useSyncExternalStore } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle, ConnectionState } from '@axterm/infra-connection/client';
import type { PropsLocale } from '@axterm/ui';
import type {} from '@axterm/ui/workspace';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogClose,
} from '@axterm/ui/controls';
import type { DesktopRuntimeModel, DesktopRuntimeState } from './index.ts';
import { dictionaries } from './runtime-status-locales.ts';
import styles, { cssText } from './runtime-status.module.css';
export function runtimePresentation(
  facts: DesktopRuntimeState,
  connection: ConnectionState | undefined,
): 'ready' | 'connecting' | 'degraded' {
  if (facts.status === 'error' || connection === 'disconnected') return 'degraded';
  if (facts.status === 'ready') return connection === 'connected' ? 'ready' : 'degraded';
  return 'connecting';
}
export function installRuntimeStatusUi(ctx: Context, model: DesktopRuntimeModel): void {
  ctx.inject(['slots', 'locale', 'workspaceUi'], (scope) => installRuntimeStatus(scope, model));
}
function installRuntimeStatus(ctx: Context, model: DesktopRuntimeModel): void {
  ctx.effect(() => ctx.locale.register('runtimeStatus', dictionaries));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = '@axterm/plugin-desktop/runtime-status';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  const connection = ctx.get('connection') as unknown as ConnectionHandle;
  const reconnect = () => {
    connection.reconnect();
    if (model.getSnapshot().status === 'error') void model.retry().catch(() => {});
  };
  function useRuntime() {
    const facts = useSyncExternalStore(model.subscribe, model.getSnapshot),
      link = useSyncExternalStore(connection.state.subscribe, connection.state.getSnapshot);
    const wasReady = useRef(false);
    const status = runtimePresentation(facts, link);
    if (status === 'ready') wasReady.current = true;
    return {
      facts,
      status: status === 'connecting' && wasReady.current ? ('degraded' as const) : status,
    };
  }
  function Summary({ t, toolbar = false }: PropsLocale<'runtimeStatus'> & { toolbar?: boolean }) {
    const { facts, status } = useRuntime(),
      workspace = useSyncExternalStore(ctx.workspaceUi.subscribe, ctx.workspaceUi.getSnapshot),
      tab = workspace.tabs.find((item) => item.id === workspace.activeTabId);
    return (
      <Dialog>
        <DialogTrigger asChild>
          <button
            className={toolbar ? styles.control : styles.summary}
            aria-label={t('details')}
            data-runtime-details-trigger=""
          >
            {toolbar ? (
              <Activity size={14} />
            ) : (
              <>
                {tab?.title ?? 'Axterm'} ·{' '}
                {status === 'ready' && facts.status === 'ready'
                  ? `— · API ${facts.baseline.version.apiVersion}`
                  : t(status)}
              </>
            )}
          </button>
        </DialogTrigger>
        <DialogContent closeLabel={t('close')}>
          <DialogTitle>{t('details')}</DialogTitle>
          <p role="status">{t(status)}</p>
          {status === 'ready' && facts.status === 'ready' && (
            <dl>
              <dt>Runtime ID</dt>
              <dd data-testid="runtime-id">{facts.baseline.metadata.runtimeId}</dd>
              <dt>{t('generation')}</dt>
              <dd data-testid="runtime-generation">{facts.baseline.metadata.generation}</dd>
              <dt>{t('process')}</dt>
              <dd data-testid="runtime-process-id">{facts.baseline.metadata.pid}</dd>
              <dt>{t('version')}</dt>
              <dd>{facts.baseline.version.appVersion}</dd>
            </dl>
          )}
          <DialogClose asChild>
            <button>{t('close')}</button>
          </DialogClose>
        </DialogContent>
      </Dialog>
    );
  }
  ctx.slots.inject('workspace.toolbar', function* () {
    yield ctx.slots.register(
      {
        name: 'workspace.toolbar',
        id: 'desktop.connection-controls',
        order: 80,
        locale: 'runtimeStatus',
      },
      function ConnectionControls(props: PropsLocale<'runtimeStatus'>) {
        return (
          <>
            <button
              className={styles.control}
              data-runtime-reconnect=""
              aria-label={props.t('reconnect')}
              title={props.t('reconnect')}
              onClick={reconnect}
            >
              <RefreshCw size={14} />
            </button>
            <Summary {...props} toolbar />
          </>
        );
      },
    );
  });
  ctx.slots.inject('workspace.status', function* () {
    yield ctx.slots.register(
      { name: 'workspace.status', id: 'desktop.health', order: 0, locale: 'runtimeStatus' },
      function Health({ t }: PropsLocale<'runtimeStatus'>) {
        const { status } = useRuntime();
        return (
          <span className={styles.health}>
            <span className={styles.led} data-runtime-led={status} aria-hidden="true" />
            {t(
              status === 'ready'
                ? 'connected'
                : status === 'degraded'
                  ? 'interrupted'
                  : 'connecting',
            )}
          </span>
        );
      },
    );
    yield ctx.slots.register(
      { name: 'workspace.status', id: 'desktop.summary', order: 100, locale: 'runtimeStatus' },
      Summary,
    );
  });
  ctx.slots.inject('workspace.overlay', function* () {
    yield ctx.slots.register(
      { name: 'workspace.overlay', id: 'desktop.runtime-state', locale: 'runtimeStatus' },
      function Identity({ t }: PropsLocale<'runtimeStatus'>) {
        const { status } = useRuntime();
        return (
          <>
            <div className={styles.identity} role="status" aria-live="polite" aria-atomic="true">
              <h2 data-testid="runtime-state" data-state={status}>
                {t(status)}
              </h2>
            </div>
            {status === 'degraded' && (
              <div className={'runtime-wait ' + styles.runtimeWait}>
                <RefreshCw size={24} aria-hidden="true" />
                <h2>{t('degraded')}</h2>
                <button type="button" onClick={reconnect}>
                  {t('reconnect')}
                </button>
              </div>
            )}
            <span className={styles.railLed} data-runtime-led={status} aria-hidden="true" />
          </>
        );
      },
    );
  });
}
