import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@axterm/ui/controls';
import { useI18n } from './i18n.tsx';
import { cx } from './styles.ts';
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
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={cx('panel-page ' + (className ?? ''))}>
      <header className={cx('panel-heading')}>
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
  children: ReactNode;
  className?: string | undefined;
  chrome?: ReactNode;
  portal?: boolean;
}) {
  const { x } = useI18n();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent asChild overlayClassName={cx('modal-backdrop')}>
        <section className={cx('modal ' + (className ?? ''))}>
          <header>
            <DialogTitle asChild>
              <h2>{title}</h2>
            </DialogTitle>
            {chrome}
            <button aria-label={x('common.close')} onClick={onClose}>
              ×
            </button>
          </header>
          {children}
        </section>
      </DialogContent>
    </Dialog>
  );
}
export function ErrorBanner({ message, text }: { message?: string; text?: string }) {
  return (message ?? text) ? (
    <div className={cx('error-banner')} role="alert">
      {message ?? text}
    </div>
  ) : null;
}
export function EmptyState({
  icon: Icon,
  title,
  text,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
}) {
  return (
    <div className={cx('empty-state')}>
      <Icon size={26} />
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}
