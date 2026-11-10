import { expect, it } from 'vitest';
import { VisibleOutput } from '../../packages/plugins/ai/src/application/visible-output.ts';
const cases = [
  ['hello ordinary visible text', 'hello ordinary visible text'],
  ['Bearer PRIVATE_TOKEN end', 'Bearer [REDACTED] end'],
  ['Authorization : Basic UExBSU46U0VDUkVU= end', 'Authorization : Basic [REDACTED] end'],
  [
    'password="first' + String.fromCharCode(92) + '"second\nPRIVATE" done',
    'password=[REDACTED] done',
  ],
  ["api key = 'PRIVATE\nMULTILINE' done", 'api key=[REDACTED] done'],
  ['password=[REDACTED] done', 'password=[REDACTED] done'],
  ['secret=[REDACTED_KNOWN_SECRET] done', 'secret=[REDACTED] done'],
  ['token: PRIVATE, next', 'token=[REDACTED], next'],
  ['token: "unfinished PRIVATE', 'token=[REDACTED]'],
  ['sk-' + 'proj-' + 'abcdefghijklmnop done', '[REDACTED_API_KEY] done'],
  ['AKIA' + 'ABCDEFGHIJKLMNOP done', '[REDACTED_CLOUD_KEY] done'],
  ['AIza' + 'a'.repeat(35) + ' done', '[REDACTED_CLOUD_KEY] done'],
  [
    'before -----BEGIN RSA PRIVATE KEY-----\nPRIVATE\n-----END RSA PRIVATE KEY----- after',
    'before [REDACTED_PRIVATE_KEY] after',
  ],
  ['-----BEGIN OPENSSH PRIVATE KEY-----\nunfinished PRIVATE', '[REDACTED_PRIVATE_KEY]'],
  [
    'aBearer PUBLIC tokenization secretive API_version sk-a',
    'aBearer PUBLIC tokenization secretive API_version sk-a',
  ],
  ['😀 plain PRIVATE suffix', '😀 plain PRIVATE suffix'],
];
it('redacts generic credential forms before emission across every event split', () => {
  for (const [source, expected] of cases) {
    for (let split = 0; split <= source!.length; split++) {
      const filter = new VisibleOutput();
      const output =
        filter.push(source!.slice(0, split)) + filter.push(source!.slice(split)) + filter.finish();
      expect(output, JSON.stringify({ source, split })).toBe(expected);
    }
    const filter = new VisibleOutput();
    expect([...source!].map((character) => filter.push(character)).join('') + filter.finish()).toBe(
      expected,
    );
  }
});
it('streams ordinary content immediately while retaining only ambiguous credential prefixes', () => {
  const filter = new VisibleOutput();
  expect(filter.push('hello world')).toBe('hello world');
  expect(filter.push(' Bear')).toBe(' ');
  expect(filter.push('er ')).toBe('');
  expect(filter.push('PRIVATE')).toBe('Bearer [REDACTED]');
  expect(filter.push(' text')).toBe(' text');
  expect(filter.finish()).toBe('');
});
it('bounds even unfinished values, pending headers and redaction expansion, and discards canceled data', () => {
  const filter = new VisibleOutput(40);
  expect(filter.push('token="')).toBe('token=[REDACTED]');
  expect(() => filter.push('a'.repeat(40))).toThrow('capacity');
  expect(() => filter.finish()).toThrow('closed');
  const cancel = new VisibleOutput();
  expect(cancel.push('Bearer ')).toBe('');
  cancel.discard();
  expect(() => cancel.finish()).toThrow('closed');
  expect(() => new VisibleOutput().push('-----BEGIN ' + 'A'.repeat(256))).toThrow('capacity');
  expect(() => new VisibleOutput(10).push('token=x')).toThrow('capacity');
});
