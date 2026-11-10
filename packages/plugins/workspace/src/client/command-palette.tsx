import { useEffect, useId, useRef, useState } from 'react';
import { Command, X } from 'lucide-react';

import type { WorkspacePaletteItem } from '@axterm/ui/workspace';
import type { PaletteTranslate } from './palette-locales.ts';
import styles from './palette.module.css';
const cx = (...values: string[]) =>
  values.map((value) => `${value} ${styles[value] ?? ''}`).join(' ');
import { paletteResults, MAX_PALETTE_RESULTS, type PaletteUsage } from './palette-model';

export function CommandPalette({
  items,
  usage,
  x,
  onClose,
  onExecute,
}: {
  items: readonly WorkspacePaletteItem[];
  usage: readonly PaletteUsage[];
  x: PaletteTranslate;
  onClose(): void;
  onExecute(item: WorkspacePaletteItem): Promise<boolean>;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const restoreFocus = useRef(true);
  const dispatching = useRef(false);
  const [returnFocus] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : undefined,
  );
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<string>();
  const [error, setError] = useState(false);
  const results = paletteResults(items, query, usage);
  const activeIndex = Math.max(
    0,
    results.items.findIndex((item) => item.id === selection),
  );
  const active = results.items[activeIndex];
  const activeId = active?.id;
  const optionId = (index: number) => `${id}-option-${index}`;
  useEffect(
    () => () => {
      if (restoreFocus.current && returnFocus?.isConnected)
        returnFocus.focus({ preventScroll: true });
    },
    [returnFocus],
  );
  useEffect(() => {
    if (activeId)
      document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeId, activeIndex, id]);
  useEffect(() => {
    const focus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || dialog.current?.contains(target)) return;
      if (target.closest('[role="dialog"][aria-modal="true"]')) {
        restoreFocus.current = false;
        onClose();
      } else input.current?.focus();
    };
    document.addEventListener('focusin', focus);
    return () => document.removeEventListener('focusin', focus);
  }, [onClose]);

  const execute = async (item: WorkspacePaletteItem) => {
    if (item.unavailableReason || dispatching.current) return;
    dispatching.current = true;
    let accepted = false;
    try {
      accepted = await onExecute(item);
    } catch {
      /* Report only a local action failure. */
    }
    if (!accepted) {
      dispatching.current = false;
      setError(true);
      return;
    }
    restoreFocus.current = false;
    onClose();
  };
  return (
    <div
      className={cx('palette-backdrop')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className={cx('command-palette')}
        role="dialog"
        aria-modal="true"
        aria-label={x('shortcuts.commandPalette')}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === 'Tab') {
            event.preventDefault();
            const close = event.currentTarget.querySelector<HTMLButtonElement>('.palette-close');
            if (document.activeElement === input.current) close?.focus();
            else input.current?.focus();
          }
        }}
      >
        <div className={cx('palette-search-row')}>
          <Command size={16} aria-hidden="true" />
          <input
            ref={input}
            autoFocus
            role="combobox"
            aria-label={x('app.commandPalettePlaceholder')}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${id}-results`}
            aria-activedescendant={active ? optionId(activeIndex) : undefined}
            placeholder={x('app.commandPalettePlaceholder')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelection(undefined);
              setError(false);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const length = results.items.length;
                if (!length) return;
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? length - 1
                      : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + length) % length;
                setSelection(results.items[next]?.id);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                if (!event.repeat && active) execute(active);
              }
            }}
          />
          <button
            className={cx('palette-close')}
            type="button"
            aria-label={x('common.close')}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        <ul role="listbox" id={`${id}-results`} aria-label={x('shortcuts.commandPalette')}>
          {results.items.map((item, index) => (
            <li key={item.id} role="presentation">
              {(index === 0 || results.items[index - 1]?.group !== item.group) && (
                <p className={cx('palette-group')} aria-hidden="true">
                  {x(`palette.group.${item.group}`)}
                </p>
              )}
              <button
                type="button"
                role="option"
                tabIndex={-1}
                id={optionId(index)}
                data-palette-id={item.id}
                aria-selected={index === activeIndex}
                aria-disabled={!!item.unavailableReason}
                aria-describedby={item.unavailableReason ? `${optionId(index)}-reason` : undefined}
                className={index === activeIndex ? cx('active') : undefined}
                onMouseMove={() => setSelection(item.id)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => execute(item)}
              >
                <span className={cx('palette-item-label')}>{item.label}</span>
                {!!item.shortcuts.length && <kbd>{item.shortcuts.join(' · ')}</kbd>}
              </button>
              {item.unavailableReason && (
                <p className={cx('palette-reason')} id={`${optionId(index)}-reason`}>
                  {item.unavailableReason}
                </p>
              )}
            </li>
          ))}
        </ul>
        {!results.items.length && (
          <p className={cx('palette-empty')} role="status">
            {x('palette.noResults')}
          </p>
        )}
        {error && (
          <p className={cx('palette-reason')} role="alert">
            {x('palette.actionUnavailable')}
          </p>
        )}
        <p className={cx('palette-help')}>
          {results.total > MAX_PALETTE_RESULTS
            ? x('palette.resultLimit', { count: MAX_PALETTE_RESULTS })
            : x('palette.keyboardHint')}
        </p>
      </section>
    </div>
  );
}
