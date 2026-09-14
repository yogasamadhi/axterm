import { useEffect, useId, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n/context';

export function TextInputDialog({
  title,
  label,
  initialValue = '',
  placeholder,
  submitLabel,
  validate,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  validate?(value: string): string | undefined;
  onSubmit(value: string): boolean | void | Promise<boolean | void>;
  onClose(): void;
}) {
  const { x } = useI18n();
  const titleId = useId();
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = value.trim();
    const validationError = validate?.(normalized);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await onSubmit(normalized);
      if (result !== false) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : x('common.operationFailed'));
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
      <section
        className="modal text-input-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header>
          <h2 id={titleId}>{title}</h2>
          <button disabled={busy} onClick={onClose} aria-label={x('common.close')}>
            ×
          </button>
        </header>
        <form className="stack" onSubmit={(event) => void submit(event)}>
          <label>
            {label}
            <input
              autoFocus
              value={value}
              placeholder={placeholder}
              disabled={busy}
              autoComplete="off"
              onChange={(event) => {
                setValue(event.target.value);
                setError('');
              }}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={onClose}>
              {x('common.cancel')}
            </button>
            <button className="primary" type="submit" disabled={busy}>
              {busy ? x('common.processing') : (submitLabel ?? x('common.confirm'))}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
