import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronsDown, Send, Trash2, X } from 'lucide-react';
import { useWorkspace } from '../../stores/workspace';
import { normalizedBatchInputSelection, orderedBatchInputTabs } from './batch-input-model';
import { useI18n } from '../../i18n/context';
import './batch-input.css';

const historyLimit = 50;
const commandLimit = 16_384;

export function BatchInput({ send }: { send(terminalId: string, data: string): boolean }) {
  const { x } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const tabs = useWorkspace((state) => state.tabs);
  const activeTerminalId = useWorkspace((state) => state.activeTerminalId);
  const [open, setOpen] = useState(false);
  const [command, setCommand] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<string[]>([]);
  const [feedback, setFeedback] = useState('');
  const eligible = useMemo(
    () => orderedBatchInputTabs(tabs, activeTerminalId),
    [activeTerminalId, tabs],
  );
  const effectiveSelected = normalizedBatchInputSelection(selected, tabs, activeTerminalId);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return normalizedBatchInputSelection(next, tabs, activeTerminalId);
    });
  }

  function submit() {
    if (!command.trim()) return;
    const targets = normalizedBatchInputSelection(selected, tabs, activeTerminalId);
    let sent = 0;
    for (const id of targets) if (send(id, `${command}\r`)) sent += 1;
    setHistory((current) =>
      [command, ...current.filter((item) => item !== command)].slice(0, historyLimit),
    );
    setCommand('');
    setOpen(false);
    setFeedback(
      sent === targets.size
        ? x('batchInput.sent', { count: sent })
        : x('batchInput.partiallySent', { count: sent, total: targets.size }),
    );
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  return (
    <div className="batch-input-root" ref={root}>
      <button
        className={open ? 'batch-input-trigger active' : 'batch-input-trigger'}
        type="button"
        aria-expanded={open}
        aria-label={x('batchInput.title')}
        disabled={!eligible.length}
        onClick={() => {
          setFeedback('');
          setSelected((current) => normalizedBatchInputSelection(current, tabs, activeTerminalId));
          setOpen((value) => !value);
        }}
      >
        <ChevronsDown size={13} />
        <span>{x('batchInput.title')}</span>
      </button>
      {open && (
        <section className="batch-input-panel" aria-label={x('batchInput.panel')}>
          <header>
            <strong>{x('batchInput.title')}</strong>
            <span>{x('batchInput.description')}</span>
            <button type="button" aria-label={x('batchInput.close')} onClick={() => setOpen(false)}>
              <X size={13} />
            </button>
          </header>
          <textarea
            autoFocus
            aria-label={x('batchInput.command')}
            maxLength={commandLimit}
            rows={3}
            value={command}
            placeholder={x('batchInput.placeholder')}
            onChange={(event) => setCommand(event.target.value)}
            onKeyDown={keyDown}
          />
          <div className="batch-input-target-toolbar">
            <span>
              {x('batchInput.targets', {
                selected: effectiveSelected.size,
                total: eligible.length,
              })}
            </span>
            <button
              type="button"
              onClick={() => setSelected(new Set(eligible.map(({ id }) => id)))}
            >
              {x('batchInput.selectAll')}
            </button>
            <button
              type="button"
              onClick={() =>
                setSelected(normalizedBatchInputSelection(new Set(), tabs, activeTerminalId))
              }
            >
              {x('batchInput.currentOnly')}
            </button>
          </div>
          <div className="batch-input-targets" role="group" aria-label={x('batchInput.targetList')}>
            {eligible.map((tab) => (
              <label key={tab.id}>
                <input
                  type="checkbox"
                  checked={effectiveSelected.has(tab.id)}
                  onChange={() => toggle(tab.id)}
                />
                <span className="batch-input-check">
                  {effectiveSelected.has(tab.id) && <Check size={10} />}
                </span>
                <strong>{tab.title}</strong>
                <small>{tab.kind.toUpperCase()}</small>
                {tab.id === activeTerminalId && <em>{x('batchInput.current')}</em>}
              </label>
            ))}
          </div>
          {!!history.length && (
            <div className="batch-input-history">
              <header>
                <span>{x('batchInput.history')}</span>
                <button
                  type="button"
                  aria-label={x('batchInput.clearHistory')}
                  onClick={() => setHistory([])}
                >
                  <Trash2 size={12} />
                </button>
              </header>
              {history.slice(0, 6).map((item) => (
                <button type="button" key={item} title={item} onClick={() => setCommand(item)}>
                  {item}
                </button>
              ))}
            </div>
          )}
          <footer>
            <small>
              {command.length}/{commandLimit}
            </small>
            <button className="primary" type="button" disabled={!command.trim()} onClick={submit}>
              <Send size={12} /> {x('batchInput.sendTo', { count: effectiveSelected.size })}
            </button>
          </footer>
        </section>
      )}
      {feedback && (
        <span className="batch-input-feedback" aria-live="polite">
          {feedback}
        </span>
      )}
    </div>
  );
}
