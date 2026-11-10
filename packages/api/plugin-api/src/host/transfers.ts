import type { Transfer, CreateTransferInput, TransferConflictDecision } from '../transfers.ts';
export interface TransfersApplication {
  create(key: string, input: CreateTransferInput): Transfer;
  list(): Transfer[];
  get(id: string): Transfer;
  cancel(key: string, id: string): void;
  pause(key: string, id: string): void;
  resume(key: string, id: string): void;
  decideConflict(key: string, id: string, decision: TransferConflictDecision): void;
  retry(key: string, id: string): Transfer;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    transfers: TransfersApplication;
  }
}
