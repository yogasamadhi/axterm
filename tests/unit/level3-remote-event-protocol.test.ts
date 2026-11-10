import { expect, it } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import {
  isRemoteEventScope,
  projectRemoteEventRejection,
  restoreRemoteEventRejection,
} from '../../packages/api/plugin-api/src/stream-protocol.ts';

it('rejects malformed, ambiguous and prototype-oriented Scope identities', () => {
  expect(isRemoteEventScope({ context: 'workspace', id: 'one', subject: 'workspace' })).toBe(true);
  for (const scope of [
    null,
    [],
    { context: '.', id: 'one', subject: 'workspace' },
    { context: 'workspace', id: '', subject: 'workspace' },
    ...['__proto__', 'constructor', 'prototype', 'signal'].map((subject) => ({
      context: 'workspace',
      id: 'one',
      subject,
    })),
    { context: 'workspace', id: 'one', subject: 'workspace', other: true },
    { context: 'workspace', id: 'x'.repeat(513), subject: 'workspace' },
  ])
    expect(isRemoteEventScope(scope)).toBe(false);
});

it('preserves explicit Remote failures while redacting arbitrary listener rejections and throwing getters', () => {
  const typed = new RemoteError('gateway/internal', 'A stable application failure', {});
  expect(restoreRemoteEventRejection(projectRemoteEventRejection(typed))).toMatchObject({
    code: 'gateway/internal',
    message: typed.message,
  });
  for (const reason of [
    new Error('fixture-private-listener-value'),
    'fixture-private-listener-value',
    {
      get isAXTERMRemoteError() {
        throw new Error('fixture-private-listener-value');
      },
    },
  ]) {
    const wire = projectRemoteEventRejection(reason);
    expect(wire).toEqual({ name: 'Error', message: 'Remote event listener failed' });
    expect(JSON.stringify(wire)).not.toContain('fixture-private-listener-value');
  }
});
