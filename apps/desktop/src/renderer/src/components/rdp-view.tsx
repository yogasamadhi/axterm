import { useEffect, useRef, useState } from 'react';
import type { createRuntimeClient } from '@workspace/client';
import type { RdpSession } from '@workspace/contracts';
import { Clipboard, LoaderCircle, Maximize2, RefreshCw, Shield } from 'lucide-react';
import { RdpCanvasAdapter } from './rdp-canvas-adapter';
import { useI18n } from '../i18n/context';

const RESOLUTIONS = [
  [1024, 768],
  [1280, 720],
  [1280, 800],
  [1366, 768],
  [1440, 900],
  [1600, 900],
  [1920, 1080],
  [2560, 1440],
] as const;

export function RdpView({
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
  const [session, setSession] = useState<RdpSession>();
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let disposed = false;
    void client
      .rdpSession(sessionId)
      .then((value) => {
        if (!disposed) setSession(value);
      })
      .catch((error: unknown) => {
        if (!disposed)
          setLoadError(
            error instanceof Error
              ? error.message
              : x('remoteDesktop.loadError', { protocol: 'RDP' }),
          );
      });
    return () => {
      disposed = true;
    };
  }, [client, sessionId, x]);
  if (!session)
    return (
      <div className="rdp-view rdp-loading">
        <LoaderCircle className="spin" size={18} />
        <span>{loadError || x('remoteDesktop.preparing', { protocol: 'RDP' })}</span>
        {loadError && (
          <button onClick={onReload}>
            <RefreshCw size={13} /> {x('remoteDesktop.retry')}
          </button>
        )}
      </div>
    );
  return <ConnectedRdpView client={client} session={session} active={active} onReload={onReload} />;
}

function ConnectedRdpView({
  client,
  session,
  active,
  onReload,
}: {
  client: ReturnType<typeof createRuntimeClient>;
  session: RdpSession;
  active: boolean;
  onReload(): void;
}) {
  const { x } = useI18n();
  const canvas = useRef<HTMLCanvasElement>(null);
  const adapter = useRef<RdpCanvasAdapter | undefined>(undefined);
  const [state, setState] = useState<'loading' | 'ready' | 'closed' | 'failed'>('loading');
  const [message, setMessage] = useState(x('remoteDesktop.connectingSecure', { protocol: 'RDP' }));
  const [scale, setScale] = useState(session.scaleViewport);
  const [size, setSize] = useState(`${session.width}x${session.height}`);

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const instance = new RdpCanvasAdapter(client, session.id, target, session, {
      fallbackError: x('remoteDesktop.sessionFailed', { protocol: 'RDP' }),
      onState(next, detail) {
        setState(next);
        setMessage(
          detail ??
            (next === 'ready'
              ? x('remoteDesktop.connected')
              : next === 'closed'
                ? x('remoteDesktop.closed', { protocol: 'RDP' })
                : next === 'failed'
                  ? x('remoteDesktop.connectionFailed', { protocol: 'RDP' })
                  : x('remoteDesktop.connectingSecure', { protocol: 'RDP' })),
        );
      },
      onRemoteClipboard(text) {
        void navigator.clipboard.writeText(text);
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
    if (active) canvas.current?.focus();
  }, [active]);

  async function changeSize(value: string) {
    const [width, height] = value.split('x').map(Number);
    if (!width || !height) return;
    setSize(value);
    adapter.current?.resize(width, height);
    await client.resizeRdpSession(session.id, width, height).catch(() => undefined);
  }

  return (
    <div className={`rdp-view ${scale ? 'scale-viewport' : ''}`} data-rdp-session={session.id}>
      <div className="rdp-toolbar">
        <span className={`rdp-state ${state}`}>
          {state === 'loading' && <LoaderCircle className="spin" size={13} />}
          {message}
        </span>
        <label>
          {x('remoteDesktop.resolution')}
          <select value={size} onChange={(event) => void changeSize(event.target.value)}>
            {!RESOLUTIONS.some(([width, height]) => `${width}x${height}` === size) && (
              <option value={size}>{size}</option>
            )}
            {RESOLUTIONS.map(([width, height]) => (
              <option key={`${width}x${height}`} value={`${width}x${height}`}>
                {width} × {height}
              </option>
            ))}
          </select>
        </label>
        <button aria-pressed={scale} onClick={() => setScale((value) => !value)}>
          <Maximize2 size={13} /> {x('remoteDesktop.scaleToFit')}
        </button>
        {session.clipboard && (
          <button onClick={() => void adapter.current?.syncClipboard()}>
            <Clipboard size={13} /> {x('remoteDesktop.syncClipboard')}
          </button>
        )}
        <button onClick={() => adapter.current?.sendCtrlAltDelete()}>
          <Shield size={13} /> Ctrl+Alt+Del
        </button>
        <button onClick={onReload}>
          <RefreshCw size={13} /> {x('remoteDesktop.reconnect')}
        </button>
      </div>
      <div className="rdp-canvas-stage">
        <canvas ref={canvas} tabIndex={0} aria-label={`RDP ${session.title}`} />
      </div>
    </div>
  );
}
