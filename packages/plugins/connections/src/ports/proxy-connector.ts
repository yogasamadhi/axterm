import type { Duplex } from 'node:stream';

export interface ProxyEndpoint {
  url: string;
  username?: string;
  password?: string;
}

export interface ProxyConnectRequest {
  proxy: ProxyEndpoint;
  target: { host: string; port: number };
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ProxyConnector {
  connect(request: ProxyConnectRequest): Promise<Duplex>;
}
