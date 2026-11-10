import { SettingsRepository } from './adapters/settings-repository.ts';
import type { Context } from '@deepseek-ai/cordis';
import { productDomains, copiedReferences, type CopiedReferences } from '@axterm/data-schema';
import type {} from '@axterm/infra-storage-domain';
/** Offline copy conversion belongs to this domain; no network, command or old task is resumed. */
export async function migrateCopiedData(ctx: Context): Promise<CopiedReferences> {
  const domain = await ctx.storage.domain.open(productDomains.configuration);
  try {
    return domain.transaction(() => {
      domain.run(
        "UPDATE sync_profiles SET state='failed',last_error_code='RUNTIME_INTERRUPTED',pending_preview_id=NULL,updated_at=?,version=version+1 WHERE state IN ('checking','uploading','download-preview','syncing','running','previewing','awaiting-confirmation') OR pending_preview_id IS NOT NULL",
        new Date().toISOString(),
      );
      new SettingsRepository(domain).getSettings();
      const references = copiedReferences(domain, ['app_settings', 'sync_profiles']);
      domain.appendEvent('configuration/home-copied', { generationInvalidated: true });
      return references;
    });
  } finally {
    await domain.close();
  }
}
