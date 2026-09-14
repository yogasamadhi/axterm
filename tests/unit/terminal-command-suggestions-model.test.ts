import { describe, expect, it } from 'vitest';
import type { CommandHistoryItem } from '../../packages/contracts/src/index';
import {
  parseAiCommandSuggestions,
  rankTerminalCommandSuggestions,
  setBoundedSuggestionCache,
  terminalSuggestionInsertion,
  TERMINAL_SUGGESTION_CACHE_LIMIT,
  TerminalPromptInputModel,
} from '../../apps/desktop/src/renderer/src/components/terminal-command-suggestions-model';

const history = (id: string, command: string, count: number): CommandHistoryItem => ({
  id,
  command,
  count,
  lastUsedAt: '2026-09-12T00:00:00.000Z',
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
  version: 1,
});

describe('terminal command suggestions', () => {
  it('tracks edits only inside a trusted shell prompt and invalidates unknown controls', () => {
    const input = new TerminalPromptInputModel();
    expect(input.handleInput('secret')).toBeUndefined();
    expect(input.openPrompt()).toEqual({ value: '', cursor: 0 });
    expect(input.handleInput('git st')).toEqual({ value: 'git st', cursor: 6 });
    expect(input.handleInput('\u001b[D')).toEqual({ value: 'git st', cursor: 5 });
    expect(input.handleInput('\u007f')).toEqual({ value: 'git t', cursor: 4 });
    expect(input.handleInput('a')).toEqual({ value: 'git at', cursor: 5 });
    expect(input.handleInput('\u0005')).toEqual({ value: 'git at', cursor: 6 });
    expect(input.handleInput('\t')).toBeUndefined();
    expect(input.snapshot()).toBeUndefined();
    input.openPrompt();
    expect(input.handleInput('\u001b[200~echo 你好\u001b[201~')).toEqual({
      value: 'echo 你好',
      cursor: 7,
    });
    input.closePrompt();
    expect(input.handleInput('password')).toBeUndefined();
  });

  it('matches exact prefixes in upstream source order and de-duplicates commands', () => {
    const result = rankTerminalCommandSuggestions('git ', {
      ai: ['git status', 'git diff'],
      history: [history('one', 'git status', 9), history('two', 'git log', 2)],
      batch: ['git branch'],
      quick: ['git push', 'npm test'],
    });
    expect(result.map(({ command, source }) => [command, source])).toEqual([
      ['git status', 'AI'],
      ['git diff', 'AI'],
      ['git log', 'H'],
      ['git branch', 'B'],
      ['git push', 'Q'],
    ]);
    expect(
      rankTerminalCommandSuggestions('git ', { history: [history('one', 'git log', 1)] }, true),
    ).toEqual([expect.objectContaining({ command: 'git log', source: 'H' })]);
    expect(rankTerminalCommandSuggestions(' git', { quick: [' git status'] })).toEqual([]);
  });

  it('moves to the tracked line end and inserts only the unmatched suffix', () => {
    expect(terminalSuggestionInsertion({ value: 'git st', cursor: 6 }, 'git status')).toBe('atus');
    expect(terminalSuggestionInsertion({ value: 'git st', cursor: 3 }, 'git status')).toBe(
      '\u001b[C\u001b[C\u001b[Catus',
    );
    expect(
      terminalSuggestionInsertion({ value: 'git xx', cursor: 6 }, 'git status'),
    ).toBeUndefined();
  });

  it('parses bounded JSON or line-based AI results and keeps only exact-prefix commands', () => {
    expect(
      parseAiCommandSuggestions(
        '```json\n["git status", "rm -rf /", "git status", "git diff"]\n```',
        'git ',
      ),
    ).toEqual(['git status', 'git diff']);
    expect(parseAiCommandSuggestions('- npm test\n2. npm run lint\nother', 'npm ')).toEqual([
      'npm test',
      'npm run lint',
    ]);
  });

  it('evicts the oldest suggestion cache entry at the fixed capacity', () => {
    const cache = new Map<string, number>();
    for (let index = 0; index <= TERMINAL_SUGGESTION_CACHE_LIMIT; index += 1)
      setBoundedSuggestionCache(cache, String(index), index);
    expect(cache).toHaveLength(TERMINAL_SUGGESTION_CACHE_LIMIT);
    expect(cache.has('0')).toBe(false);
    expect(cache.get(String(TERMINAL_SUGGESTION_CACHE_LIMIT))).toBe(
      TERMINAL_SUGGESTION_CACHE_LIMIT,
    );
  });
});
