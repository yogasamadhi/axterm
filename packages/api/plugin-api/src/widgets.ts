// First-party contracts retained from frozen Axterm; durable facts remain in their domain owners.
import { z } from 'zod';
import { entityFields, idSchema } from './schemas/resources.ts';
import { credentialMutationMarkerSchema } from './saved-credentials.ts';
export const widgetIdSchema = z.enum([
  'file-renamer',
  'local-file-server',
  'local-ftp-server',
  'local-ssh-server',
  'mcp-server',
]);
export const widgetDefinitionSchema = z
  .object({
    id: widgetIdSchema,
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(500),
    version: z.string().trim().min(1).max(32),
    type: z.enum(['once', 'instance']),
    builtin: z.literal(true),
    singleInstance: z.boolean(),
  })
  .strict();
export const widgetInstanceStateSchema = z.enum([
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed',
]);
export const widgetServerInfoSchema = z
  .object({
    url: z.url(),
    rootName: z.string().trim().min(1).max(255),
    username: z.string().trim().min(1).max(255).nullable().default(null),
    authentication: z.enum(['none', 'password', 'bearer']).default('none'),
    protocol: z.enum(['http', 'ftp', 'ssh', 'mcp']).optional(),
    protocolVersion: z.string().trim().min(1).max(32).optional(),
    activeSessions: z.number().int().nonnegative().max(32).optional(),
    toolCount: z.number().int().nonnegative().max(64).optional(),
  })
  .strict();
export const widgetInstanceSchema = z
  .object({
    ...entityFields,
    widgetId: widgetIdSchema,
    title: z.string().trim().min(1).max(100),
    state: widgetInstanceStateSchema,
    bindHost: z.string().max(255).nullable(),
    port: z.number().int().min(0).max(65_535).nullable(),
    serverInfo: widgetServerInfoSchema.nullable(),
    ownerGeneration: idSchema,
    errorCode: z.string().max(100).optional(),
  })
  .strict();
export const startLocalFileServerSchema = z
  .object({
    grantId: z.string().min(1).max(256),
    title: z.string().trim().min(1).max(100).default('Static File Server'),
    host: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(
        (value) =>
          value === 'localhost' ||
          value === '127.0.0.1' ||
          value === '::1' ||
          value === '0.0.0.0' ||
          value === '::',
        'Expected a supported loopback or all-interface bind address',
      )
      .default('127.0.0.1'),
    port: z.number().int().min(0).max(65_535).default(3_456),
    index: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(
        (value) => !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..',
        'Index must be a file name',
      )
      .default('index.html'),
    dotfiles: z.enum(['allow', 'deny', 'ignore']).default('allow'),
    cacheControl: z.boolean().default(true),
    maxAgeMs: z.number().int().min(0).max(31_536_000_000).default(31_536_000_000),
    lastModified: z.boolean().default(true),
    etag: z.boolean().default(true),
    acceptRanges: z.boolean().default(true),
    redirect: z.boolean().default(true),
  })
  .strict();
export const renameWidgetInstanceSchema = z
  .object({ title: z.string().trim().min(1).max(100) })
  .strict();
const widgetUsernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\0\r\n]/u.test(value), 'Username cannot contain control lines');
const widgetPasswordSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !/[\0\r\n]/u.test(value), 'Password cannot contain control lines');
const localFtpHostSchema = z.enum(['localhost', '127.0.0.1', '::1']);
export const startLocalFtpServerSchema = z
  .object({
    grantId: z.string().min(1).max(256),
    title: z.string().trim().min(1).max(100).default('Local FTP Server'),
    // FTP has no transport encryption. Keep this Widget on the local machine;
    // the SSH Server Widget is the encrypted option for network sharing.
    host: localFtpHostSchema.default('127.0.0.1'),
    port: z.number().int().min(0).max(65_535).default(2_121),
    anonymous: z.boolean().default(false),
    username: widgetUsernameSchema.default('ftpuser'),
    password: widgetPasswordSchema.optional(),
    passivePortStart: z.number().int().min(1_024).max(65_535).default(50_000),
    passivePortEnd: z.number().int().min(1_024).max(65_535).default(50_031),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.anonymous && !value.password)
      context.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'Password is required when anonymous login is disabled',
      });
    if (value.passivePortEnd < value.passivePortStart)
      context.addIssue({
        code: 'custom',
        path: ['passivePortEnd'],
        message: 'Passive port end must be greater than or equal to its start',
      });
    if (value.passivePortEnd - value.passivePortStart > 63)
      context.addIssue({
        code: 'custom',
        path: ['passivePortEnd'],
        message: 'Passive port range is limited to 64 ports',
      });
  });
