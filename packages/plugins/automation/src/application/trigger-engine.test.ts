import { describe, expect, it } from 'vitest';
import type { TriggerRule } from '@axterm/plugin-api/automation';
import { TriggerEngine, expandTriggerControlCharacters } from './trigger-engine.ts';
describe('TriggerEngine', () => {
  it('matches text across chunks while stripping split ANSI and normalizing CRLF', () => {
    const fired: string[] = [];
    const engine = new TriggerEngine(({ matched }) => fired.push(matched));
    engine.setRules([rule('Prompt', 'Password:\n')]);

    engine.push('\u001b[31mPass');
    engine.push('\u001b[0mword:\r');
    expect(fired).toEqual([]);
    engine.push('\n');

    expect(fired).toEqual(['Password:\n']);
  });

  it('honors repeat, cooldown, once and disabled rules without reusing old matches', () => {
    let now = 1_000;
    const fired: string[] = [];
    const engine = new TriggerEngine(
      ({ rule: current }) => fired.push(current.name),
      () => now,
    );
    engine.setRules([
      rule('repeat', 'R', { mode: 'repeat' }),
      rule('cooldown', 'C', { mode: 'cooldown', cooldownMs: 500 }),
      rule('once', 'O', { mode: 'once' }),
      rule('disabled', 'D', { enabled: false }),
    ]);
    engine.push('RCOD');
    now += 100;
    engine.push('RCO');
    now += 500;
    engine.push('RCO');

    expect(fired.filter((name) => name === 'repeat')).toHaveLength(3);
    expect(fired.filter((name) => name === 'cooldown')).toHaveLength(2);
    expect(fired.filter((name) => name === 'once')).toHaveLength(1);
    expect(fired).not.toContain('disabled');
  });

  it('expands Legacy Prototype-compatible control character notation', () => {
    expect(expandTriggerControlCharacters(String.raw`yes\r\x03^D\\`)).toBe(`yes\r\u0003\u0004\\`);
  });
});

function rule(name: string, value: string, overrides: Partial<TriggerRule> = {}): TriggerRule {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name,
    enabled: true,
    match: { type: 'text', value, caseSensitive: true },
    action: { type: 'notify', value: '' },
    sendEnter: false,
    mode: 'repeat',
    cooldownMs: 0,
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
}
