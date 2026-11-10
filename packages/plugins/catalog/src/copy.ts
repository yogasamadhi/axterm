import type { Context } from '@deepseek-ai/cordis';
import { productDomains, copiedReferences, type CopiedReferences } from '@axterm/data-schema';
import type {} from '@axterm/infra-storage-domain';
/** Offline copy conversion belongs to this domain; no network, command or old task is resumed. */
export async function migrateCopiedData(ctx: Context): Promise<CopiedReferences> {
  const domain = await ctx.storage.domain.open(productDomains.catalog);
  try {
    return domain.transaction(() => {
      const references = copiedReferences(domain, [
        'hosts',
        'host_auth_refs',
        'bookmarks',
        'connection_profiles',
      ]);
      domain.appendEvent('catalog/home-copied', { generationInvalidated: true });
      return references;
    });
  } finally {
    await domain.close();
  }
}
