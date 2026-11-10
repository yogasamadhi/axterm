import type { ReactNode } from 'react';
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
export function ErrorBanner({ text }: { text: string }) {
  return (
    <p role="alert" className={cx('error-banner')}>
      {text}
    </p>
  );
}
