import { describe, expect, it } from 'vitest';
import { createConnectionSchema } from '@axterm/plugin-api/connections';
import { parseQuickConnect } from '@axterm/plugin-api/session-intents';
describe('Phase 12 quick connect parsing', () => {
  it('requires exactly one persistent host or ephemeral target at the REST boundary', () => {
    const hostId = '11111111-1111-4111-8111-111111111111';
    expect(createConnectionSchema.safeParse({ hostId }).success).toBe(true);
    expect(
      createConnectionSchema.safeParse({
        target: { hostname: 'host.example.com', username: 'operator' },
      }).success,
    ).toBe(true);
    expect(createConnectionSchema.safeParse({}).success).toBe(false);
    expect(
      createConnectionSchema.safeParse({
        hostId,
        target: { hostname: 'host.example.com', username: 'operator' },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['host.example.com', { hostname: 'host.example.com', port: 22 }],
    [
      'operator@host.example.com:2202',
      { hostname: 'host.example.com', port: 2202, username: 'operator' },
    ],
    [
      ' ssh://release%20operator@host.example.com:2222 ',
      { hostname: 'host.example.com', port: 2222, username: 'release operator' },
    ],
    [
      'ssh://operator:p%40ss@host.example.com:2222',
      {
        hostname: 'host.example.com',
        port: 2222,
        username: 'operator',
        temporarySecret: 'p@ss',
      },
    ],
  ])('parses %s', (input, expected) => {
    expect(parseQuickConnect(input)).toMatchObject({ protocol: 'ssh', ...expected });
  });

  it('recognizes non-SSH protocols for the application capability gate', () => {
    expect(parseQuickConnect('https://host.example.com/path')).toMatchObject({
      protocol: 'https',
      url: 'https://host.example.com/path',
    });
  });

  it.each([
    '',
    '   ',
    'ssh://',
    'ssh://host.example.com:0',
    'ssh://host.example.com:65536',
    'operator@host.example.com:not-a-port',
  ])('rejects invalid target %j', (input) => {
    expect(parseQuickConnect(input)).toBeNull();
  });
});
