import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface FileContextMenuItem {
  id: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
  onSelect(): void | Promise<void>;
}

export function FileContextMenu({
  x,
  y,
  label,
  items,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  items: FileContextMenuItem[];
  onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const closeFromPointer = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const closeFromBlur = () => onClose();
    document.addEventListener('pointerdown', closeFromPointer, true);
    window.addEventListener('blur', closeFromBlur);
    return () => {
      document.removeEventListener('pointerdown', closeFromPointer, true);
      window.removeEventListener('blur', closeFromBlur);
    };
  }, [onClose]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ];
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1) % buttons.length
            : (current <= 0 ? buttons.length : current) - 1;
    buttons[next]?.focus();
  }

  const left = Math.max(6, Math.min(x, window.innerWidth - 226));
  const top = Math.max(6, Math.min(y, window.innerHeight - Math.min(items.length * 33 + 8, 456)));
  return createPortal(
    <div
      ref={menu}
      className="file-context-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={{ left, top }}
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`${item.danger ? 'danger-item' : ''} ${item.separatorBefore ? 'separator-before' : ''}`}
          disabled={item.disabled}
          onClick={() => {
            onClose();
            void item.onSelect();
          }}
        >
          {item.icon}
          <span>{item.label}</span>
          {item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
