import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TerminalShortcutButton } from '@workspace/contracts';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import {
  buildTerminalShortcutCombo,
  defaultTerminalShortcutButtons,
  moveTerminalShortcutButton,
  shortcutKeyboardDetected,
  shortcutKeyboardOffset,
  TERMINAL_SHORTCUT_CANDIDATES,
  TERMINAL_SHORTCUT_KEY_OPTIONS,
  TERMINAL_SHORTCUT_MODIFIERS,
  TERMINAL_SHORTCUT_TOUCH_GRACE_MS,
  type TerminalShortcutModifier,
} from './terminal-shortcut-bar-model';
import { useI18n } from '../i18n/context';

interface TerminalShortcutBarProps {
  active: boolean;
  enabled: boolean;
  buttons: TerminalShortcutButton[];
  onButtonsChange(buttons: TerminalShortcutButton[]): Promise<void>;
  onSend(data: string): boolean;
}

function insideTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('.terminal-host');
}

export function TerminalShortcutBar({
  active,
  enabled,
  buttons,
  onButtonsChange,
  onSend,
}: TerminalShortcutBarProps) {
  const { t, x } = useI18n();
  const [keyboardSeen, setKeyboardSeen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [keyboardOffset, setKeyboardOffset] = useState(0);
  const [editing, setEditing] = useState(false);
  const [sendState, setSendState] = useState<'idle' | 'accepted' | 'unavailable'>('idle');
  const baseline = useRef({ height: 0, width: 0 });
  const lastTouchAt = useRef(0);
  const showing = enabled && active && visible;

  useEffect(() => {
    if (!enabled) return;
    const viewport = window.visualViewport;
    if (viewport) baseline.current = { height: viewport.height, width: viewport.width };

    const handleFocus = (event: FocusEvent) => {
      if (!insideTerminal(event.target)) return;
      if (viewport && !visible)
        baseline.current = { height: viewport.height, width: viewport.width };
      if (keyboardSeen && active) setVisible(true);
    };
    const handlePointer = (event: PointerEvent) => {
      if (!insideTerminal(event.target) || !['touch', 'pen'].includes(event.pointerType)) return;
      lastTouchAt.current = Date.now();
      if (keyboardSeen) {
        if (active) setVisible(true);
      } else if (!viewport) {
        setKeyboardSeen(true);
        if (active) setVisible(true);
      }
    };
    const handleViewport = () => {
      if (!viewport) return;
      const snapshot = baseline.current;
      const detected = shortcutKeyboardDetected({
        baselineHeight: snapshot.height,
        baselineWidth: snapshot.width,
        visualHeight: viewport.height,
        visualWidth: viewport.width,
        layoutHeight: window.innerHeight,
        recentTouch: Date.now() - lastTouchAt.current < TERMINAL_SHORTCUT_TOUCH_GRACE_MS,
      });
      if (detected) {
        setKeyboardSeen(true);
        if (active) setVisible(true);
      } else if (viewport.offsetTop <= 1 && snapshot.height - viewport.height <= 1) {
        baseline.current = { height: viewport.height, width: viewport.width };
      }
      setKeyboardOffset(
        shortcutKeyboardOffset({
          baselineHeight: snapshot.height,
          baselineWidth: snapshot.width,
          visualHeight: viewport.height,
          visualWidth: viewport.width,
          offsetTop: viewport.offsetTop,
        }),
      );
    };

    document.addEventListener('focusin', handleFocus);
    document.addEventListener('pointerdown', handlePointer);
    viewport?.addEventListener('resize', handleViewport);
    viewport?.addEventListener('scroll', handleViewport);
    window.addEventListener('resize', handleViewport);
    return () => {
      document.removeEventListener('focusin', handleFocus);
      document.removeEventListener('pointerdown', handlePointer);
      viewport?.removeEventListener('resize', handleViewport);
      viewport?.removeEventListener('scroll', handleViewport);
      window.removeEventListener('resize', handleViewport);
    };
  }, [active, enabled, keyboardSeen, visible]);

  useEffect(() => {
    document.body.classList.toggle('shortcut-bar-on', showing);
    if (showing) {
      document.documentElement.style.setProperty('--shortcut-bar-kb-offset', `${keyboardOffset}px`);
    }
    return () => {
      document.body.classList.remove('shortcut-bar-on');
      document.documentElement.style.removeProperty('--shortcut-bar-kb-offset');
    };
  }, [keyboardOffset, showing]);

  if (!showing) return null;
  return createPortal(
    <>
      <div
        className="terminal-shortcut-bar"
        role="toolbar"
        aria-label={x('terminal.shortcutBar')}
        data-last-send={sendState}
        style={keyboardOffset ? { bottom: keyboardOffset } : undefined}
      >
        <div className="terminal-shortcut-bar-fixed">
          <button
            type="button"
            title={t('collapse', 'Collapse')}
            aria-label={x('terminal.collapseShortcutBar')}
            onClick={() => setVisible(false)}
          >
            <ChevronDown size={16} />
          </button>
          <button
            type="button"
            title={t('edit', 'Edit')}
            aria-label={x('terminal.editShortcutBar')}
            onClick={() => setEditing(true)}
          >
            <Pencil size={15} />
          </button>
        </div>
        <div className="terminal-shortcut-bar-scroll">
          {buttons.map((button) => (
            <button
              type="button"
              className="terminal-shortcut-button"
              key={button.id}
              onClick={() => setSendState(onSend(button.data) ? 'accepted' : 'unavailable')}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
      {showing && editing && (
        <TerminalShortcutEditor
          buttons={buttons}
          onChange={onButtonsChange}
          onClose={() => setEditing(false)}
        />
      )}
    </>,
    document.body,
  );
}

function TerminalShortcutEditor({
  buttons,
  onChange,
  onClose,
}: {
  buttons: TerminalShortcutButton[];
  onChange(buttons: TerminalShortcutButton[]): Promise<void>;
  onClose(): void;
}) {
  const { t, x } = useI18n();
  const [keyword, setKeyword] = useState('');
  const [modifierOne, setModifierOne] = useState<TerminalShortcutModifier | ''>('');
  const [modifierTwo, setModifierTwo] = useState<TerminalShortcutModifier | ''>('');
  const [keyId, setKeyId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draggedId, setDraggedId] = useState('');

  const activeIds = useMemo(() => new Set(buttons.map(({ id }) => id)), [buttons]);
  const normalizedKeyword = keyword.trim().toLocaleLowerCase();
  const candidates = TERMINAL_SHORTCUT_CANDIDATES.filter(
    ({ id, label }) =>
      !normalizedKeyword ||
      id.includes(normalizedKeyword) ||
      label.toLocaleLowerCase().includes(normalizedKeyword),
  );

  async function persist(next: TerminalShortcutButton[]) {
    if (busy || next.length > 96) return;
    setBusy(true);
    setError('');
    try {
      await onChange(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : x('terminal.shortcutSaveError'));
    } finally {
      setBusy(false);
    }
  }

  function addCustom() {
    if (!keyId) return;
    const button = buildTerminalShortcutCombo(
      [modifierOne, modifierTwo].filter((value): value is TerminalShortcutModifier => !!value),
      keyId,
    );
    if (!button) return;
    void persist([...buttons, button]);
    setModifierOne('');
    setModifierTwo('');
    setKeyId('');
  }

  function moveBy(id: string, direction: -1 | 1) {
    const index = buttons.findIndex((button) => button.id === id);
    const target = buttons[index + direction];
    if (!target) return;
    void persist(moveTerminalShortcutButton(buttons, id, target.id, direction > 0));
  }

  return createPortal(
    <div className="terminal-shortcut-editor-backdrop" role="presentation">
      <section
        className="terminal-shortcut-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-shortcut-editor-title"
      >
        <header>
          <h2 id="terminal-shortcut-editor-title">{x('terminal.shortcutEditorTitle')}</h2>
          <button type="button" aria-label={x('terminal.closeShortcutEditor')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="terminal-shortcut-editor-body">
          <section>
            <h3>{x('terminal.shortcuts')}</h3>
            <div className="terminal-shortcut-active-list">
              {!buttons.length && <p>{x('terminal.shortcutCount', { count: 0 })}</p>}
              {buttons.map((button, index) => (
                <div
                  key={button.id}
                  className="terminal-shortcut-active-item"
                  draggable={!busy}
                  onDragStart={() => setDraggedId(button.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    void persist(
                      moveTerminalShortcutButton(
                        buttons,
                        draggedId,
                        button.id,
                        event.clientX > bounds.left + bounds.width / 2,
                      ),
                    );
                    setDraggedId('');
                  }}
                >
                  <GripVertical size={12} aria-hidden="true" />
                  <span>{button.label}</span>
                  <button
                    type="button"
                    disabled={busy || index === 0}
                    aria-label={x('terminal.moveShortcutBefore', { label: button.label })}
                    onClick={() => moveBy(button.id, -1)}
                  >
                    <ChevronLeft size={12} />
                  </button>
                  <button
                    type="button"
                    disabled={busy || index === buttons.length - 1}
                    aria-label={x('terminal.moveShortcutAfter', { label: button.label })}
                    onClick={() => moveBy(button.id, 1)}
                  >
                    <ChevronRight size={12} />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={x('terminal.removeShortcut', { label: button.label })}
                    onClick={() => void persist(buttons.filter(({ id }) => id !== button.id))}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section>
            <label className="terminal-shortcut-search">
              <Search size={14} />
              <input
                value={keyword}
                placeholder={t('search', 'Search')}
                aria-label={x('terminal.searchShortcutCandidates')}
                onChange={(event) => setKeyword(event.target.value)}
              />
            </label>
            <div className="terminal-shortcut-candidates">
              {candidates.map((button) => (
                <button
                  type="button"
                  key={button.id}
                  disabled={busy || activeIds.has(button.id)}
                  onClick={() => void persist([...buttons, { ...button }])}
                >
                  {button.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h3>+ {x('terminal.shortcuts')}</h3>
            <div className="terminal-shortcut-combo">
              <select
                aria-label={x('terminal.firstModifier')}
                value={modifierOne}
                onChange={(event) =>
                  setModifierOne(event.target.value as TerminalShortcutModifier | '')
                }
              >
                <option value="">{x('terminal.optionalModifier')}</option>
                {TERMINAL_SHORTCUT_MODIFIERS.map((modifier) => (
                  <option
                    key={modifier.id}
                    value={modifier.id}
                    disabled={modifier.id === modifierTwo}
                  >
                    {modifier.label}
                  </option>
                ))}
              </select>
              <select
                aria-label={x('terminal.secondModifier')}
                value={modifierTwo}
                onChange={(event) =>
                  setModifierTwo(event.target.value as TerminalShortcutModifier | '')
                }
              >
                <option value="">{x('terminal.optionalModifier')}</option>
                {TERMINAL_SHORTCUT_MODIFIERS.map((modifier) => (
                  <option
                    key={modifier.id}
                    value={modifier.id}
                    disabled={modifier.id === modifierOne}
                  >
                    {modifier.label}
                  </option>
                ))}
              </select>
              <select
                aria-label={x('terminal.shortcutKey')}
                value={keyId}
                onChange={(event) => setKeyId(event.target.value)}
              >
                <option value="">{x('terminal.key')}</option>
                {TERMINAL_SHORTCUT_KEY_OPTIONS.map((key) => (
                  <option key={key.id} value={key.id}>
                    {key.label}
                  </option>
                ))}
              </select>
              <button type="button" disabled={busy || !keyId} onClick={addCustom}>
                <Plus size={13} /> {x('terminal.addShortcut')}
              </button>
            </div>
          </section>
          {error && (
            <p className="danger-text" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer>
          <button
            type="button"
            disabled={busy}
            onClick={() => void persist(defaultTerminalShortcutButtons())}
          >
            <RotateCcw size={13} /> {x('terminal.resetShortcuts')}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
