import type { TerminalChannel } from './terminal-channel';

export interface TelnetConnectInput {
  host: string;
  port: number;
  username: string;
  password?: string;
  loginPrompt: RegExp;
  passwordPrompt: RegExp;
  encoding: string;
  cols: number;
  rows: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface TelnetTransport {
  connect(input: TelnetConnectInput): Promise<TerminalChannel>;
}
