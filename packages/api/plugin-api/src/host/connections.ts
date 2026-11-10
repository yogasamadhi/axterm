import type { RelationalParticipant } from '../storage.ts';
import type { Duplex } from 'node:stream';
import type { HostProxyConfig } from '../catalog.ts';
import type { RemoteFileTarget } from '../files.ts';
import type { RemoteFileLease } from './remote-files.ts';
import type {
  OpenBookmarkTerminalInput,
  SerialPortInfo,
  ConnectionFactReceipt,
  TunnelProfileInput,
  TunnelProfilePatch,
  StartTunnelInput,
  Tunnel,
  TunnelProfile,
  Connection,
  FtpConnection,
  CreateFtpConnectionInput,
  CreateConnectionInput,
  TerminalSession,
  TerminalAppearance,
  TerminalBehavior,
} from '../connections.ts';
export interface OpenConnectionTerminal {
  cols: number;
  rows: number;
  bookmarkId?: string;
  profileId?: string;
  term?: string;
  env?: Record<string, string>;
  directory?: string;
  appearance?: TerminalAppearance;
  behavior?: TerminalBehavior;
}
/** Selected application operations; no transport/vendor handle is exposed. */
export type { OpenBookmarkTerminalInput } from '../connections.ts';
export interface ConnectionStreamInput {
  target: { host: string; port: number };
  proxy: HostProxyConfig;
  username: string;
  jumpHostId: string | null;
  timeoutMs: number;
}
export interface ConnectionStreamLease {
  readonly stream: Duplex;
  close(): Promise<void>;
}
export interface ConnectionsApplication {
  readonly participant?: RelationalParticipant;
  openStream(input: ConnectionStreamInput, signal: AbortSignal): Promise<ConnectionStreamLease>;
  createTunnelProfile(key: string, input: TunnelProfileInput): ConnectionFactReceipt;
  updateTunnelProfile(
    key: string,
    id: string,
    input: TunnelProfilePatch,
    ifMatch: string | undefined,
  ): ConnectionFactReceipt;
  deleteTunnelProfile(key: string, id: string, ifMatch: string | undefined): ConnectionFactReceipt;
  startTunnel(key: string, input: StartTunnelInput, signal?: AbortSignal): Promise<Tunnel>;
  stopTunnel(id: string): Promise<void>;
  listTunnels(): Tunnel[];
  listTunnelProfiles(): TunnelProfile[];
  listSerialPorts(): Promise<SerialPortInfo[]>;
  openBookmarkTerminal(
    input: OpenBookmarkTerminalInput,
    signal?: AbortSignal,
  ): Promise<TerminalSession>;
  create(key: string, input: CreateConnectionInput): Promise<Connection>;
  list(): Connection[];
  get(id: string): Connection;
  /** Captured SSH identity/generation for approval target binding, never a transport handle. */
  executionTarget(id: string): {
    hostname: string;
    port: number;
    username: string;
    generation: number;
  };
  close(id: string): Promise<void>;
  openTerminal(id: string, input: OpenConnectionTerminal): Promise<TerminalSession>;
  createFtp(
    key: string,
    input: CreateFtpConnectionInput,
    signal?: AbortSignal,
  ): Promise<FtpConnection>;
  getFtp(id: string): FtpConnection;
  closeFtp(id: string): Promise<void>;
  openFiles(target: RemoteFileTarget, signal?: AbortSignal): Promise<RemoteFileLease>;
  exec(
    id: string,
    input: { command: string; maxBytes?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    connections: ConnectionsApplication;
  }
}
