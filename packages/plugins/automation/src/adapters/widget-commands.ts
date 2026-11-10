import { DomainCommands } from '@axterm/infra-storage-domain';
import { RemoteError, StorageCommandError } from '@axterm/plugin-api';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import type { WidgetCommandReceipts } from '../ports/widgets.ts';

/** Reserve IO once; only identity hashes and compact reservations enter owned storage. */
export class WidgetCommands implements WidgetCommandReceipts {
  private readonly journal: DomainCommands;
  constructor(
    private readonly domain: RelationalDomain,
    private readonly profile: string,
    private readonly generation: string,
  ) {
    this.journal = new DomainCommands(domain, 'axterm_automation_command_receipts');
  }
  admit(key: string, operation: string, input: unknown): boolean {
    let admitted = false;
    try {
      this.journal.execute(
        key,
        'widget/admit',
        { profile: this.profile, generation: this.generation, operation, input },
        () => {
          admitted = true;
          return { reserved: true };
        },
      );
      return admitted;
    } catch (error) {
      if (error instanceof StorageCommandError) {
        if (error.code === 'receipt-expired') return false;
        throw new RemoteError('automation/widget-failure', 'The Widget operation failed', {
          reason:
            error.code === 'conflict'
              ? 'conflict'
              : error.code === 'invalid-input'
                ? 'invalid-input'
                : 'unavailable',
        });
      }
      throw error;
    }
  }
  has(key: string): boolean {
    return !!this.domain.get(
      "SELECT command_id FROM axterm_automation_command_receipts WHERE command_id=? AND operation='widget/admit'",
      key.toLowerCase(),
    );
  }
}
