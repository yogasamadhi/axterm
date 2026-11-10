import type { BatchOperation } from '@axterm/plugin-api/automation';
export interface BatchRepository {
  list(limit?: number): BatchOperation[];
  get(id: string): BatchOperation;
  create(value: BatchOperation): BatchOperation;
  save(value: BatchOperation): BatchOperation;
  activeCount(): number;
  release(id: string): void;
  clearCompleted(): number;
}
