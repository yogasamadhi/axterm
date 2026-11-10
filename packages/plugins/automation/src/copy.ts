import { fromRow } from './adapters/batch-repository.ts';
import type { Context } from '@deepseek-ai/cordis';
import { productDomains, copiedReferences, type CopiedReferences } from '@axterm/data-schema';
import type {} from '@axterm/infra-storage-domain';
/** Offline copy conversion belongs to this domain; no network, command or old task is resumed. */
export async function migrateCopiedData(ctx: Context): Promise<CopiedReferences> {
  const domain = await ctx.storage.domain.open(productDomains.automation);
  try {
    return domain.transaction(() => {
      const now = new Date().toISOString();
      for (let offset = 0; ; offset += 64) {
        const rows = domain.all<Parameters<typeof fromRow>[0]>(
          'SELECT * FROM batch_operations ORDER BY id LIMIT 64 OFFSET ?',
          offset,
        );
        for (const row of rows) {
          if (Buffer.byteLength(row.payload) > 2 * 1024 * 1024)
            throw Error('DATA_COPY_BATCH_CAPACITY');
          const payload = JSON.parse(row.payload);
          const current = fromRow(row);
          if (!['queued', 'running', 'canceling'].includes(current.state)) continue;
          payload.targets = payload.targets.map(
            (target: { state: string; steps: { state: string }[] }) =>
              ['queued', 'connecting', 'running'].includes(target.state)
                ? {
                    ...target,
                    state: 'failed',
                    errorCode: 'RUNTIME_INTERRUPTED',
                    finishedAt: now,
                    steps: target.steps.map((step) =>
                      ['queued', 'running'].includes(step.state)
                        ? {
                            ...step,
                            state: 'canceled',
                            errorCode: 'RUNTIME_INTERRUPTED',
                            finishedAt: now,
                          }
                        : step,
                    ),
                  }
                : target,
          );
          payload.completedCount = payload.targets.length;
          payload.succeededCount = payload.targets.filter(
            (item: { state: string }) => item.state === 'succeeded',
          ).length;
          payload.failedCount = payload.targets.filter(
            (item: { state: string }) => item.state === 'failed',
          ).length;
          payload.canceledCount = payload.targets.filter(
            (item: { state: string }) => item.state === 'canceled',
          ).length;
          domain.run(
            "UPDATE batch_operations SET state='interrupted',payload=?,updated_at=?,version=version+1 WHERE id=?",
            JSON.stringify(payload),
            now,
            row.id,
          );
        }
        if (rows.length < 64) break;
      }
      const references = copiedReferences(domain, []);
      domain.appendEvent('automation/home-copied', { generationInvalidated: true });
      return references;
    });
  } finally {
    await domain.close();
  }
}
