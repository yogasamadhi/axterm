import type { SshOperationDiagnostic } from './schemas/ssh-diagnostic.ts';
import type { ReconnectConnectionHistoryInput } from './schemas/connection-history.ts';
export {
  createConnectionSchema,
  connectionHopSchema,
  quickConnectTargetSchema,
  connectionSchema,
  knownHostKeySchema,
  interactionSchema,
  interactionResponseSchema,
  sshAgentProbeInputSchema,
  sshAgentStatusSchema,
  proxyTestRequestSchema,
  proxyTestResultSchema,
  sshAlgorithmsSchema,
  DEFAULT_HOST_PROXY,
  DEFAULT_GLOBAL_PROXY,
  DEFAULT_SSH_STARTUP,
  DEFAULT_SSH_CONNECTION_OPTIONS,
  DEFAULT_SSH_X11,
  DEFAULT_SSH_AGENT,
} from './schemas/resources.ts';
export type {
  Connection,
  CreateConnectionInput,
  ConnectionHopInput,
  QuickConnectTarget,
  Host,
  HostProxyConfig,
  KnownHostKey,
  Interaction,
  SshAlgorithms,
  SshStartup,
  SshAgentStatus,
  ProxyEndpointConfig,
  GlobalProxyConfig,
  ProxyTestRequest,
  ProxyTestResult,
} from './schemas/resources.ts';

