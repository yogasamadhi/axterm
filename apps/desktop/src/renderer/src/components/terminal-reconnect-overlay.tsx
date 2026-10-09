import { useEffect, useMemo, useState } from 'react';
import type { Connection } from '@workspace/contracts';
import { RefreshCw, X } from 'lucide-react';
import { terminalReconnectPresentation } from './terminal-reconnect';
import './terminal-reconnect-overlay.css';
import { useI18n } from '../i18n/context';

export function TerminalReconnectOverlay({
  connection,
  retrying = false,
  canceling = false,
  onRetry,
  onCancel,
}: {
  connection: Connection | undefined;
  retrying?: boolean;
  canceling?: boolean;
  onRetry(): void;
  onCancel(): void;
}) {
  const { x } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const presentation = useMemo(
    () => terminalReconnectPresentation(connection, now),
    [connection, now],
  );
  const message =
    presentation?.message === 'RECONNECTING'
      ? presentation.countdown === null
        ? x('terminal.autoReconnect')
        : x('terminal.autoReconnectCountdown', { seconds: presentation.countdown })
      : presentation
        ? x('terminal.connectionLost', {
            detail: presentation.errorCode ? ` · ${presentation.errorCode}` : '',
          })
        : '';

  useEffect(() => {
    if (connection?.state !== 'reconnecting' || !connection.nextReconnectAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [connection?.nextReconnectAt, connection?.state]);

  if (!presentation) return null;
  return (
    <div
      className={`terminal-reconnect-overlay ${presentation.tone}`}
      role={presentation.tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <span className="terminal-reconnect-message">{message}</span>
      <span className="terminal-reconnect-actions">
        {presentation.canRetry && (
          <button disabled={retrying || canceling} onClick={onRetry}>
            <RefreshCw className={retrying ? 'spin' : ''} size={12} />
            {retrying ? x('terminal.reconnecting') : x('terminal.reconnectNow')}
          </button>
        )}
        {presentation.canCancel && (
          <button disabled={retrying || canceling} onClick={onCancel}>
            <X size={12} />
            {canceling ? x('terminal.cancelingReconnect') : x('terminal.stopReconnect')}
          </button>
        )}
      </span>
    </div>
  );
}
