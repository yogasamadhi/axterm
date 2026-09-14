import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { createRuntimeClient } from '@workspace/client';
import type { WebSession } from '@workspace/contracts';
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
import { useI18n } from '../i18n/context';

type Client = ReturnType<typeof createRuntimeClient>;

export function WebSessionView({
  client,
  sessionId,
  active,
  onReload,
}: {
  client: Client;
  sessionId: string;
  active: boolean;
  onReload(): void;
}) {
  const { x } = useI18n();
  const stage = useRef<HTMLDivElement>(null);
  const lastPresentation = useRef('');
  const [session, setSession] = useState<WebSession>();
  const [loadError, setLoadError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const value = await client.webSession(sessionId);
        if (!disposed) {
          setSession(value);
          setLoadError('');
        }
      } catch (error) {
        if (!disposed)
          setLoadError(error instanceof Error ? error.message : x('webSession.loadError'));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 750);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [client, sessionId, x]);

  const hostViewVisible =
    active && !!session && session.state !== 'auth-required' && session.state !== 'failed';

  useEffect(() => {
    let disposed = false;
    const sync = () => {
      const element = stage.current;
      if (!element || !hostViewVisible) {
        if (lastPresentation.current !== 'hidden') {
          lastPresentation.current = 'hidden';
          void client.presentWebSession(sessionId, { visible: false }).catch(() => undefined);
        }
        return;
      }
      const rect = element.getBoundingClientRect();
      const bounds = {
        x: Math.max(0, Math.round(rect.left)),
        y: Math.max(0, Math.round(rect.top)),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      };
      const next = JSON.stringify(bounds);
      if (next === lastPresentation.current) return;
      lastPresentation.current = next;
      void client
        .presentWebSession(sessionId, { bounds, visible: true })
        .then((value) => {
          if (!disposed) setSession(value);
        })
        .catch((error: unknown) => {
          if (!disposed)
            setLoadError(error instanceof Error ? error.message : x('webSession.presentError'));
        });
    };
    sync();
    const timer = window.setInterval(sync, 250);
    window.addEventListener('resize', sync);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('resize', sync);
      lastPresentation.current = 'hidden';
      void client.presentWebSession(sessionId, { visible: false }).catch(() => undefined);
    };
  }, [client, hostViewVisible, sessionId, x]);

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
      setSession(
        await client.performWebSessionAction(sessionId, {
          action,
          ...(zoomFactor === undefined ? {} : { zoomFactor }),
        }),
      );
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : x('webSession.actionError'));
    } finally {
      setActionBusy(false);
    }
  };

  const submitAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session?.authChallenge || authBusy) return;
    const form = new FormData(event.currentTarget);
    setAuthBusy(true);
    setAuthError('');
    try {
      setSession(
        await client.answerWebSessionAuthentication(sessionId, {
          challengeId: session.authChallenge.id,
          username: String(form.get('username') ?? ''),
          password: String(form.get('password') ?? ''),
        }),
      );
      event.currentTarget.reset();
      lastPresentation.current = '';
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : x('webSession.authError'));
    } finally {
      setAuthBusy(false);
    }
  };

  if (!session)
    return (
      <div className="rdp-view rdp-loading web-session-view">
        <LoaderCircle className="spin" size={18} />
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
      className={`web-session-view ${session.hideAddressBar ? 'hide-address-bar' : ''}`}
      data-web-session-state={session.state}
    >
      {!session.hideAddressBar && (
        <div className="web-session-toolbar" aria-label={x('webSession.addressBar')}>
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
            className="web-session-address"
            title={x('webSession.copyAddress', { url: displayedUrl })}
            onClick={() => void navigator.clipboard.writeText(displayedUrl)}
          >
            {session.loading ? <LoaderCircle className="spin" size={12} /> : <Globe2 size={12} />}
            <span>{displayedUrl}</span>
          </button>
          <div className="web-session-zoom" aria-label={x('webSession.zoom')}>
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
        <div className="web-session-notice">
          <ShieldAlert size={13} />
          <span>{x('webSession.newWindowRequested', { url: session.blockedUrl })}</span>
          <button onClick={() => void perform('open-blocked-external')}>
            {x('webSession.openExternal')}
          </button>
        </div>
      )}
      {loadError && <div className="web-session-error">{loadError}</div>}
      <div ref={stage} className="web-session-stage" aria-label={x('webSession.canvas')}>
        {session.state === 'failed' && (
          <div className="web-session-fallback">
            <ShieldAlert size={20} />
            <strong>{x('webSession.failed')}</strong>
            <span>{session.errorCode ?? 'WEB_SESSION_FAILED'}</span>
            <button onClick={onReload}>
              <RefreshCw size={13} /> {x('webSession.recreate')}
            </button>
          </div>
        )}
        {session.state === 'auth-required' && session.authChallenge && (
          <form className="web-session-auth" onSubmit={(event) => void submitAuth(event)}>
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
            {authError && <small className="web-session-auth-error">{authError}</small>}
            <button className="primary" disabled={authBusy}>
              {authBusy ? x('webSession.authenticating') : x('webSession.signIn')}
            </button>
            <small>{x('webSession.credentialsTemporary')}</small>
          </form>
        )}
      </div>
    </div>
  );
}
