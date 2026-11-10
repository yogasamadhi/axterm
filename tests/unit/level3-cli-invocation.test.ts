import { expect, it } from 'vitest';
import { parseInvocation } from '../../apps/cli/src/invocation.ts';

it('leaves application help and post-delimiter arguments with their owner', () => {
  expect(parseInvocation(['web', '--help'])).toEqual({
    kind: 'profile',
    profile: 'web',
    patchFiles: [],
    dump: false,
    args: ['--help'],
  });
  expect(
    parseInvocation([
      '--profile',
      'headless',
      '--patch',
      'overlay.yml',
      '--dump-config',
      '--',
      '--patch',
      'literal',
      '--profile',
      'literal',
    ]),
  ).toEqual({
    kind: 'profile',
    profile: 'headless',
    patchFiles: ['overlay.yml'],
    dump: true,
    args: ['--patch', 'literal', '--profile', 'literal'],
  });
});
it('reserves plugin management without hiding a Profile explicitly named plugin', () => {
  expect(parseInvocation(['plugin', '--profile', 'web', 'list'])).toEqual({
    kind: 'plugin',
    args: ['--profile', 'web', 'list'],
  });
  expect(parseInvocation(['--profile', 'plugin']).kind).toBe('profile');
});
it('rejects malformed or ambiguous launcher flags before touching a home', () => {
  for (const args of [
    ['--profile'],
    ['--profile', '../web'],
    ['--profile', 'web', '--profile', 'headless'],
    ['web', '--patch'],
  ])
    expect(() => parseInvocation(args)).toThrow();
  expect(parseInvocation(['--help'])).toEqual({ kind: 'help' });
});
