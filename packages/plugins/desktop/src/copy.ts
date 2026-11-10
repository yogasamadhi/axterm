import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import { productDomains } from '@axterm/data-schema';
import type {} from '@axterm/infra-storage-domain';
import { desktopWindowPreferencesSchema } from '@axterm/plugin-api/desktop';
const copiedPreferencesSchema = desktopWindowPreferencesSchema
  .extend({ rememberWindowSize: z.boolean().default(false) })
  .strip();
/** Retained preferences enter their current sole owner; Shell never writes the business facet. */
export async function migrateCopiedData(ctx: Context, document?: unknown): Promise<void> {
  const domain = await ctx.storage.domain.open(productDomains.desktop);
  try {
    if (document === undefined) return;
    if (
      !document ||
      typeof document !== 'object' ||
      !('version' in document) ||
      document.version !== 1 ||
      !('preferences' in document)
    )
      throw Error('DATA_COPY_DESKTOP_PREFERENCES');
    const preferences = copiedPreferencesSchema.parse(document.preferences);
    domain.transaction(() => {
      if (domain.get("SELECT id FROM axterm_desktop_preferences WHERE id='desktop'"))
        throw Error('DATA_COPY_DESKTOP_CONFLICT');
      domain.run(
        "INSERT INTO axterm_desktop_preferences(id,version,document_json) VALUES('desktop',1,?)",
        JSON.stringify(preferences),
      );
      domain.appendEvent('desktop/home-copied', { generationInvalidated: true });
    });
  } finally {
    await domain.close();
  }
}
