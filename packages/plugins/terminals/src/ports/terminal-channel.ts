import type { TerminalChannel } from '@axterm/plugin-api/host';
export type { TerminalChannel, ShellIntegrationKind } from '@axterm/plugin-api/host';
export { SHELL_INTEGRATION_SENTINEL_VARIABLE } from '@axterm/plugin-api/host';

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
    signal?: AbortSignal;
  }): TerminalChannel | Promise<TerminalChannel>;
}
