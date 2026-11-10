import { expect, it } from 'vitest';
import { VisibleSecrets } from '../../packages/engines/pi/src/visible-secrets.ts';
it('redacts a known credential across every possible event boundary without delaying ordinary text', () => {
  const secret = 'CONTROLLED_API_KEY';
  const text = 'before ' + secret + ' after';
  for (let cut = 0; cut <= text.length; cut++) {
    const filter = new VisibleSecrets([secret]);
    const first = filter.push(text.slice(0, cut));
    const second = filter.push(text.slice(cut));
    expect(first + second + filter.finish()).toBe('before [REDACTED_KNOWN_SECRET] after');
    expect(first).not.toContain(secret);
    expect(second).not.toContain(secret);
  }
  const filter = new VisibleSecrets([secret]);
  expect(filter.push('ordinary visible text')).toBe('ordinary visible text');
  expect(filter.finish()).toBe('');
});
it('redacts overlapping matches and keeps a potential longer secret until its boundary is known', () => {
  const filter = new VisibleSecrets(['abc', 'bcdef', 'defg']);
  const visible =
    filter.push('prefix abc') + filter.push('def') + filter.push('g suffix') + filter.finish();
  expect(visible).toBe('prefix [REDACTED_KNOWN_SECRET] suffix');
});
it('preserves unmatched suffixes and split surrogate pairs at completion', () => {
  const filter = new VisibleSecrets(['secret']);
  expect(filter.push('sec')).toBe('');
  expect(filter.finish()).toBe('sec');
  const unicode = new VisibleSecrets([]);
  expect(unicode.push('\ud83d')).toBe('');
  expect(unicode.push('\ude00')).toBe('😀');
  expect(unicode.finish()).toBe('');
});
it('bounds input and pending matches and can discard canceled private data without publishing it', () => {
  const filter = new VisibleSecrets(['secret'], 8);
  expect(() => filter.push('x'.repeat(9))).toThrow('CAPACITY');
  const canceled = new VisibleSecrets(['secret']);
  expect(canceled.push('se')).toBe('');
  canceled.discard();
  expect(() => canceled.finish()).toThrow('CLOSED');
  expect(() => new VisibleSecrets(Array.from({ length: 34 }, (_, i) => String(i)))).toThrow(
    'CAPACITY',
  );
});
it('matches whole-text redaction under deterministic arbitrary chunking and overlapping patterns', () => {
  const marker = '[REDACTED_KNOWN_SECRET]';
  const normalize = (value: string) => {
    while (value.includes(marker + marker)) value = value.split(marker + marker).join(marker);
    return value;
  };
  let seed = 193;
  const random = (max: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed % max;
  };
  for (let sample = 0; sample < 200; sample++) {
    const text = Array.from({ length: 80 }, () => 'abcd'[random(4)]).join('');
    const secrets = Array.from({ length: 3 }, () =>
      Array.from({ length: 1 + random(6) }, () => 'abcd'[random(4)]).join(''),
    );
    const hidden = Array<boolean>(text.length).fill(false);
    for (const secret of secrets)
      for (let start = text.indexOf(secret); start >= 0; start = text.indexOf(secret, start + 1))
        for (let index = start; index < start + secret.length; index++) hidden[index] = true;
    let expected = '';
    for (let i = 0; i < text.length; i++) {
      if (hidden[i]) {
        if (!hidden[i - 1]) expected += marker;
      } else expected += text[i];
    }
    const filter = new VisibleSecrets(secrets);
    let actual = '';
    for (let index = 0; index < text.length;) {
      const end = index + 1 + random(10);
      actual += filter.push(text.slice(index, end));
      index = end;
    }
    actual += filter.finish();
    expect(normalize(actual)).toBe(expected);
  }
});
