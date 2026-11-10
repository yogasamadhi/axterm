import {
  installRemoteDesktopDescriptions,
  installWebSessionDescriptions,
} from './session-descriptions.ts';
import { WebSessionModel } from '../web-model.ts';
import { WebSessionWorkspace } from './web-owner.ts';
import { WebSessionView } from './web-view.tsx';
import '@axterm/ui/workspace';
import { useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionHandle } from '@axterm/infra-connection/client';
import type { PropsLocale } from '@axterm/ui';
import type { WorkspaceSessionOwner } from '@axterm/ui/workspace';
import { Dialog, DialogContent, DialogTitle } from '@axterm/ui/controls';
import type { RemoteDesktopModel } from '../index.ts';
import { VendorSocketRoutes } from './vendor-sockets.ts';
import { RemoteDesktopWorkspace } from './workspace-owner.ts';
import { RdpView } from './rdp-view.tsx';
import { VncView } from './vnc-view.tsx';
import { SpiceView } from './spice-view.tsx';
import { ProtocolI18n } from './i18n.tsx';
import { dictionaries } from './locales.ts';
import { cx, cssText } from './styles.ts';
export function installRemoteDesktopUi(ctx: Context, model: RemoteDesktopModel): void {
  const sockets = new VendorSocketRoutes(ctx.get('connection') as unknown as ConnectionHandle);
  const owner = new RemoteDesktopWorkspace(model, ctx.workspaceUi, sockets);
  installRemoteDesktopDescriptions(ctx, model, owner);
  ctx.provide('remoteDesktopWorkspaceUi', { open: (input, signal) => owner.open(input, signal) });
  ctx.effect(() => () => owner.close());
  ctx.effect(() => ctx.locale.register('remote-desktop', dictionaries));
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.axtermOwner = '@axterm/plugin-remote-desktop';
    style.dataset.plugin = '@axterm/plugin-remote-desktop';
    style.textContent = cssText;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.inject(['desktopWindow'], (web) => {
    const webModel = new WebSessionModel(web, web.desktopWindow.id);
    web.effect(() => () => webModel.dispose());
    const webOwner = new WebSessionWorkspace(webModel, web.workspaceUi);
    installWebSessionDescriptions(web, webModel, webOwner);
    web.provide('webSessionWorkspaceUi', {
      open: (bookmarkId, signal) => webOwner.open({ bookmarkId }, signal),
    });
    web.effect(() => () => webOwner.close());
    web.slots.inject('workspace.session', function* () {
      yield web.slots.register(
        { name: 'workspace.session', key: 'web-session', locale: 'remote-desktop' },
        function Session(props: PropsLocale<'remote-desktop'> & WorkspaceSessionOwner) {
          return (
            <ProtocolI18n translate={props.t}>
              <WebSessionView
                model={webModel}
                owner={webOwner}
                sessionId={props.tabId}
                active={props.active}
                onReload={() => void webOwner.reconnect(props.tabId).catch(() => {})}
              />
            </ProtocolI18n>
          );
        },
      );
    });
    web.slots.inject('workspace.overlay', function* () {
      yield web.slots.register(
        {
          name: 'workspace.overlay',
          id: 'web-session.outcomes',
          order: 21,
          locale: 'remote-desktop',
        },
        function Outcomes({ t }: PropsLocale<'remote-desktop'>) {
          const state = useSyncExternalStore(webOwner.subscribe, webOwner.getSnapshot);
          return state.uncertain || state.failed ? (
            <div role="alert" className={cx('remote-desktop-outcome')}>
              {t(state.uncertain ? 'surface.uncertain' : 'common.operationFailed')}
              {state.uncertain && (
                <button onClick={() => void webOwner.retryCleanup().catch(() => {})}>
                  {t('surface.checkAgain')}
                </button>
              )}
            </div>
          ) : null;
        },
      );
    });
  });
  ctx.slots.inject('workspace.session', function* () {
    yield ctx.slots.register(
      { name: 'workspace.session', key: 'remote-desktop', locale: 'remote-desktop' },
      function Session(props: PropsLocale<'remote-desktop'> & WorkspaceSessionOwner) {
        return (
          <ProtocolI18n translate={props.t}>
            <SessionView {...props} model={model} owner={owner} />
          </ProtocolI18n>
        );
      },
    );
  });
  ctx.slots.inject('workspace.overlay', function* () {
    yield ctx.slots.register(
      {
        name: 'workspace.overlay',
        id: 'remote-desktop.outcomes',
        order: 20,
        locale: 'remote-desktop',
      },
      function Outcomes({ t }: PropsLocale<'remote-desktop'>) {
        const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
        return state.uncertain || state.failed ? (
          <div role="alert" className={cx('remote-desktop-outcome')}>
            {t(state.uncertain ? 'surface.uncertain' : 'common.operationFailed')}
            {state.uncertain && (
              <button onClick={() => void owner.retryCleanup().catch(() => {})}>
                {t('surface.checkAgain')}
              </button>
            )}
          </div>
        ) : null;
      },
    );
  });
}
function SessionView({
  model,
  owner,
  tabId,
  active,
  t,
}: { model: RemoteDesktopModel; owner: RemoteDesktopWorkspace } & WorkspaceSessionOwner &
  PropsLocale<'remote-desktop'>) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot),
    [reconnect, setReconnect] = useState(false),
    [busy, setBusy] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  const session =
    state.status === 'ready'
      ? state.baseline.sessions.find((value) => value.id === tabId)
      : undefined;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const secret = password.current?.value;
    if (password.current) password.current.value = '';
    setBusy(true);
    try {
      await owner.reconnect(tabId, secret);
      setReconnect(false);
    } catch {
      /* The workspace retains failed cleanup and the selected action reports failure. */
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={cx('remote-desktop-root')} data-remote-desktop-session={tabId}>
      {session ? (
        session.protocol === 'rdp' ? (
          <RdpView
            surface={owner.surface}
            session={session}
            active={active}
            onReload={() => setReconnect(true)}
          />
        ) : session.protocol === 'vnc' ? (
          <VncView
            surface={owner.surface}
            session={session}
            active={active}
            onReload={() => setReconnect(true)}
          />
        ) : (
          <SpiceView
            surface={owner.surface}
            session={session}
            active={active}
            onReload={() => setReconnect(true)}
          />
        )
      ) : (
        <p role="status">{t('remoteDesktop.preparing', { protocol: '' })}</p>
      )}
      <Dialog
        open={reconnect}
        onOpenChange={(value) => {
          if (!busy) setReconnect(value);
        }}
      >
        <DialogContent closeLabel={t('surface.cancel')}>
          <DialogTitle>{t('surface.reconnectTitle')}</DialogTitle>
          <form onSubmit={(event) => void submit(event)}>
            <label>
              {t('surface.password')}
              <input ref={password} type="password" autoComplete="new-password" maxLength={16384} />
            </label>
            <button type="submit" disabled={busy}>
              {t('surface.connect')}
            </button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
