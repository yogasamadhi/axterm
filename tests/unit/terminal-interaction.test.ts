import { describe, expect, it } from 'vitest';
import {
  clampTerminalContextMenu,
  DEFAULT_TERMINAL_SEARCH_OPTIONS,
  describeTerminalSearch,
  terminalClipboardFailure,
  terminalContextMenuAvailability,
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  toggleTerminalSearchOption,
  validateTerminalSearch,
} from '../../apps/desktop/src/renderer/src/components/terminal-interaction';

describe('terminal search interaction model', () => {
  it('accepts literal and valid regex queries while rejecting invalid and empty-matching regex', () => {
    expect(validateTerminalSearch('[', DEFAULT_TERMINAL_SEARCH_OPTIONS)).toBeUndefined();
    expect(validateTerminalSearch('[', { ...DEFAULT_TERMINAL_SEARCH_OPTIONS, regex: true })).toBe(
      'INVALID_REGEX',
    );
    expect(validateTerminalSearch('a*', { ...DEFAULT_TERMINAL_SEARCH_OPTIONS, regex: true })).toBe(
      'REGEX_MATCHES_EMPTY',
    );
    expect(
      validateTerminalSearch('error-[0-9]+', {
        caseSensitive: true,
        wholeWord: true,
        regex: true,
      }),
    ).toBeUndefined();
  });

  it('describes empty, no-match, indexed and bounded result states', () => {
    expect(describeTerminalSearch('', undefined, { resultIndex: -1, resultCount: 0 })).toEqual({
      feedback: '',
      count: '',
    });
    expect(
      describeTerminalSearch('missing', undefined, { resultIndex: -1, resultCount: 0 }),
    ).toEqual({ feedback: 'No matches', count: '0/0' });
    expect(describeTerminalSearch('match', undefined, { resultIndex: 2, resultCount: 7 })).toEqual({
      feedback: 'Found',
      count: '3/7',
    });
    expect(
      describeTerminalSearch('match', undefined, {
        resultIndex: -1,
        resultCount: TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
      }),
    ).toEqual({ feedback: 'Found', count: `—/${TERMINAL_SEARCH_HIGHLIGHT_LIMIT}+` });
    expect(
      describeTerminalSearch('(', '正则表达式无效。', { resultIndex: 0, resultCount: 4 }),
    ).toEqual({ feedback: '正则表达式无效。', count: '' });
  });

  it('keeps the terminal menu inside the viewport, including very small viewports', () => {
    expect(clampTerminalContextMenu({ x: 980, y: 740 }, { width: 1_000, height: 760 })).toEqual({
      x: 787,
      y: 456,
    });
    expect(clampTerminalContextMenu({ x: -20, y: -5 }, { width: 120, height: 100 })).toEqual({
      x: 8,
      y: 8,
    });
  });

  it('uses explicit clipboard permission failure messages', () => {
    expect(terminalClipboardFailure('copy')).toBe('COPY_FAILED');
    expect(terminalClipboardFailure('paste')).toBe('PASTE_FAILED');
  });

  it('toggles search flags immutably and enables copy only for a live selection', () => {
    const changed = toggleTerminalSearchOption(DEFAULT_TERMINAL_SEARCH_OPTIONS, 'regex');
    expect(changed).toEqual({ caseSensitive: false, wholeWord: false, regex: true });
    expect(DEFAULT_TERMINAL_SEARCH_OPTIONS.regex).toBe(false);
    expect(terminalContextMenuAvailability(false)).toEqual({
      copy: false,
      paste: true,
      pasteSelected: false,
      selectAll: true,
      explainWithAi: false,
      clear: true,
      search: true,
    });
    expect(terminalContextMenuAvailability(true).copy).toBe(true);
    expect(terminalContextMenuAvailability(true).pasteSelected).toBe(true);
    expect(terminalContextMenuAvailability(true).explainWithAi).toBe(true);
  });
});
