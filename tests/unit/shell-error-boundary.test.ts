import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LocalShellError,
  shellErrorMessage,
} from '../../apps/desktop/src/renderer/src/app/shell-error';

describe('Shell error boundary', () => {
  it('keeps arbitrary Runtime and Host messages out of the visible toast', () => {
    const canary = 'private-runtime-problem-title';
    expect(shellErrorMessage(new Error(canary), 'Unable to save the workspace.')).toBe(
      'Unable to save the workspace.',
    );
    expect(shellErrorMessage({ message: canary }, 'Unable to save the workspace.')).toBe(
      'Unable to save the workspace.',
    );
    expect(
      shellErrorMessage(new LocalShellError('Choose a host first.'), 'Connection failed.'),
    ).toBe('Choose a host first.');
  });

  it('does not add raw caught Error messages back into the Shell', () => {
    const source = readFileSync(resolve('apps/desktop/src/renderer/src/app/app.tsx'), 'utf8');
    expect(source).not.toMatch(/(?:cause|error)\.message/u);
    expect(source).not.toMatch(/(?:cause|error) instanceof Error/u);
  });
});
