import { expect, it, vi } from 'vitest';
import { TerminalViewOwner } from '../../packages/plugins/terminals/src/client/interactions/owner.ts';
import {
  DEFAULT_TERMINAL_SEARCH_OPTIONS,
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  describeTerminalSearch,
  toggleTerminalSearchOption,
  validateTerminalSearch,
} from '../../packages/plugins/terminals/src/client/interactions/policy.ts';
it('preserves bounded literal/regex search, rejecting invalid and empty-matching expressions', () => {
  expect(validateTerminalSearch('[', DEFAULT_TERMINAL_SEARCH_OPTIONS)).toBeUndefined();
  expect(validateTerminalSearch('[', { ...DEFAULT_TERMINAL_SEARCH_OPTIONS, regex: true })).toBe(
    'INVALID_REGEX',
  );
  expect(validateTerminalSearch('a*', { ...DEFAULT_TERMINAL_SEARCH_OPTIONS, regex: true })).toBe(
    'REGEX_MATCHES_EMPTY',
  );
  expect(validateTerminalSearch('x'.repeat(513), DEFAULT_TERMINAL_SEARCH_OPTIONS)).toBe(
    'QUERY_TOO_LONG',
  );
  expect(
    validateTerminalSearch('error-[0-9]+', { caseSensitive: true, wholeWord: true, regex: true }),
  ).toBeUndefined();
});
it('keeps immutable UI search flags and bounded indexes independently of terminal bytes', () => {
  expect(toggleTerminalSearchOption(DEFAULT_TERMINAL_SEARCH_OPTIONS, 'regex').regex).toBe(true);
  expect(DEFAULT_TERMINAL_SEARCH_OPTIONS.regex).toBe(false);
  expect(
    describeTerminalSearch('match', undefined, {
      resultIndex: -1,
      resultCount: TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
    }),
  ).toEqual({ feedback: 'Found', count: '—/1000+' });
  expect(describeTerminalSearch('(', 'Invalid regex', { resultIndex: 0, resultCount: 7 })).toEqual({
    feedback: 'Invalid regex',
    count: '',
  });
});
it('retires a captured paste instead of delivering late clipboard data to a replacement view', async () => {
  const owner = new TerminalViewOwner(),
    clipboard = Promise.withResolvers<void>(),
    paste = vi.fn(),
    replacement = vi.fn();
  const off = owner.register('one', {
    selectionAvailable: () => true,
    async run(_action, signal) {
      await clipboard.promise;
      signal.throwIfAborted();
      paste();
    },
  });
  const requested = owner.run('one', 'paste');
  await Promise.resolve();
  expect(() => owner.run('one', 'paste')).toThrow('UNAVAILABLE');
  off();
  owner.register('one', { selectionAvailable: () => false, run: replacement });
  off();
  clipboard.resolve();
  await expect(requested).rejects.toThrow();
  expect(paste).not.toHaveBeenCalled();
  expect(replacement).not.toHaveBeenCalled();
  await owner.run('one', 'search');
  expect(replacement).toHaveBeenCalledOnce();
  await owner.dispose();
});
it('joins an uncancellable clipboard promise on withdrawal and stops admitting work', async () => {
  const owner = new TerminalViewOwner(),
    pending = Promise.withResolvers<void>();
  owner.register('one', { selectionAvailable: () => true, run: () => pending.promise });
  const write = owner.run('one', 'copy');
  await Promise.resolve();
  let done = false;
  const closing = owner.dispose().then(() => {
    done = true;
  });
  expect(done).toBe(false);
  expect(owner.selectionAvailable('one')).toBe(false);
  expect(() => owner.run('one', 'search')).toThrow('CLOSED');
  pending.resolve();
  await write;
  await closing;
  expect(done).toBe(true);
});
