import { expect, it, describe } from 'vitest';
import {
  DEFAULT_TERMINAL_SEARCH_OPTIONS,
  describeTerminalSearch,
  validateTerminalSearch,
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  toggleTerminalSearchOption,
} from '../../packages/plugins/terminals/src/client/interactions/policy.ts';
describe('owned terminal search original inputs', () => {
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

  it('retains immutable option toggles with all three flags', () => {
    const changed = toggleTerminalSearchOption(DEFAULT_TERMINAL_SEARCH_OPTIONS, 'regex');
    expect(changed).toEqual({ caseSensitive: false, wholeWord: false, regex: true });
    expect(DEFAULT_TERMINAL_SEARCH_OPTIONS.regex).toBe(false);
  });
});
