import type { Transfer, TransferCommandOutcome } from '@axterm/plugin-api/transfers';
export interface TransferRepository {
  commandOutcome(key: string): TransferCommandOutcome;
  reserve(
    key: string,
    input: unknown,
    create: () => Transfer,
  ): { created: boolean; transfer: Transfer };
  saveTransfer(value: Transfer & { source: string; destination: string }): void;
  listTransfers(): Transfer[];
  getTransfer(id: string): Transfer;
  clearCompletedTransfers(): number;
}
