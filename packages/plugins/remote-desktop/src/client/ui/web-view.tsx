import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSyncExternalStore } from 'react';
import type { WebSessionModel } from '../web-model.ts';
import type { WebSessionWorkspace } from './web-owner.ts';
import { WebPresentation } from './web-presentation.ts';
import { cx } from './styles.ts';

import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  ShieldAlert,
  Square,
} from 'lucide-react';
import { useI18n } from './i18n.tsx';

export function WebSessionView({
  model,
  owner,
  sessionId,
  active,
  onReload,
}: {
  model: WebSessionModel;
  owner: WebSessionWorkspace;
  sessionId: string;
  active: boolean;
  onReload(): void;
}) {
  const { x } = useI18n();
  const stage = useRef<HTMLDivElement>(null);
  const presentation = useRef<WebPresentation>();
  const facts = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const session =
    facts.status === 'ready'
      ? facts.baseline.sessions.find((value) => value.id === sessionId)
      : undefined;
  const [loadError, setLoadError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');

  const generation = facts.status === 'ready' ? facts.baseline.generation : undefined;
  const hasSession = !!session;
  useEffect(() => {
    if (!stage.current || !generation || !hasSession) return;
    const surface = new WebPresentation(model, sessionId, generation, stage.current, () =>
      setLoadError(x('webSession.presentError')),
    );
    presentation.current = surface;
    const detach = owner.attach(sessionId, surface);
    return () => {
      if (presentation.current === surface) presentation.current = undefined;
      detach();
    };
  }, [model, owner, sessionId, generation, hasSession, x]);
  const hostViewVisible =
    active && !!session && session.state !== 'auth-required' && session.state !== 'failed';
  useEffect(() => {
    presentation.current?.setVisible(hostViewVisible);
  }, [hostViewVisible, generation, hasSession]);

  const perform = async (
    action:
      | 'back'
      | 'forward'
      | 'reload'
      | 'stop'
      | 'set-zoom'
      | 'open-external'
      | 'open-blocked-external',
    zoomFactor?: number,
  ) => {
    if (actionBusy) return;
    setActionBusy(true);
    setLoadError('');
    try {
      await model.perform(sessionId, {
        action,
        ...(zoomFactor === undefined ? {} : { zoomFactor }),
      });
    } catch {
      setLoadError(x('webSession.actionError'));
    } finally {
      setActionBusy(false);
    }
  };

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session?.authChallenge || authBusy) return;
    const element = event.currentTarget;
    const form = new FormData(element);
    element.reset();
    setAuthBusy(true);
    setAuthError('');
    try {
      await model.authenticate(sessionId, {
        challengeId: session.authChallenge.id,
        username: String(form.get('username') ?? ''),
        password: String(form.get('password') ?? ''),
      });
    } catch {
      setAuthError(x('webSession.authError'));
    } finally {
      setAuthBusy(false);
    }
  };

  if (!session)
    return (
      <div className={cx('rdp-view rdp-loading web-session-view')}>
        <LoaderCircle className={cx('spin')} size={18} />
        <span>{loadError || x('webSession.preparing')}</span>
        {loadError && (
          <button onClick={onReload}>
            <RefreshCw size={13} /> {x('webSession.retry')}
          </button>
        )}
      </div>
    );

  const displayedUrl = session.currentUrl || session.url;
  const zoomPercent = Math.round(session.zoomFactor * 100);
  return (
    <div
      className={cx(`web-session-view ${session.hideAddressBar ? 'hide-address-bar' : ''}`)}
      data-web-session-state={session.state}
      data-native-web-view={session.id}
      data-native-web-active={active ? 'true' : 'false'}
    >
      {!session.hideAddressBar && (
        <div className={cx('web-session-toolbar')} aria-label={x('webSession.addressBar')}>
          <button
            aria-label={x('webSession.back')}
            title={x('webSession.back')}
            disabled={!session.canGoBack || actionBusy}
            onClick={() => void perform('back')}
          >
            <ArrowLeft size={13} />
          </button>
          <button
            aria-label={x('webSession.forward')}
            title={x('webSession.forward')}
            disabled={!session.canGoForward || actionBusy}
            onClick={() => void perform('forward')}
          >
            <ArrowRight size={13} />
          </button>
          <button
            aria-label={session.loading ? x('webSession.stop') : x('webSession.reload')}
            title={session.loading ? x('webSession.stop') : x('webSession.reload')}
            disabled={actionBusy}
            onClick={() => void perform(session.loading ? 'stop' : 'reload')}
          >
            {session.loading ? <Square size={11} /> : <RefreshCw size={13} />}
          </button>
          <button
            className={cx('web-session-address')}
            title={x('webSession.copyAddress', { url: displayedUrl })}
            onClick={() => void navigator.clipboard.writeText(displayedUrl)}
          >
            {session.loading ? (
              <LoaderCircle className={cx('spin')} size={12} />
            ) : (
              <Globe2 size={12} />
            )}
            <span>{displayedUrl}</span>
          </button>
          <div className={cx('web-session-zoom')} aria-label={x('webSession.zoom')}>
            <button
              aria-label={x('webSession.zoomOut')}
              disabled={actionBusy || session.zoomFactor <= 0.25}
              onClick={() => void perform('set-zoom', Math.max(0.25, session.zoomFactor - 0.1))}
            >
              <Minus size={12} />
            </button>
            <button
              title={x('webSession.resetZoom')}
              disabled={actionBusy}
              onClick={() => void perform('set-zoom', 1)}
            >
              {zoomPercent}%
            </button>
            <button
              aria-label={x('webSession.zoomIn')}
              disabled={actionBusy || session.zoomFactor >= 5}
              onClick={() => void perform('set-zoom', Math.min(5, session.zoomFactor + 0.1))}
            >
              <Plus size={12} />
            </button>
          </div>
          <button
            aria-label={x('webSession.openExternal')}
            title={x('webSession.openExternal')}
            disabled={actionBusy}
            onClick={() => void perform('open-external')}
          >
            <ExternalLink size={13} />
          </button>
        </div>
      )}
      {session.blockedUrl && (
        <div className={cx('web-session-notice')}>
          <ShieldAlert size={13} />
          <span>{x('webSession.newWindowRequested', { url: session.blockedUrl })}</span>
          <button onClick={() => void perform('open-blocked-external')}>
            {x('webSession.openExternal')}
          </button>
        </div>
      )}
      {loadError && <div className={cx('web-session-error')}>{loadError}</div>}
      <div ref={stage} className={cx('web-session-stage')} aria-label={x('webSession.canvas')}>
        {session.state === 'failed' && (
          <div className={cx('web-session-fallback')}>
            <ShieldAlert size={20} />
            <strong>{x('webSession.failed')}</strong>
            <span>{session.errorCode ?? 'WEB_SESSION_FAILED'}</span>
            <button onClick={onReload}>
              <RefreshCw size={13} /> {x('webSession.recreate')}
            </button>
          </div>
        )}
        {session.state === 'auth-required' && session.authChallenge && (
          <form className={cx('web-session-auth')} onSubmit={(event) => void submitAuth(event)}>
            <Globe2 size={22} />
            <strong>{x('webSession.authRequired')}</strong>
            <span>
              {session.authChallenge.host}
              {session.authChallenge.realm ? ` · ${session.authChallenge.realm}` : ''}
            </span>
            <label>
              {x('webSession.username')}
              <input name="username" autoComplete="off" maxLength={1_024} autoFocus />
            </label>
            <label>
              {x('webSession.password')}
              <input name="password" type="password" autoComplete="off" maxLength={16_384} />
            </label>
            {authError && <small className={cx('web-session-auth-error')}>{authError}</small>}
            <button className={cx('primary')} disabled={authBusy}>
              {authBusy ? x('webSession.authenticating') : x('webSession.signIn')}
            </button>
            <small>{x('webSession.credentialsTemporary')}</small>
          </form>
        )}
      </div>
    </div>
  );
}
