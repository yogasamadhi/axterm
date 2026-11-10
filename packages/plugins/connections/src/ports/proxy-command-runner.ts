import type { Duplex } from 'node:stream';
import type { ProxyCommandConfig } from '@axterm/plugin-api/connections';

export interface ProxyCommandRequest {
  command: ProxyCommandConfig;
  target: { host: string; port: number };
  username: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ProxyCommandRunner {
  connect(request: ProxyCommandRequest): Promise<Duplex>;
}
