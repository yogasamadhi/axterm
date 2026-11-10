import { expect, it } from 'vitest';
import { directoryFromOsc633 } from '../../packages/plugins/terminals/src/client/active-directory.ts';
it('decodes bounded escaped SSH directory hints and refuses unsafe or nonabsolute values', () => {
  expect(directoryFromOsc633(String.raw`/srv/with\x3bseparator`)).toBe('/srv/with;separator');
  expect(directoryFromOsc633(String.raw`/srv/back\\slash`)).toBe(String.raw`/srv/back\slash`);
  for (const value of [
    'relative',
    '/' + 'x'.repeat(4096),
    String.raw`/a\x00b`,
    String.raw`/a\x1bb`,
    String.raw`/a\oops`,
  ])
    expect(directoryFromOsc633(value)).toBeUndefined();
});
