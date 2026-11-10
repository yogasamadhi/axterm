import type { Context } from '@deepseek-ai/cordis';
import { productDomains, copiedReferences, type CopiedReferences } from '@axterm/data-schema';
import type {} from '@axterm/infra-storage-domain';
/** Offline copy conversion belongs to this domain; no network, command or old task is resumed. */
export async function migrateCopiedData(ctx: Context): Promise<CopiedReferences> {
  const domain = await ctx.storage.domain.open(productDomains.transfers);
  try {
    return domain.transaction(() => {
      domain.run(
        "UPDATE transfer_history SET state='failed',error_code='RUNTIME_INTERRUPTED',updated_at=?,version=version+1 WHERE state IN ('queued','preparing','running','paused','awaiting-decision')",
        new Date().toISOString(),
      );
      const references = copiedReferences(domain, []);
      domain.appendEvent('transfers/home-copied', { generationInvalidated: true });
      return references;
    });
  } finally {
    await domain.close();
  }
}
