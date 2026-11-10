import type { FileOperationReceipt } from '@axterm/plugin-api/files';
export interface FileCommands {
  execute(
    id: string,
    operation: string,
    input: unknown,
    perform: (signal: AbortSignal) => Promise<number>,
    signal: AbortSignal,
  ): Promise<FileOperationReceipt>;
  close(): Promise<void>;
}
