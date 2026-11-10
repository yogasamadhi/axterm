import { DomainCommands } from '@axterm/infra-storage-domain';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import {
  createBatchOperationSchema,
  type CreateBatchOperationInput,
  type AutomationReceipt,
} from '@axterm/plugin-api/automation';
import type { BatchOperationService, ManagedBatchOperation } from '../application/batches.ts';
/** No worker or abort side effect runs inside a fact transaction. */
export class BatchCommands {
  private readonly journal: DomainCommands;
  constructor(
    private readonly domain: RelationalDomain,
    private readonly service: BatchOperationService,
    private readonly together: <T>(operation: () => T) => T,
  ) {
    this.journal = new DomainCommands(domain, 'axterm_automation_command_receipts');
  }
  create(key: string, raw: CreateBatchOperationInput): AutomationReceipt {
    const input = createBatchOperationSchema.parse(raw);
    let prepared: ManagedBatchOperation | undefined;
    try {
      const result = this.together(() =>
        this.journal.execute(key, 'batch-operation.create', input, () => {
          prepared = this.service.prepare(input);
          return { ids: [prepared.metadata.id], cursor: this.domain.cursor() };
        }),
      );
      if (prepared) this.service.start(prepared);
      return result;
    } catch (error) {
      if (prepared) this.service.abandon(prepared.metadata.id);
      throw error;
    }
  }
  cancel(key: string, id: string): AutomationReceipt {
    let metadata: ReturnType<BatchOperationService['prepareCancel']> | undefined;
    const result = this.journal.execute(key, 'batch-operation.cancel', { id }, () => {
      metadata = this.service.prepareCancel(id);
      return { ids: [id], cursor: this.domain.cursor() };
    });
    if (metadata) this.service.cancelCommitted(id, metadata);
    return result;
  }
  clearCompleted(key: string): AutomationReceipt & { cleared: number } {
    return this.journal.execute(key, 'batch-operation.clear', {}, () => {
      const cleared = this.service.clearCompleted();
      return { ids: [], cursor: this.domain.cursor(), cleared };
    });
  }
}
