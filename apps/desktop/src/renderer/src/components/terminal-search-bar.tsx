import { CaseSensitive, ChevronDown, ChevronUp, Regex, Search, WholeWord, X } from 'lucide-react';
import type { KeyboardEvent, RefObject } from 'react';
import {
  describeTerminalSearch,
  TERMINAL_SEARCH_QUERY_LIMIT,
  type TerminalSearchOptions,
  type TerminalSearchResults,
} from './terminal-interaction';
import { useI18n } from '../i18n/context';

interface TerminalSearchBarProps {
  inputRef: RefObject<HTMLInputElement | null>;
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
  const { t, x } = useI18n();
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
    <div className="terminal-search" role="search" aria-label={x('terminal.search')}>
      <Search className="terminal-search-icon" size={13} aria-hidden="true" />
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
        className={`terminal-search-result${error ? ' error' : ''}`}
        role="status"
        aria-live="polite"
      >
        {status.feedback}
      </span>
      {status.count && (
        <span
          className="terminal-search-count"
          aria-label={x('terminal.searchResults', { count: status.count })}
        >
          {status.count}
        </span>
      )}
      <button
        className={options.caseSensitive ? 'active' : ''}
        type="button"
        title={t('matchCase', 'Case sensitive')}
        aria-label={t('matchCase', 'Case sensitive')}
        aria-pressed={options.caseSensitive}
        onClick={() => onOptionChange('caseSensitive')}
      >
        <CaseSensitive size={14} />
      </button>
      <button
        className={options.wholeWord ? 'active' : ''}
        type="button"
        title={t('matchWholeWord', 'Match whole word')}
        aria-label={t('matchWholeWord', 'Match whole word')}
        aria-pressed={options.wholeWord}
        onClick={() => onOptionChange('wholeWord')}
      >
        <WholeWord size={14} />
      </button>
      <button
        className={options.regex ? 'active' : ''}
        type="button"
        title={t('useRegExp', 'Use regular expression')}
        aria-label={t('useRegExp', 'Use regular expression')}
        aria-pressed={options.regex}
        onClick={() => onOptionChange('regex')}
      >
        <Regex size={14} />
      </button>
      <button
        type="button"
        title={t('prevMatch', 'Previous match')}
        aria-label={t('prevMatch', 'Previous match')}
        onClick={onPrevious}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        title={t('nextMatch', 'Next match')}
        aria-label={t('nextMatch', 'Next match')}
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
