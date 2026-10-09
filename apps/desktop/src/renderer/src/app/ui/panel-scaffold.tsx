import type { Server } from 'lucide-react';
import { ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/context';

export function PanelFrame({
  className,
  eyebrow,
  title,
  description,
  action,
  children,
}: {
  className?: string | undefined;
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={className ? `panel-page ${className}` : 'panel-page'}>
      <header className="panel-heading">
        <div>
          <small>{eyebrow}</small>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {action}
      </header>
      {children}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  className,
  chrome,
}: {
  title: string;
  onClose(): void;
  children: React.ReactNode;
  className?: string;
  chrome?: ReactNode;
}) {
  const { x } = useI18n();
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  const [restoreFocus] = useState<HTMLElement | undefined>(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
  );
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const focusableSelector = [
      'button:not(:disabled)',
      'input:not(:disabled):not([type="hidden"])',
      'select:not(:disabled)',
      'textarea:not(:disabled)',
      'a[href]',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const focusable = () =>
      [...(dialog.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])].filter(
        (element) => element.getClientRects().length > 0,
      );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      if (!controls.length) {
        event.preventDefault();
        dialog.current?.focus();
        return;
      }
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    const focusFrame = requestAnimationFrame(() => {
      if (dialog.current?.contains(document.activeElement)) return;
      const preferred = dialog.current?.querySelector<HTMLElement>('[autofocus],[data-autofocus]');
      (preferred ?? focusable()[0] ?? dialog.current)?.focus();
    });
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      cancelAnimationFrame(focusFrame);
      if (restoreFocus)
        requestAnimationFrame(() => {
          if (restoreFocus.isConnected) restoreFocus.focus();
        });
    };
  }, [restoreFocus]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className={className ? `modal ${className}` : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        {chrome}
        <header>
          <h2>{title}</h2>
          <button aria-label={x('common.close')} onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof Server;
  title: string;
  text: string;
}) {
  return (
    <div className="empty-state">
      <Icon size={26} />
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

export function ErrorBanner({ text }: { text: string }) {
  return (
    <div className="error-banner" role="alert">
      <ShieldAlert size={14} /> {text}
    </div>
  );
}
