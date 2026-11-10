import { useEffect, useRef, useState } from 'react';
import type { TerminalTransferRecoveryRecord } from '@axterm/plugin-api/terminals';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@axterm/ui/controls';
import type { PropsLocale } from '@axterm/ui';
import { transferCx as cx } from './transfer-styles.ts';

interface Props {
  records: readonly TerminalTransferRecoveryRecord[];
  x: PropsLocale<'terminals'>['t'];
  busy: boolean;
  error: string | undefined;
  onRemove(id: string): void;
  onForget(id: string): void;
  onClose(): void;
  retry?: (() => void) | undefined;
}

export function TerminalTransferRecoveryDialog({
  records,
  x,
  busy,
  error,
  onRemove,
  onForget,
  onClose,
  retry,
}: Props) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const [confirmation, setConfirmation] = useState<{ id: string; action: 'remove' | 'forget' }>();
  useEffect(() => closeButton.current?.focus(), []);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent asChild overlayClassName={cx('terminal-transfer-recovery-backdrop')}>
        <section className={cx('terminal-transfer-recovery-dialog')}>
          <DialogTitle asChild>
            <h2>{x('terminal.recoveryTitle')}</h2>
          </DialogTitle>
          <DialogDescription asChild>
            <p>{x('terminal.recoveryIntro')}</p>
          </DialogDescription>
          {error && <p role="alert">{error}</p>}
          {records.length === 0 && !error && <p>{x('terminal.recoveryEmpty')}</p>}
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
          {retry && (
            <button disabled={busy} onClick={retry}>
              {x('app.retry')}
            </button>
          )}
          <button ref={closeButton} type="button" disabled={busy} onClick={onClose}>
            {x('terminal.recoveryLeave')}
          </button>
        </section>
      </DialogContent>
    </Dialog>
  );
}
