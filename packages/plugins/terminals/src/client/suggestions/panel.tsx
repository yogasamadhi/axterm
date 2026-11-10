import type { CSSProperties } from 'react';
import { LoaderCircle, Sparkles, XCircle } from 'lucide-react';
import type { TerminalCommandSuggestion } from './model.ts';
import type { TranslateNS } from '@axterm/ui';
import styles from './suggestions.module.css';
const cx = (...values: string[]) =>
  values
    .flatMap((value) =>
      value
        .split(/\s+/)
        .filter(Boolean)
        .map((name) => name + ' ' + (styles[name] ?? '')),
    )
    .join(' ');

export interface TerminalCommandSuggestionsState {
  items: TerminalCommandSuggestion[];
  position: CSSProperties;
  reverse: boolean;
  selectedIndex: number;
  aiAvailable: boolean;
  aiLoading: boolean;
  aiError?: string | undefined;
}

export function TerminalCommandSuggestions({
  state,
  x,
  onSelect,
  onDelete,
  onRequestAi,
}: {
  state: TerminalCommandSuggestionsState;
  x: TranslateNS<'terminals'>;
  onSelect(item: TerminalCommandSuggestion): void;
  onDelete(item: TerminalCommandSuggestion): void;
  onRequestAi(): void;
}) {
  const aiAction = state.aiAvailable && (
    <button
      type="button"
      className={cx('terminal-suggestions-ai')}
      disabled={state.aiLoading}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRequestAi}
    >
      {state.aiLoading ? <LoaderCircle size={12} className={cx('spin')} /> : <Sparkles size={12} />}
      {state.aiLoading ? x('terminal.aiSuggestionLoading') : x('terminal.getAiSuggestions')}
    </button>
  );

  return (
    <section
      className={cx(
        state.reverse ? 'terminal-suggestions-wrap reverse' : 'terminal-suggestions-wrap',
      )}
      style={state.position}
      aria-label={x('terminal.suggestions')}
      data-reverse={state.reverse}
    >
      {state.reverse && aiAction}
      <div
        className={cx('terminal-suggestions-list')}
        role="listbox"
        aria-label={x('terminal.suggestionMatches')}
      >
        {state.items.map((item, index) => (
          <div
            className={cx(
              index === state.selectedIndex
                ? 'terminal-suggestion-item selected'
                : 'terminal-suggestion-item',
            )}
            key={item.id}
            role="option"
            aria-selected={index === state.selectedIndex}
          >
            <button
              type="button"
              className={cx('terminal-suggestion-command')}
              title={item.command}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(item)}
            >
              {item.command}
            </button>
            <span className={cx('terminal-suggestion-type')}>{item.source}</span>
            {item.source === 'H' && item.historyItem && (
              <button
                type="button"
                className={cx('terminal-suggestion-delete')}
                title={x('terminal.deleteFromHistory')}
                aria-label={x('terminal.deleteCommandFromHistory', { command: item.command })}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onDelete(item)}
              >
                <XCircle size={12} />
              </button>
            )}
          </div>
        ))}
        {!state.items.length && !state.aiLoading && (
          <p className={cx('terminal-suggestions-empty')}>{x('terminal.noSuggestionMatches')}</p>
        )}
        {state.aiError && (
          <p className={cx('terminal-suggestions-error')} role="status">
            {state.aiError}
          </p>
        )}
      </div>
      {!state.reverse && aiAction}
    </section>
  );
}
