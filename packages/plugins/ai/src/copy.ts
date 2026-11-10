import type { Context } from '@deepseek-ai/cordis';
import { productDomains, copiedReferences, type CopiedReferences } from '@axterm/data-schema';
import type {} from '@axterm/infra-storage-domain';
/** Offline copy conversion belongs to this domain; no network, command or old task is resumed. */
export async function migrateCopiedData(ctx: Context): Promise<CopiedReferences> {
  const domain = await ctx.storage.domain.open(productDomains.ai);
  try {
    return domain.transaction(() => {
      const now = new Date().toISOString();
      domain.run(
        "UPDATE ai_approvals SET state='expired',decided_at=?,updated_at=?,version=version+1 WHERE state='pending' OR (state='approved' AND run_id IN (SELECT id FROM ai_runs WHERE state IN ('queued','running','waiting_approval')))",
        now,
        now,
      );
      domain.run(
        "UPDATE ai_tool_calls SET state='failed',result_metadata=?,updated_at=?,version=version+1 WHERE state IN ('proposed','waiting_approval','running')",
        JSON.stringify({ errorCode: 'RUNTIME_INTERRUPTED' }),
        now,
      );
      domain.run(
        "UPDATE ai_runs SET state='failed',error_code='RUNTIME_INTERRUPTED',updated_at=?,version=version+1 WHERE state IN ('queued','running','waiting_approval')",
        now,
      );
      domain.run(
        "UPDATE ai_messages SET state='failed',updated_at=?,version=version+1 WHERE state IN ('streaming','pending')",
        now,
      );
      const references = copiedReferences(domain, ['ai_providers']);
      domain.appendEvent('ai/home-copied', { generationInvalidated: true });
      return references;
    });
  } finally {
    await domain.close();
  }
}
