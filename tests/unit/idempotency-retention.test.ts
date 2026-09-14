import { describe, expect, it } from 'vitest';
import { ProductDatabase } from '../../packages/runtime/src/adapters/sqlite/database';
import {
  DEFAULT_IDEMPOTENCY_RECEIPT_LIMIT,
  ProductRepository,
} from '../../packages/runtime/src/adapters/sqlite/product-repository';

describe('bounded idempotency receipts', () => {
  it('applies the default retention ceiling when a workflow does not supply a smaller limit', async () => {
    const database = await ProductDatabase.open();
    try {
      const repository = new ProductRepository(database);
      for (let index = 0; index < DEFAULT_IDEMPOTENCY_RECEIPT_LIMIT + 5; index += 1) {
        const key = `receipt-${index.toString().padStart(5, '0')}`;
        repository.recordIdempotency(key, 'long-running-workflow', { index }, { index });
      }

      expect(
        database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM idempotency_records WHERE operation='long-running-workflow'",
        )?.count,
      ).toBe(DEFAULT_IDEMPOTENCY_RECEIPT_LIMIT);
      expect(
        repository.resolveIdempotency(
          `receipt-${(DEFAULT_IDEMPOTENCY_RECEIPT_LIMIT + 4).toString().padStart(5, '0')}`,
          'long-running-workflow',
          { index: DEFAULT_IDEMPOTENCY_RECEIPT_LIMIT + 4 },
        ),
      ).toEqual({ index: DEFAULT_IDEMPOTENCY_RECEIPT_LIMIT + 4 });
      expect(() =>
        repository.recordIdempotency('invalid-limit', 'long-running-workflow', {}, {}, 0),
      ).toThrow('Idempotency retention limit must be a positive integer');
      expect(
        database.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM idempotency_records WHERE key='invalid-limit'",
        )?.count,
      ).toBe(0);
    } finally {
      database.close();
    }
  });
});