export {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_BEHAVIOR,
  DEFAULT_TERMINAL_TYPE,
} from './terminals.ts';
export type { TerminalAppearance, TerminalBehavior, TerminalSession } from './terminals.ts';
export type { ConnectionProfile } from './catalog.ts';
export type { Settings } from './configuration.ts';
export { proxyCommandSchema } from './schemas/resources.ts';
import type { z } from 'zod';
import type { proxyCommandSchema } from './schemas/resources.ts';
export type ProxyCommandConfig = z.infer<typeof proxyCommandSchema>;
import { z as schema } from 'zod';
import {
  interactionSchema as baseInteraction,
  interactionResponseSchema as baseResponse,
} from './schemas/resources.ts';
export const connectionInteractionSchema = baseInteraction
  .extend({
    kind: schema.enum([
      'unknownHostKey',
      'changedHostKey',
      'keyboardInteractive',
      'temporarySecret',
    ]),
    title: schema.string().max(512),
    detail: schema.string().max(16_384),
    fields: schema
      .array(
        schema
          .object({
            id: schema.string().max(128),
            label: schema.string().max(8_192),
            secret: schema.boolean(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
export const connectionInteractionResponseSchema = baseResponse
  .extend({
    values: schema
      .record(schema.string().max(128), schema.string().max(131_072))
      .refine((values) => Object.keys(values).length <= 64)
      .default({}),
  })
  .strict();
export type ConnectionInteractionResponseInput = schema.input<
  typeof connectionInteractionResponseSchema
>;
import type { sshAgentProbeInputSchema } from './schemas/resources.ts';
export type SshAgentProbeInput = schema.input<typeof sshAgentProbeInputSchema>;
import type {} from './index.ts';
import type { TypertResource, ClientFactsView } from './types.ts';
export type ConnectionFailureReason =
  | 'stale'
  | 'invalid-input'
  | 'not-found'
  | 'unavailable'
  | 'capacity'
  | 'closed'
  | 'cancelled'
  | 'conflict'
  | 'receipt-expired'
  | 'precondition-required'
  | 'precondition-failed'
  | 'internal';
import type {
  Connection,
  Interaction,
  KnownHostKey,
  CreateConnectionInput,
  SshAgentStatus,
  ProxyTestRequest,
  ProxyTestResult,
} from './schemas/resources.ts';
export type ConnectionCollection =
  'connections' | 'ftpConnections' | 'interactions' | 'knownHosts' | 'tunnelProfiles' | 'tunnels';
export interface ConnectionsBaseline {
  readonly generation: string;
  readonly cursor: number;
  readonly revision: number;
  readonly connections: readonly Connection[];
  readonly ftpConnections: readonly FtpConnection[];
  readonly interactions: readonly Interaction[];
  readonly knownHosts: readonly KnownHostKey[];
  readonly tunnelProfiles: readonly TunnelProfile[];
  readonly tunnels: readonly Tunnel[];
}
export type ConnectionsUpdate =
  | {
      readonly type: 'begin';
      readonly generation: string;
      readonly cursor: number;
      readonly revision: number;
      readonly mode: 'baseline' | 'delta';
      readonly collections: readonly ConnectionCollection[];
    }
  | {
      readonly type: 'chunk';
      readonly collection: ConnectionCollection;
      readonly offset: number;
      readonly text: string;
      readonly final: boolean;
    }
  | { readonly type: 'commit'; readonly revision: number };
export const CONNECTIONS_CHUNK_CHARACTERS = 16_384;
export const CONNECTIONS_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
declare module '@deepseek-ai/cordis' {
  interface Events {
    'connections/history-recording-failed'(payload: {
      readonly connectionId: string;
      readonly errorCode: 'CONNECTION_HISTORY_WRITE_FAILED';
    }): void;
  }
}
declare module './index.ts' {
  interface TypertRemoteEventSelection {
    'connections/history-recording-failed': true;
  }
}
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'connections/failure': {
      readonly reason: ConnectionFailureReason;
      readonly diagnostic?: SshOperationDiagnostic;
    };
  }
}
declare module './index.ts' {
  interface TypertResourceMap {
    connection: TypertResource<string>;
    connectionInteraction: TypertResource<string>;
    knownHostKey: TypertResource<string>;
  }
}

export const ftpConnectionSchema = schema
  .object({
    id: schema.uuid(),
    bookmarkId: schema.uuid(),
    name: schema.string().trim().min(1).max(100),
    hostname: schema.string().trim().min(1).max(253),
    port: schema.number().int().min(1).max(65_535),
    username: schema.string().trim().min(1).max(128),
    security: schema.enum(['plain', 'explicit-tls', 'implicit-tls']),
    encoding: schema.enum(['utf-8', 'gbk', 'gb18030', 'big5', 'shift-jis', 'euc-jp', 'euc-kr']),
    initialDirectory: schema
      .string()
      .min(1)
      .max(4096)
      .refine((value) => value.startsWith('/') && !value.includes('\0')),
    state: schema.enum(['connecting', 'ready', 'closing', 'closed', 'failed']),
    errorCode: schema.string().optional(),
    createdAt: schema.iso.datetime(),
    updatedAt: schema.iso.datetime(),
  })
  .strict();
export const createFtpConnectionSchema = schema.object({ bookmarkId: schema.uuid() }).strict();

export type FtpConnection = schema.infer<typeof ftpConnectionSchema>;
export type CreateFtpConnectionInput = schema.input<typeof createFtpConnectionSchema>;

export const serialPortInfoSchema = schema
  .object({
    path: schema.string().min(1).max(1024),
    manufacturer: schema.string().max(512).optional(),
    serialNumber: schema.string().max(512).optional(),
    pnpId: schema.string().max(1024).optional(),
    locationId: schema.string().max(512).optional(),
    vendorId: schema.string().max(64).optional(),
    productId: schema.string().max(64).optional(),
  })
  .strict();
export type SerialPortInfo = schema.infer<typeof serialPortInfoSchema>;
import { terminalAppearanceSchema, terminalBehaviorSchema } from './terminals.ts';
export const openBookmarkTerminalSchema = schema
  .object({
    kind: schema.enum(['serial', 'telnet']),
    bookmarkId: schema.uuid(),
    profileId: schema.uuid().optional(),
    cols: schema.number().int().min(2).max(500),
    rows: schema.number().int().min(2).max(300),
    appearance: terminalAppearanceSchema.optional(),
    behavior: terminalBehaviorSchema.optional(),
  })
  .strict();
export type OpenBookmarkTerminalInput = schema.infer<typeof openBookmarkTerminalSchema>;

export const tunnelProfileSchema = schema
  .object({
    id: schema.uuid(),
    name: schema.string().max(8192),
    hostId: schema.uuid(),
    type: schema.enum(['local', 'remote', 'dynamic']),
    bindHost: schema
      .string()
      .max(4096)
      .refine((value) => !/[\0\r\n]/u.test(value)),
    bindPort: schema.number().int().min(0).max(65535),
    targetHost: schema
      .string()
      .max(4096)
      .refine((value) => !/[\0\r\n]/u.test(value))
      .nullable(),
    targetPort: schema.number().int().min(1).max(65535).nullable(),
    allowNonLoopback: schema.boolean(),
    createdAt: schema.iso.datetime(),
    updatedAt: schema.iso.datetime(),
    version: schema.number().int().positive(),
  })
  .strict();
const tunnelProfileFields = tunnelProfileSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  version: true,
});
export const tunnelProfileInputSchema = tunnelProfileFields.superRefine((value, ctx) => {
  if (value.type !== 'dynamic' && (!value.targetHost || !value.targetPort))
    ctx.addIssue({ code: 'custom', message: 'Forwarding target is required' });
  if (value.type === 'dynamic' && (value.targetHost || value.targetPort))
    ctx.addIssue({ code: 'custom', message: 'Dynamic tunnels have no fixed target' });
  if (
    value.type !== 'remote' &&
    !value.allowNonLoopback &&
    !['127.0.0.1', 'localhost', '::1'].includes(value.bindHost)
  )
    ctx.addIssue({ code: 'custom', message: 'Non-loopback binding requires explicit opt-in' });
});
export const tunnelProfilePatchSchema = tunnelProfileFields.partial().strict();
export type TunnelProfile = schema.infer<typeof tunnelProfileSchema>;
export type TunnelProfileInput = schema.infer<typeof tunnelProfileInputSchema>;
export type TunnelProfilePatch = schema.infer<typeof tunnelProfilePatchSchema>;
export const tunnelSchema = schema
  .object({
    id: schema.uuid(),
    profileId: schema.uuid().optional(),
    connectionId: schema.uuid(),
    type: schema.enum(['local', 'remote', 'dynamic']),
    state: schema.enum(['starting', 'active', 'stopping', 'closed', 'failed']),
    bindHost: schema.string().max(4096),
    bindPort: schema.number().int().min(0).max(65535),
    errorCode: schema.string().max(100).optional(),
    createdAt: schema.iso.datetime(),
  })
  .strict();
export type Tunnel = schema.infer<typeof tunnelSchema>;
export const startTunnelSchema = schema
  .object({
    connectionId: schema.uuid(),
    profileId: schema.uuid().optional(),
    profile: tunnelProfileInputSchema.optional(),
  })
  .strict()
  .refine((value) => value.profileId || value.profile, { message: 'A profile is required' });
export type StartTunnelInput = schema.infer<typeof startTunnelSchema>;
export interface ConnectionFactReceipt {
  readonly ids: readonly string[];
  readonly cursor: number;
  readonly version?: number;
}
declare module './index.ts' {
  interface TypertResourceMap {
    tunnel: TypertResource<string>;
    tunnelProfile: TypertResource<string>;
  }
}

/** Selected browser capabilities delegate to the sole Connections Client owner. */
export type FtpConnectionCommandOutcome =
  ConnectionCommandOutcome | { readonly status: 'rejected' };
export interface ConnectionClientActions extends ClientFactsView<ConnectionsBaseline> {
  getFtpCommandOutcome(generation: string, key: string): Promise<FtpConnectionCommandOutcome>;
  createFtpConnection(
    key: string,
    input: CreateFtpConnectionInput,
    signal?: AbortSignal,
  ): Promise<FtpConnection>;
  listFtpConnections(): Promise<FtpConnection[]>;
  getFtpConnection(id: string): Promise<FtpConnection>;
  closeFtpConnection(id: string): Promise<void>;
  getCommandOutcome(generation: string, key: string): Promise<ConnectionCommandOutcome>;
  getTunnelCommandOutcome(
    generation: string,
    key: string,
  ): Promise<ConnectionCommandOutcome | { readonly status: 'rejected' }>;
  reconnectHistory(
    key: string,
    id: string,
    input: ReconnectConnectionHistoryInput,
    ifMatch: string | undefined,
  ): Promise<Connection>;
  create(key: string, input: CreateConnectionInput): Promise<Connection>;
  close(id: string): Promise<void>;
  retryConnection(key: string, id: string): Promise<Connection>;
  cancelReconnect(id: string): Promise<Connection>;
  listSerialPorts(): Promise<SerialPortInfo[]>;
  sshAgentStatus(input: SshAgentProbeInput): Promise<SshAgentStatus>;
  testProxy(input: ProxyTestRequest, signal?: AbortSignal): Promise<ProxyTestResult>;
  listTunnelProfiles(): Promise<TunnelProfile[]>;
  createTunnelProfile(key: string, input: TunnelProfileInput): Promise<ConnectionFactReceipt>;
  updateTunnelProfile(
    key: string,
    id: string,
    input: TunnelProfilePatch,
    ifMatch: string | undefined,
  ): Promise<ConnectionFactReceipt>;
  deleteTunnelProfile(
    key: string,
    id: string,
    ifMatch: string | undefined,
  ): Promise<ConnectionFactReceipt>;
  startTunnel(key: string, input: StartTunnelInput, signal?: AbortSignal): Promise<Tunnel>;
  stopTunnel(id: string): Promise<void>;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    connectionActions: ConnectionClientActions;
  }
}

export { reconnectConnectionHistorySchema } from './schemas/connection-history.ts';
export type { ReconnectConnectionHistoryInput } from './schemas/connection-history.ts';

/** Generation-local IO outcome lookup never repeats a network-opening command. */
export type ConnectionCommandOutcome =
  | { readonly status: 'accepted'; readonly id: string }
  | { readonly status: 'missing' | 'pending' | 'uncertain' | 'expired' };
