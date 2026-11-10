import { useEffect, useRef, useState } from 'react';
import type { RdpSession } from '@axterm/plugin-api/remote-desktop';
import { Clipboard, LoaderCircle, Maximize2, RefreshCw, Shield } from 'lucide-react';
import { RdpCanvasAdapter } from './rdp-canvas-adapter.ts';
import { useI18n } from './i18n.tsx';

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

import type { ProtocolSurface } from './workspace-owner.ts';
import { cx } from './styles.ts';
export function RdpView({
  surface,
  session,
  active,
  onReload,
}: {
  surface: ProtocolSurface;
  session: RdpSession;
  active: boolean;
  onReload(): void;
}) {
  const { x } = useI18n();
  const [initial] = useState(() => ({ session, x }));
  const canvas = useRef<HTMLCanvasElement>(null);
  const adapter = useRef<RdpCanvasAdapter | undefined>(undefined);
  const [state, setState] = useState<'loading' | 'ready' | 'closed' | 'failed'>('loading');
  const [message, setMessage] = useState(x('remoteDesktop.connectingSecure', { protocol: 'RDP' }));
  const [scale, setScale] = useState(session.scaleViewport);
  const [size, setSize] = useState(`${session.width}x${session.height}`);

  useEffect(() => {
    const { session, x } = initial;
    const target = canvas.current;
    if (!target) return;
    const instance = new RdpCanvasAdapter(surface, session.id, target, session, {
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
    const detach = surface.attach(session.id, instance);
    adapter.current = instance;
    void instance.connect().catch(() => {});
    return () => {
      adapter.current = undefined;
      detach();
    };
  }, [surface, initial]);

  useEffect(() => {
    if (active) canvas.current?.focus();
  }, [active]);

  async function changeSize(value: string) {
    const [width, height] = value.split('x').map(Number);
    if (!width || !height) return;
    try {
      await surface.resize(session.id, width, height);
      setSize(value);
      adapter.current?.resize(width, height);
    } catch {
      setMessage(x('remoteDesktop.sessionFailed', { protocol: 'RDP' }));
    }
  }

  return (
    <div className={cx(`rdp-view ${scale ? 'scale-viewport' : ''}`)} data-rdp-session={session.id}>
      <div className={cx('rdp-toolbar')}>
        <span className={cx(`rdp-state ${state}`)}>
          {state === 'loading' && <LoaderCircle className={cx('spin')} size={13} />}
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
      <div className={cx('rdp-canvas-stage')}>
        <canvas ref={canvas} tabIndex={0} aria-label={`RDP ${session.title}`} />
      </div>
    </div>
  );
}
