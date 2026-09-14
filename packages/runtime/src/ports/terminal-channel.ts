export type ShellIntegrationKind = 'bash' | 'zsh' | 'fish' | 'unsupported';

export interface TerminalChannel {
  readonly pid?: number;
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

export interface PtyPort {
  open(input: {
    shell?: string;
    args: string[];
    cwd?: string;
    env: Record<string, string>;
    term: string;
    loginShell: boolean;
    cols: number;
    rows: number;
  }): TerminalChannel;
}
