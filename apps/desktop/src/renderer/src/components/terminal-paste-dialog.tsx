import { useEffect, useRef, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { TerminalPasteReview } from './terminal-paste';
import { useI18n } from '../i18n/context';

export function TerminalPasteDialog({
  review,
  onConfirm,
  onCancel,
}: {
  review: TerminalPasteReview;
  onConfirm(): void;
  onCancel(): void;
}) {
  const { language, t, x } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const reason =
    review.reason === 'long-multiline'
      ? x('terminal.pasteLongMultiline')
      : review.reason === 'long'
        ? x('terminal.pasteLong')
        : x('terminal.pasteMultiline');

  return createPortal(
    <div
      className="terminal-paste-backdrop"
      onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className="terminal-paste-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-paste-title"
        aria-describedby="terminal-paste-description"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          } else if (event.key === 'Tab') {
            const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
            );
            const first = focusable?.[0];
            const last = focusable?.[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header>
          <div>
            <span className="eyebrow">PASTE PROTECTION</span>
            <h2 id="terminal-paste-title">{x('terminal.pasteTitle')}</h2>
          </div>
          <span className="terminal-paste-stat">
            {x('terminal.pasteStats', {
              characters: review.characters.toLocaleString(language),
              lines: review.lines.toLocaleString(language),
            })}
          </span>
        </header>
        <p id="terminal-paste-description">{x('terminal.pasteReview', { reason })}</p>
        <pre tabIndex={0} aria-label={x('terminal.pastePreview')}>
          {review.preview}
        </pre>
        {review.truncated && <small>{x('terminal.pasteTruncated')}</small>}
        <footer>
          <button ref={cancelRef} type="button" onClick={onCancel}>
            {t('cancel', 'Cancel')}
          </button>
          <button className="primary" type="button" onClick={onConfirm}>
            {x('terminal.confirmPaste')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
