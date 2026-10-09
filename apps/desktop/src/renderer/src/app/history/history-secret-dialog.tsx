import { useEffect, useId, useState, type FormEvent } from 'react';
import type { ConnectionHistoryItem } from '@workspace/contracts';
import { connectionHistoryTarget } from './history-model';
import { useI18n } from '../../i18n/context';

export function HistorySecretDialog({
  item,
  onSubmit,
  onClose,
}: {
  item: ConnectionHistoryItem;
  onSubmit(secret: string): Promise<boolean>;
  onClose(): void;
}) {
  const { x } = useI18n();
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [busy, onClose]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const secret = String(new FormData(form).get('secret') ?? '');
    if (!secret) {
      setError(
        item.authType === 'keyboardInteractive'
          ? x('history.enterInteractiveResponse')
          : x('history.enterPassword'),
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (await onSubmit(secret)) {
        form.reset();
        onClose();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : x('history.reconnectFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header>
          <h2 id={titleId}>{x('history.reconnectNamed', { name: item.name })}</h2>
          <button disabled={busy} onClick={onClose} aria-label={x('common.close')}>
            ×
          </button>
        </header>
        <form className="stack" onSubmit={(event) => void submit(event)}>
          <p className="form-hint">{connectionHistoryTarget(item)}</p>
          <label>
            {item.authType === 'keyboardInteractive'
              ? x('history.interactiveResponse')
              : x('history.oneTimePassword')}
            <input
              autoFocus
              name="secret"
              type="password"
              autoComplete="off"
              maxLength={131_072}
              disabled={busy}
              onInput={() => setError('')}
            />
          </label>
          <small>{x('history.secretNotSaved')}</small>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={onClose}>
              {x('common.cancel')}
            </button>
            <button className="primary" type="submit" disabled={busy}>
              {busy ? x('history.connecting') : x('history.connect')}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
