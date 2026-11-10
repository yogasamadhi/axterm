import type { TranslateNS } from '@axterm/ui';
import type {} from './locales.ts';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { TerminalPasteReview } from './paste.ts';
import styles from './ui.module.css';
const cx = (name: string) => name + ' ' + (styles[name] ?? '');
/** Retained review behavior. Clipboard text stays in the owning renderer's bounded transient refs. */
export function TerminalPasteDialog({
  t,
  localeId,
  review,
  confirm,
  cancel,
}: {
  t: TranslateNS<'terminals'>;
  localeId: string;
  review: TerminalPasteReview;
  confirm(): void;
  cancel(): void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    confirmButton.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div
      className={cx('terminal-paste-backdrop')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <section
        ref={dialog}
        className={cx('terminal-paste-dialog')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-paste-title"
        aria-describedby="terminal-paste-description"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
          if (event.key === 'Tab') {
            const elements = dialog.current?.querySelectorAll<HTMLElement>('button,[tabindex="0"]');
            const first = elements?.[0];
            const last = elements?.[elements.length - 1];
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
            <span className={cx('eyebrow')}>{t('pasteEyebrow')}</span>
            <h2 id="terminal-paste-title">{t('pasteTitle')}</h2>
          </div>
          <span>
            {t('pasteStats', {
              characters: review.characters.toLocaleString(localeId),
              lines: review.lines.toLocaleString(localeId),
            })}
          </span>
        </header>
        <p id="terminal-paste-description">{t('pasteDescription')}</p>
        <pre tabIndex={0} aria-label={t('pastePreview')}>
          {review.preview}
        </pre>
        {review.truncated && <small>{t('pasteTruncated')}</small>}
        <footer>
          <button type="button" onClick={cancel}>
            {t('cancel')}
          </button>
          <button type="button" className={cx('primary')} ref={confirmButton} onClick={confirm}>
            {t('confirmPaste')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
