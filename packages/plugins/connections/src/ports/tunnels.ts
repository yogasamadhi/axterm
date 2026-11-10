import type { TunnelProfile, Tunnel } from '@axterm/plugin-api/connections';
export interface TunnelLease {
  readonly signal: AbortSignal;
  readonly bindPort: number;
  close(): Promise<void>;
}
export interface TunnelTransport {
  start(connectionId: string, profile: TunnelProfile, signal: AbortSignal): Promise<TunnelLease>;
  closeConnection(id: string): Promise<void>;
  resourceCount(): number;
  close(): Promise<void>;
}
export interface TunnelProfiles {
  list(): TunnelProfile[];
  get(id: string): TunnelProfile;
}
export interface TunnelEvents {
  changed(value: Tunnel): void;
}
