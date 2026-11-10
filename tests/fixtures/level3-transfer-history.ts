import { randomUUID } from 'node:crypto';
import { productDomains } from '@axterm/data-schema';
import { OwnedTransferRepository } from '../../packages/plugins/transfers/src/adapters/transfer-repository.ts';
import { withLevel3StorageSeed } from './level3-product-seed.ts';
/** Historical display input, through the real owner repository and outbox. No live task/grant/network is seeded. */
export async function seedLevel3CompletedTransfer(
  home: string,
  count = 1,
  longPaths = false,
): Promise<void> {
  if (!Number.isSafeInteger(count) || count < 1 || count > 500)
    throw Error('Invalid owned transfer fixture size');
  await withLevel3StorageSeed(home, async (ctx) => {
    const domain = await ctx.storage.domain.open(productDomains.transfers);
    try {
      const repository = new OwnedTransferRepository(domain, 'visual-fixture', randomUUID());
      const now = new Date().toISOString();
      for (let index = 0; index < count; index++)
        repository.reserve(randomUUID(), { fixture: 'completed-history', index }, () => ({
          id: randomUUID(),
          connectionId: randomUUID(),
          direction: 'upload',
          state: 'succeeded',
          bytesTransferred: 64,
          totalBytes: 64,
          source: longPaths
            ? `/Users/operator/Library/Application Support/Axterm/vault-v2/file-grants/${'long-path-'.repeat(40)}${index}.bin`
            : 'fixture.txt',
          destination: longPaths
            ? `/remote/${'long-destination-'.repeat(20)}${index}.bin`
            : '/fixture.txt',
          createdAt: now,
          updatedAt: now,
        }));
    } finally {
      await domain.close();
    }
  });
}
