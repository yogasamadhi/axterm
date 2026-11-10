import { Dialog, DialogContent, DialogTitle } from '@axterm/ui/controls';
import { cx } from './styles.ts';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useI18n } from './i18n.tsx';

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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent asChild aria-describedby={undefined} overlayClassName={cx('modal-backdrop')}>
        <section
          className={cx('modal text-input-dialog')}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <header>
            <DialogTitle asChild>
              <h2 id={titleId}>{title}</h2>
            </DialogTitle>
            <button disabled={busy} onClick={onClose} aria-label={x('common.close')}>
              ×
            </button>
          </header>
          <form className={cx('stack')} onSubmit={(event) => void submit(event)}>
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
            {error && <p className={cx('form-error')}>{error}</p>}
            <div className={cx('modal-actions')}>
              <button type="button" disabled={busy} onClick={onClose}>
                {x('common.cancel')}
              </button>
              <button className={cx('primary')} type="submit" disabled={busy}>
                {busy ? x('common.processing') : (submitLabel ?? x('common.confirm'))}
              </button>
            </div>
          </form>
        </section>
      </DialogContent>
    </Dialog>
  );
}
