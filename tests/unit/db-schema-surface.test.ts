import { expect, it } from 'vitest';
import { productBootstrap } from '@axterm/data-schema';
const schema = Object.fromEntries(productBootstrap.tables.map(({ table }) => [table, true]));

it('does not expose the retired import ledger through the current database schema', () => {
  expect(schema).not.toHaveProperty('legacy-prototypeImportEntries');
  expect(
    productBootstrap.tables.some(({ table }) =>
      /prototype.*import|import.*prototype/iu.test(table),
    ),
  ).toBe(false);
});
