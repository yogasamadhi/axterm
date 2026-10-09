import { useEffect, useRef, useState } from 'react';
import type { TerminalTransferRecoveryRecord } from '@workspace/contracts';
import { useI18n } from '../i18n/context';

interface Props {
  records: TerminalTransferRecoveryRecord[];
  busy: boolean;
  error: string | undefined;
  onRemove(id: string): void;
  onForget(id: string): void;
  onClose(): void;
}

export function TerminalTransferRecoveryDialog({
  records,
  busy,
  error,
  onRemove,
  onForget,
  onClose,
}: Props) {
  const { x } = useI18n();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [confirmation, setConfirmation] = useState<{ id: string; action: 'remove' | 'forget' }>();
  useEffect(() => closeButton.current?.focus(), []);
  return (
    <div
      className="terminal-transfer-recovery-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onClose();
      }}
    >
      <section
        className="terminal-transfer-recovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-transfer-recovery-title"
      >
        <h2 id="terminal-transfer-recovery-title">{x('terminal.recoveryTitle')}</h2>
        <p>{x('terminal.recoveryIntro')}</p>
        {error && <p role="alert">{error}</p>}
        {records.length === 0 && <p>{x('terminal.recoveryEmpty')}</p>}
        <ul>
          {records.map((record) => (
            <li key={record.id}>
              <div>
                <strong>{record.name}</strong>
                <span>
                  {record.protocol.toUpperCase()} · {record.bytes} B ·{' '}
                  {new Date(record.createdAt).toLocaleString()}
                </span>
                {record.state !== 'verified' && (
                  <span>
                    {x(
                      record.state === 'expired'
                        ? 'terminal.recoveryExpired'
                        : record.state === 'absent'
                          ? 'terminal.recoveryAbsent'
                          : 'terminal.recoveryUnverified',
                    )}
                  </span>
                )}
              </div>
              <div>
                {record.state === 'verified' &&
                  (confirmation?.id === record.id && confirmation.action === 'remove' ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setConfirmation(undefined);
                        onRemove(record.id);
                      }}
                    >
                      {x('terminal.recoveryConfirmRemove')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmation({ id: record.id, action: 'remove' })}
                    >
                      {x('terminal.recoveryRemove')}
                    </button>
                  ))}
                {confirmation?.id === record.id && confirmation.action === 'forget' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setConfirmation(undefined);
                      onForget(record.id);
                    }}
                  >
                    {x('terminal.recoveryConfirmForget')}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmation({ id: record.id, action: 'forget' })}
                  >
                    {x('terminal.recoveryForget')}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        <p>{x('terminal.recoveryManual')}</p>
        <button ref={closeButton} type="button" disabled={busy} onClick={onClose}>
          {x('terminal.recoveryLeave')}
        </button>
      </section>
    </div>
  );
}
