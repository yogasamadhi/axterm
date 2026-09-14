export const TERMINAL_SEARCH_QUERY_LIMIT = 512;
export const TERMINAL_SEARCH_HIGHLIGHT_LIMIT = 1_000;

export interface TerminalSearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface TerminalSearchResults {
  resultIndex: number;
  resultCount: number;
}

export type TerminalSearchErrorCode = 'QUERY_TOO_LONG' | 'REGEX_MATCHES_EMPTY' | 'INVALID_REGEX';

export interface TerminalContextMenuPosition {
  x: number;
  y: number;
}

export const DEFAULT_TERMINAL_SEARCH_OPTIONS: TerminalSearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

export function validateTerminalSearch(
  query: string,
  options: TerminalSearchOptions,
): TerminalSearchErrorCode | undefined {
  if (!query) return undefined;
  if (query.length > TERMINAL_SEARCH_QUERY_LIMIT) return 'QUERY_TOO_LONG';
  if (!options.regex) return undefined;
  try {
    const expression = new RegExp(query, options.caseSensitive ? 'g' : 'gi');
    if (expression.test('')) return 'REGEX_MATCHES_EMPTY';
  } catch {
    return 'INVALID_REGEX';
  }
  return undefined;
}

export function toggleTerminalSearchOption(
  options: TerminalSearchOptions,
  option: keyof TerminalSearchOptions,
): TerminalSearchOptions {
  return { ...options, [option]: !options[option] };
}

export function describeTerminalSearch(
  query: string,
  error: string | undefined,
  results: TerminalSearchResults,
  labels: { noMatch: string; found: string } = { noMatch: 'No matches', found: 'Found' },
): { feedback: string; count: string } {
  if (!query) return { feedback: '', count: '' };
  if (error) return { feedback: error, count: '' };
  if (results.resultCount < 1) return { feedback: labels.noMatch, count: '0/0' };
  const current = results.resultIndex < 0 ? '—' : String(results.resultIndex + 1);
  const total =
    results.resultCount >= TERMINAL_SEARCH_HIGHLIGHT_LIMIT
      ? `${TERMINAL_SEARCH_HIGHLIGHT_LIMIT}+`
      : String(results.resultCount);
  return { feedback: labels.found, count: `${current}/${total}` };
}

export function clampTerminalContextMenu(
  position: TerminalContextMenuPosition,
  viewport: { width: number; height: number },
  menu: { width: number; height: number } = { width: 205, height: 296 },
): TerminalContextMenuPosition {
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(position.x, viewport.width - menu.width - margin)),
    y: Math.max(margin, Math.min(position.y, viewport.height - menu.height - margin)),
  };
}

export function terminalClipboardFailure(action: 'copy' | 'paste'): 'COPY_FAILED' | 'PASTE_FAILED' {
  return action === 'copy' ? 'COPY_FAILED' : 'PASTE_FAILED';
}

export function terminalContextMenuAvailability(hasSelection: boolean): {
  copy: boolean;
  paste: boolean;
  pasteSelected: boolean;
  selectAll: boolean;
  explainWithAi: boolean;
  clear: boolean;
  search: boolean;
} {
  return {
    copy: hasSelection,
    paste: true,
    pasteSelected: hasSelection,
    selectAll: true,
    explainWithAi: hasSelection,
    clear: true,
    search: true,
  };
}
