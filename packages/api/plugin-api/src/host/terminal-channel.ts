/** Transport-independent terminal IO; no ssh2/PTY vendor object crosses this contract. */
export type ShellIntegrationKind = 'bash' | 'zsh' | 'fish' | 'unsupported';
export const SHELL_INTEGRATION_SENTINEL_VARIABLE = 'AXTERM_SHELL_INTEGRATION';
export interface TerminalChannel {
  readonly pid?: number;
  readonly cwd?: string;
  readonly shellIntegrationKind?: ShellIntegrationKind;
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): void;
  onData(listener: (data: Uint8Array) => void): () => void;
  onExit(listener: (exitCode: number | null) => void): () => void;
  pause(): void;
  resume(): void;
  close(): Promise<void>;
}
