import { useEffect, useRef, useState } from 'react';
import type { createRuntimeClient } from '@workspace/client';
import type { VncSession } from '@workspace/contracts';
import { Clipboard, Crop, Eye, LoaderCircle, Maximize2, RefreshCw, Shield } from 'lucide-react';
import { VncCanvasAdapter } from './vnc-canvas-adapter';
import { useI18n } from '../i18n/context';

export function VncView({
  client,
  sessionId,
  active,
  onReload,
}: {
  client: ReturnType<typeof createRuntimeClient>;
  sessionId: string;
  active: boolean;
  onReload(): void;
}) {
  const { x } = useI18n();
  const [session, setSession] = useState<VncSession>();
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let disposed = false;
    void client
      .vncSession(sessionId)
      .then((value) => {
        if (!disposed) setSession(value);
      })
      .catch((error: unknown) => {
        if (!disposed)
          setLoadError(
            error instanceof Error
              ? error.message
              : x('remoteDesktop.loadError', { protocol: 'VNC' }),
          );
      });
    return () => {
      disposed = true;
    };
  }, [client, sessionId, x]);
  if (!session)
    return (
      <div className="rdp-view rdp-loading vnc-view">
        <LoaderCircle className="spin" size={18} />
        <span>{loadError || x('remoteDesktop.preparing', { protocol: 'VNC' })}</span>
        {loadError && (
          <button onClick={onReload}>
            <RefreshCw size={13} /> {x('remoteDesktop.retry')}
          </button>
        )}
      </div>
    );
  return <ConnectedVncView client={client} session={session} active={active} onReload={onReload} />;
}

function ConnectedVncView({
  client,
  session,
  active,
  onReload,
}: {
  client: ReturnType<typeof createRuntimeClient>;
  session: VncSession;
  active: boolean;
  onReload(): void;
}) {
  const { x } = useI18n();
  const stage = useRef<HTMLDivElement>(null);
  const adapter = useRef<VncCanvasAdapter | undefined>(undefined);
  const [state, setState] = useState<'loading' | 'ready' | 'closed' | 'failed'>('loading');
  const [message, setMessage] = useState(x('remoteDesktop.connectingSecure', { protocol: 'VNC' }));
  const [viewOnly, setViewOnly] = useState(session.viewOnly);
  const [clip, setClip] = useState(session.clipViewport);
  const [scale, setScale] = useState(session.scaleViewport);
  const [quality, setQuality] = useState(session.qualityLevel);
  const [compression, setCompression] = useState(session.compressionLevel);
  const [verification, setVerification] = useState('');

  useEffect(() => {
    const target = stage.current;
    if (!target) return;
    const instance = new VncCanvasAdapter(client, session.id, target, session, {
      messages: {
        connected: x('remoteDesktop.connected'),
        closed: x('remoteDesktop.closed', { protocol: 'VNC' }),
        disconnected: x('remoteDesktop.unexpectedDisconnect', { protocol: 'VNC' }),
        sessionFailed: x('remoteDesktop.sessionFailed', { protocol: 'VNC' }),
        securityFailure: (status) =>
          x('remoteDesktop.securityFailure', {
            protocol: 'VNC',
            status: status === undefined ? '' : ` (${status})`,
          }),
        credentialsRequired: (types) =>
          x('remoteDesktop.credentialsRequired', {
            types: types.join(', ') || x('remoteDesktop.unknownCredentialType'),
          }),
        serverIdentity: x('remoteDesktop.serverIdentityLabel'),
      },
      onState(next, detail) {
        setState(next);
        setMessage(
          detail ||
            (next === 'loading' ? x('remoteDesktop.connectingSecure', { protocol: 'VNC' }) : next),
        );
      },
      onRemoteClipboard(text) {
        void navigator.clipboard.writeText(text);
      },
      onDesktopName(name) {
        setMessage(x('remoteDesktop.connectedNamed', { name }));
      },
      onServerVerification(summary) {
        setVerification(summary);
        setMessage(x('remoteDesktop.verifyingServer'));
      },
    });
    adapter.current = instance;
    void instance.connect();
    return () => {
      adapter.current = undefined;
      instance.dispose();
    };
  }, [client, session, x]);

  useEffect(() => {
    if (active) adapter.current?.focus();
    else adapter.current?.blur();
  }, [active]);

  const setViewOnlyValue = (value: boolean) => {
    setViewOnly(value);
    adapter.current?.setViewOnly(value);
  };
  const setClipValue = (value: boolean) => {
    setClip(value);
    adapter.current?.setClipViewport(value);
  };
  const setScaleValue = (value: boolean) => {
    setScale(value);
    adapter.current?.setScaleViewport(value);
  };

  return (
    <div className="rdp-view vnc-view" data-vnc-session={session.id}>
      <div className="rdp-toolbar vnc-toolbar">
        <span className={`rdp-state ${state}`}>
          {state === 'loading' && <LoaderCircle className="spin" size={13} />}
          {message}
        </span>
        <button aria-pressed={viewOnly} onClick={() => setViewOnlyValue(!viewOnly)}>
          <Eye size={13} /> {x('remoteDesktop.readOnly')}
        </button>
        <button aria-pressed={clip} onClick={() => setClipValue(!clip)}>
          <Crop size={13} /> {x('remoteDesktop.clip')}
        </button>
        <button aria-pressed={scale} onClick={() => setScaleValue(!scale)}>
          <Maximize2 size={13} /> {x('remoteDesktop.scaleToFit')}
        </button>
        <label>
          {x('remoteDesktop.quality')}
          <select
            value={quality}
            onChange={(event) => {
              const value = Number(event.target.value);
              setQuality(value);
              adapter.current?.setQualityLevel(value);
            }}
          >
            {Array.from({ length: 10 }, (_, value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          {x('remoteDesktop.compression')}
          <select
            value={compression}
            onChange={(event) => {
              const value = Number(event.target.value);
              setCompression(value);
              adapter.current?.setCompressionLevel(value);
            }}
          >
            {Array.from({ length: 10 }, (_, value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        {session.clipboard && !viewOnly && (
          <button onClick={() => void adapter.current?.syncClipboard()}>
            <Clipboard size={13} /> {x('remoteDesktop.syncClipboard')}
          </button>
        )}
        {!viewOnly && (
          <button onClick={() => adapter.current?.sendCtrlAltDelete()}>
            <Shield size={13} /> Ctrl+Alt+Del
          </button>
        )}
        <button onClick={onReload}>
          <RefreshCw size={13} /> {x('remoteDesktop.reconnect')}
        </button>
      </div>
      {verification && (
        <div className="vnc-verification" role="alert">
          <Shield size={15} />
          <span>{x('remoteDesktop.serverIdentity', { identity: verification })}</span>
          <button
            onClick={() => {
              adapter.current?.approveServer();
              setVerification('');
              setMessage(x('remoteDesktop.completingSecurity'));
            }}
          >
            {x('remoteDesktop.confirmContinue')}
          </button>
        </div>
      )}
      <div
        ref={stage}
        className="rdp-canvas-stage vnc-canvas-stage"
        aria-label={`VNC ${session.title}`}
        onMouseDown={() => void adapter.current?.syncClipboard()}
      />
    </div>
  );
}
