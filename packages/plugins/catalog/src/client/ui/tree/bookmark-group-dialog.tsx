import { Dialog, DialogContent, DialogTitle } from '@axterm/ui/controls';
import styles from './bookmark-tree.module.css';
const classes = (value: string) =>
  value
    .split(/\s+/u)
    .filter(Boolean)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');
import { useId, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n.tsx';
export interface BookmarkGroupDraft {
  name: string;
  color: string | null;
  description: string;
}
const defaultColor = '#2fc7a1';
const palette = [
  '#2fc7a1',
  '#62d695',
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
  pending,
}: {
  title: string;
  submitLabel: string;
  initialValue?: Partial<BookmarkGroupDraft>;
  onSubmit(value: BookmarkGroupDraft): boolean | void | Promise<boolean | void>;
  onClose(): void;
  pending?: { readonly uncertain: boolean; retry(): Promise<boolean> };
}) {
  const { x } = useI18n();
  const titleId = useId();
  const [name, setName] = useState(initialValue?.name ?? '');
  const [color, setColor] = useState<string | null>(initialValue?.color ?? defaultColor);
  const [description, setDescription] = useState(initialValue?.description ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submittedHere, setSubmittedHere] = useState(false);
  const locked = busy || !!pending?.uncertain;
  async function retry() {
    if (busy || !submittedHere || !pending) return;
    setBusy(true);
    try {
      if (await pending.retry()) onClose();
      else setError(x('bookmarkTree.operationFailed'));
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked) return;
    setSubmittedHere(true);
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
      else setError(x('bookmarkTree.operationFailed'));
    } catch {
      setError(x('bookmarkTree.operationFailed'));
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
      <DialogContent
        asChild
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <section
          className={classes('modal bookmark-group-dialog')}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
        >
          <header>
            <DialogTitle asChild>
              <h2 id={titleId}>{title}</h2>
            </DialogTitle>
            <button disabled={locked} onClick={onClose} aria-label={x('common.close')}>
              ×
            </button>
          </header>
          <form className={classes('stack')} onSubmit={(event) => void submit(event)}>
            <label>
              {x('bookmarkGroup.name')}
              <input
                autoFocus
                value={name}
                disabled={locked}
                maxLength={80}
                autoComplete="off"
                onChange={(event) => {
                  setName(event.target.value);
                  setError('');
                }}
              />
            </label>
            <fieldset className={classes('bookmark-group-color-field')}>
              <legend>{x('bookmarkGroup.color')}</legend>
              <div className={classes('bookmark-group-palette')}>
                {palette.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-label={x('bookmarkGroup.selectColor', { color: value })}
                    aria-pressed={color === value}
                    disabled={locked}
                    style={{ backgroundColor: value }}
                    onClick={() => setColor(value)}
                  />
                ))}
                <button
                  className={classes('bookmark-group-color-clear')}
                  type="button"
                  aria-label={x('bookmarkGroup.clearColor')}
                  aria-pressed={color === null}
                  disabled={locked}
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
                disabled={locked}
                maxLength={1024}
                rows={3}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            {pending?.uncertain && (
              <p role="alert">
                {x('sshConfigImport.uncertain')}
                {submittedHere && (
                  <button type="button" disabled={busy} onClick={() => void retry()}>
                    {x('history.retryPending')}
                  </button>
                )}
              </p>
            )}
            {error && !pending?.uncertain && (
              <p role="alert" className={classes('toast error')}>
                {error}
              </p>
            )}
            <div className={classes('modal-actions')}>
              <button type="button" disabled={busy} onClick={onClose}>
                {x('common.cancel')}
              </button>
              <button className={classes('primary')} type="submit" disabled={locked}>
                {busy ? x('common.processing') : submitLabel}
              </button>
            </div>
          </form>
        </section>
      </DialogContent>
    </Dialog>
  );
}
