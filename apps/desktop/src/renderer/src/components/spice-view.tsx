import { useEffect, useRef, useState } from 'react';
import type { createRuntimeClient } from '@workspace/client';
import type { SpiceSession } from '@workspace/contracts';
import { Eye, LoaderCircle, Maximize2, RefreshCw, Shield } from 'lucide-react';
import { SpiceCanvasAdapter } from './spice-canvas-adapter';
import { useI18n } from '../i18n/context';

export function SpiceView({
  client,
  sessionId,
  onReload,
}: {
  client: ReturnType<typeof createRuntimeClient>;
  sessionId: string;
  active: boolean;
  onReload(): void;
}) {
  const { x } = useI18n();
  const [session, setSession] = useState<SpiceSession>();
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let disposed = false;
    void client
      .spiceSession(sessionId)
      .then((value) => {
        if (!disposed) setSession(value);
      })
      .catch((error: unknown) => {
        if (!disposed)
          setLoadError(
            error instanceof Error
              ? error.message
              : x('remoteDesktop.loadError', { protocol: 'SPICE' }),
          );
      });
    return () => {
      disposed = true;
    };
  }, [client, sessionId, x]);
  if (!session)
    return (
      <div className="rdp-view rdp-loading spice-view">
        <LoaderCircle className="spin" size={18} />
        <span>{loadError || x('remoteDesktop.preparing', { protocol: 'SPICE' })}</span>
        {loadError && (
          <button onClick={onReload}>
            <RefreshCw size={13} /> {x('remoteDesktop.retry')}
          </button>
        )}
      </div>
    );
  return <ConnectedSpiceView client={client} session={session} onReload={onReload} />;
}

function ConnectedSpiceView({
  client,
  session,
  onReload,
}: {
  client: ReturnType<typeof createRuntimeClient>;
  session: SpiceSession;
  onReload(): void;
}) {
  const { x } = useI18n();
  const stage = useRef<HTMLDivElement>(null);
  const adapter = useRef<SpiceCanvasAdapter | undefined>(undefined);
  const [state, setState] = useState<'loading' | 'ready' | 'closed' | 'failed'>('loading');
  const [message, setMessage] = useState(
    x('remoteDesktop.connectingSecure', { protocol: 'SPICE' }),
  );
  const [viewOnly, setViewOnly] = useState(session.viewOnly);
  const [scale, setScale] = useState(session.scaleViewport);

  useEffect(() => {
    const target = stage.current;
    if (!target) return;
    const instance = new SpiceCanvasAdapter(client, session.id, target, session, {
      messages: {
        connecting: x('remoteDesktop.connectingSecure', { protocol: 'SPICE' }),
        connected: x('remoteDesktop.connected'),
        closed: x('remoteDesktop.closed', { protocol: 'SPICE' }),
        failed: x('remoteDesktop.connectionFailed', { protocol: 'SPICE' }),
        sessionFailed: x('remoteDesktop.sessionFailed', { protocol: 'SPICE' }),
      },
      onState(next, detail) {
        setState(next);
        setMessage(detail || next);
      },
    });
    adapter.current = instance;
    void instance.connect();
    return () => {
      adapter.current = undefined;
      instance.dispose();
    };
  }, [client, session, x]);

  return (
    <div className="rdp-view spice-view" data-spice-session={session.id}>
      <div className="rdp-toolbar spice-toolbar">
        <span className={`rdp-state ${state}`}>
          {state === 'loading' && <LoaderCircle className="spin" size={13} />}
          {message}
        </span>
        <button
          aria-pressed={viewOnly}
          onClick={() => {
            setViewOnly((value) => {
              adapter.current?.setViewOnly(!value);
              return !value;
            });
          }}
        >
          <Eye size={13} /> {x('remoteDesktop.readOnly')}
        </button>
        <button
          aria-pressed={scale}
          onClick={() => {
            setScale((value) => {
              adapter.current?.setScaleViewport(!value);
              return !value;
            });
          }}
        >
          <Maximize2 size={13} /> {x('remoteDesktop.scaleToFit')}
        </button>
        {!viewOnly && (
          <button onClick={() => adapter.current?.sendCtrlAltDelete()}>
            <Shield size={13} /> Ctrl+Alt+Del
          </button>
        )}
        <button onClick={onReload}>
          <RefreshCw size={13} /> {x('remoteDesktop.reconnect')}
        </button>
      </div>
      <div
        ref={stage}
        className={`rdp-canvas-stage spice-canvas-stage ${scale ? 'scale-viewport' : ''}`}
        aria-label={`SPICE ${session.title}`}
      />
    </div>
  );
}
