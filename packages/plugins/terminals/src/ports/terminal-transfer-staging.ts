import type { TerminalTransferProtocol } from './terminal-transfer.ts';
/** Private paths belong only to this adapter; protocol engines never receive user paths. */
export interface TerminalTransferStage {
  readonly signal: AbortSignal;
  readonly path: string;
  readonly name: string;
  readonly kind: 'file' | 'directory';
  readonly size?: number;
  /** First accepted safe filename labels this private recovery group. */
  recordName?(name: string): void;
  publish(): Promise<void>;
  close(): Promise<void>;
}
export interface TerminalTransferStaging {
  prepare(
    grantId: string,
    direction: 'upload' | 'download',
    protocol: TerminalTransferProtocol,
    signal: AbortSignal,
  ): Promise<TerminalTransferStage>;
  close(): Promise<void>;
  resourceCount(): number;
}