export const startLocalSshServerSchema = z
  .object({
    grantId: z.string().min(1).max(256),
    title: z.string().trim().min(1).max(100).default('SSH Server'),
    host: startLocalFileServerSchema.shape.host.default('127.0.0.1'),
    port: z.number().int().min(0).max(65_535).default(22_225),
    username: widgetUsernameSchema.default('test'),
    password: widgetPasswordSchema,
  })
  .strict();

const registeredAiToolNames = [
  'host.getSummary',
  'terminal.getRecentOutput',
  'terminal.execReadOnly',
  'sftp.list',
  'sftp.readText',
  'system.inspectDisk',
  'system.inspectMemory',
  'system.inspectProcesses',
  'system.inspectService',
  'terminal.exec',
] as const;
export const aiToolNameSchema = z.enum(registeredAiToolNames);
export const startMcpServerSchema = z
  .object({
    title: z.string().trim().min(1).max(100).default('MCP Server'),
    host: z
      .enum(['localhost', '127.0.0.1', '::1'])
      .default('127.0.0.1')
      .describe('MCP servers are restricted to loopback interfaces'),
    port: z.number().int().min(0).max(65_535).default(30_837),
    credentialRef: z.string().min(1).max(256),
    ownedCredential: credentialMutationMarkerSchema.optional(),
    enabledTools: z
      .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/u))
      .min(1)
      .max(64)
      .default([...registeredAiToolNames]),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.enabledTools).size !== value.enabledTools.length)
      context.addIssue({
        code: 'custom',
        path: ['enabledTools'],
        message: 'Enabled MCP tools must be unique',
      });
  });

export type WidgetId = z.infer<typeof widgetIdSchema>;
export type WidgetDefinition = z.infer<typeof widgetDefinitionSchema>;
export type WidgetInstance = z.infer<typeof widgetInstanceSchema>;
export type StartLocalFileServerInput = z.input<typeof startLocalFileServerSchema>;
export type StartLocalFtpServerInput = z.input<typeof startLocalFtpServerSchema>;
export type StartLocalSshServerInput = z.input<typeof startLocalSshServerSchema>;
export type StartMcpServerInput = z.input<typeof startMcpServerSchema>;
export type RenameWidgetInstanceInput = z.input<typeof renameWidgetInstanceSchema>;
export interface WidgetMcpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly risk: 'read_only' | 'mutating' | 'destructive' | 'privileged';
}
export interface WidgetMcpInvocation {
  readonly runId: string;
  readonly state: 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'canceled';
  readonly toolCallId?: string;
  readonly approvalId?: string;
  readonly argsHash?: string;
  readonly expiresAt?: string;
  readonly result?: unknown;
  readonly errorCode?: string;
}
export interface WidgetMcpToolSummary {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly risk: 'read_only' | 'mutating' | 'destructive' | 'privileged';
}
export interface WidgetFacts {
  readonly generation: string;
  readonly cursor: number;
  readonly definitions: readonly WidgetDefinition[];
  readonly instances: readonly WidgetInstance[];
  readonly mcpTools: readonly WidgetMcpToolSummary[];
}
export interface WidgetBaseline extends WidgetFacts {
  readonly type: 'baseline';
}
export interface WidgetReplacement extends WidgetFacts {
  readonly type: 'replace';
}
export type WidgetUpdate = WidgetBaseline | WidgetReplacement;
export interface WidgetCommandOutcome {
  readonly key: string;
  readonly generation: string;
  readonly status: 'pending' | 'completed' | 'failed' | 'missing';
  readonly cursor: number;
  readonly instance?: WidgetInstance;
  readonly reason?: WidgetFailureReason;
}
export type WidgetFailureReason =
  | 'receipt-expired'
  | 'invalid-input'
  | 'stale'
  | 'not-found'
  | 'conflict'
  | 'capacity'
  | 'unavailable'
  | 'closed'
  | 'uncertain';
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'automation/widget-failure': { readonly reason: WidgetFailureReason };
  }
}
export const widgetFactsSchema = z
  .object({
    generation: z.uuid(),
    cursor: z.number().int().nonnegative(),
    definitions: z.array(widgetDefinitionSchema).max(5),
    instances: z.array(widgetInstanceSchema).max(8),
    mcpTools: z
      .array(
        z
          .object({
            name: z.string().max(128),
            title: z.string().max(512),
            description: z.string().max(8192),
            risk: z.enum(['read_only', 'mutating', 'destructive', 'privileged']),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
