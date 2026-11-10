import { CaseSensitive, ChevronDown, ChevronUp, Regex, Search, WholeWord, X } from 'lucide-react';
import type { KeyboardEvent, RefObject } from 'react';
import {
  describeTerminalSearch,
  TERMINAL_SEARCH_QUERY_LIMIT,
  type TerminalSearchOptions,
  type TerminalSearchResults,
} from './policy.ts';
import type { TranslateNS } from '@axterm/ui';
import styles from './interactions.module.css';
const cx = (value: string) =>
  value
    .split(/\s+/u)
    .map((name) => name + ' ' + (styles[name] ?? ''))
    .join(' ');

interface TerminalSearchBarProps {
  x: TranslateNS<'terminals'>;
  inputRef: RefObject<HTMLInputElement>;
  query: string;
  options: TerminalSearchOptions;
  results: TerminalSearchResults;
  error?: string | undefined;
  onQueryChange(query: string): void;
  onOptionChange(option: keyof TerminalSearchOptions): void;
  onPrevious(): void;
  onNext(): void;
  onClose(): void;
}

export function TerminalSearchBar({
  x,
  inputRef,
  query,
  options,
  results,
  error,
  onQueryChange,
  onOptionChange,
  onPrevious,
  onNext,
  onClose,
}: TerminalSearchBarProps) {
  const status = describeTerminalSearch(query, error, results, {
    noMatch: x('terminal.searchNoMatch'),
    found: x('terminal.searchFound'),
  });
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) onPrevious();
      else onNext();
    }
  };

  return (
    <div className={cx('terminal-search')} role="search" aria-label={x('terminal.search')}>
      <Search className={cx('terminal-search-icon')} size={13} aria-hidden="true" />
      <input
        ref={inputRef}
        value={query}
        maxLength={TERMINAL_SEARCH_QUERY_LIMIT}
        aria-label={x('terminal.searchOutput')}
        aria-invalid={Boolean(error)}
        placeholder={x('terminal.searchOutput')}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span
        className={cx(`terminal-search-result${error ? ' error' : ''}`)}
        role="status"
        aria-live="polite"
      >
        {status.feedback}
      </span>
      {status.count && (
        <span
          className={cx('terminal-search-count')}
          aria-label={x('terminal.searchResults', { count: status.count })}
        >
          {status.count}
        </span>
      )}
      <button
        className={cx(options.caseSensitive ? 'active' : '')}
        type="button"
        title={x('terminal.searchMatchCase')}
        aria-label={x('terminal.searchMatchCase')}
        aria-pressed={options.caseSensitive}
        onClick={() => onOptionChange('caseSensitive')}
      >
        <CaseSensitive size={14} />
      </button>
      <button
        className={cx(options.wholeWord ? 'active' : '')}
        type="button"
        title={x('terminal.searchWholeWord')}
        aria-label={x('terminal.searchWholeWord')}
        aria-pressed={options.wholeWord}
        onClick={() => onOptionChange('wholeWord')}
      >
        <WholeWord size={14} />
      </button>
      <button
        className={cx(options.regex ? 'active' : '')}
        type="button"
        title={x('terminal.searchRegex')}
        aria-label={x('terminal.searchRegex')}
        aria-pressed={options.regex}
        onClick={() => onOptionChange('regex')}
      >
        <Regex size={14} />
      </button>
      <button
        type="button"
        title={x('terminal.searchPrevious')}
        aria-label={x('terminal.searchPrevious')}
        onClick={onPrevious}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        title={x('terminal.searchNext')}
        aria-label={x('terminal.searchNext')}
        onClick={onNext}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        title={x('terminal.closeSearch')}
        aria-label={x('terminal.closeSearch')}
        onClick={onClose}
      >
        <X size={13} />
      </button>
    </div>
  );
}
