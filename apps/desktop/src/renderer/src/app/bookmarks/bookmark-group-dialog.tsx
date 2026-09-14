import { useEffect, useId, useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n/context';

export interface BookmarkGroupDraft {
  name: string;
  color: string | null;
  description: string;
}

const defaultColor = '#0366d6';
const palette = [
  '#0366d6',
  '#28a745',
  '#d73a49',
  '#ffab4a',
  '#ffd33d',
  '#6f42c1',
  '#e99695',
  '#24292e',
  '#6a737d',
] as const;

export function BookmarkGroupDialog({
  title,
  submitLabel,
  initialValue,
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  initialValue?: Partial<BookmarkGroupDraft>;
  onSubmit(value: BookmarkGroupDraft): boolean | void | Promise<boolean | void>;
  onClose(): void;
}) {
  const { x } = useI18n();
  const titleId = useId();
  const [name, setName] = useState(initialValue?.name ?? '');
  const [color, setColor] = useState<string | null>(initialValue?.color ?? defaultColor);
  const [description, setDescription] = useState(initialValue?.description ?? '');
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
    const normalized = name.trim();
    if (!normalized) {
      setError(x('bookmarkGroup.enterName'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await onSubmit({ name: normalized, color, description });
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
        className="modal bookmark-group-dialog"
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
            {x('bookmarkGroup.name')}
            <input
              autoFocus
              value={name}
              disabled={busy}
              maxLength={80}
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
                setError('');
              }}
            />
          </label>
          <fieldset className="bookmark-group-color-field">
            <legend>{x('bookmarkGroup.color')}</legend>
            <div className="bookmark-group-palette">
              {palette.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={x('bookmarkGroup.selectColor', { color: value })}
                  aria-pressed={color === value}
                  disabled={busy}
                  style={{ backgroundColor: value }}
                  onClick={() => setColor(value)}
                />
              ))}
              <button
                className="bookmark-group-color-clear"
                type="button"
                aria-label={x('bookmarkGroup.clearColor')}
                aria-pressed={color === null}
                disabled={busy}
                onClick={() => setColor(null)}
              >
                ×
              </button>
            </div>
          </fieldset>
          <label>
            {x('bookmarkGroup.description')}
            <textarea
              value={description}
              disabled={busy}
              maxLength={1_024}
              rows={3}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" disabled={busy} onClick={onClose}>
              {x('common.cancel')}
            </button>
            <button className="primary" type="submit" disabled={busy}>
              {busy ? x('common.processing') : submitLabel}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
