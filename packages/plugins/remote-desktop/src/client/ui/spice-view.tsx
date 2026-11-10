import { useEffect, useRef, useState } from 'react';
import type { SpiceSession } from '@axterm/plugin-api/remote-desktop';
import { Eye, LoaderCircle, Maximize2, RefreshCw, Shield } from 'lucide-react';
import { SpiceCanvasAdapter } from './spice-canvas-adapter.ts';
import { useI18n } from './i18n.tsx';

import type { ProtocolSurface } from './workspace-owner.ts';
import { cx } from './styles.ts';
export function SpiceView({
  surface,
  session,
  active,
  onReload,
}: {
  surface: ProtocolSurface;
  session: SpiceSession;
  active: boolean;
  onReload(): void;
}) {
  const { x } = useI18n();
  const [initial] = useState(() => ({ session, x }));
  const stage = useRef<HTMLDivElement>(null);
  const adapter = useRef<SpiceCanvasAdapter | undefined>(undefined);
  const [state, setState] = useState<'loading' | 'ready' | 'closed' | 'failed'>('loading');
  const [message, setMessage] = useState(
    x('remoteDesktop.connectingSecure', { protocol: 'SPICE' }),
  );
  const [viewOnly, setViewOnly] = useState(session.viewOnly);
  const [scale, setScale] = useState(session.scaleViewport);

  useEffect(() => {
    const { session, x } = initial;
    const target = stage.current;
    if (!target) return;
    const instance = new SpiceCanvasAdapter(surface, session.id, target, session, {
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
    const detach = surface.attach(session.id, instance);
    adapter.current = instance;
    void instance.connect().catch(() => {});
    return () => {
      adapter.current = undefined;
      detach();
    };
  }, [surface, initial]);

  useEffect(() => {
    if (
      !active &&
      stage.current?.contains(document.activeElement) &&
      document.activeElement instanceof HTMLElement
    )
      document.activeElement.blur();
  }, [active]);
  return (
    <div className={cx('rdp-view spice-view')} data-spice-session={session.id}>
      <div className={cx('rdp-toolbar spice-toolbar')}>
        <span className={cx(`rdp-state ${state}`)}>
          {state === 'loading' && <LoaderCircle className={cx('spin')} size={13} />}
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
        className={cx(`rdp-canvas-stage spice-canvas-stage ${scale ? 'scale-viewport' : ''}`)}
        aria-label={`SPICE ${session.title}`}
      />
    </div>
  );
}
