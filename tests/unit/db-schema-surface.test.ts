import { expect, it } from 'vitest';
import { schema } from '../../packages/db-schema/src';

it('does not expose the retired import ledger through the current database schema', () => {
  expect(schema).not.toHaveProperty('legacy-prototypeImportEntries');
});
