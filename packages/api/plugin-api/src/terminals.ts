import { terminalBackgroundAssetSchema } from './schemas/terminal-themes.ts';
import type { ClientFactsView } from './types.ts';
import {
  idSchema,
  timestampSchema,
  DEFAULT_TERMINAL_BEHAVIOR,
  DEFAULT_TERMINAL_APPEARANCE,
  terminalAppearanceSchema,
  terminalBehaviorSchema,
} from './schemas/resources.ts';
export {
  idSchema,
  timestampSchema,
  DEFAULT_TERMINAL_BEHAVIOR,
  terminalAppearanceSchema,
  terminalClipboardAccessPolicySchema,
  terminalScrollbackSchema,
  terminalRendererPreferenceSchema,
  terminalUnicodeVersionSchema,
  terminalWordSeparatorSchema,
  terminalBackspaceModeSchema,
  terminalShiftEnterModeSchema,
  TERMINAL_ENCODINGS,
  terminalEncodingSchema,
  terminalBehaviorSchema,
} from './schemas/resources.ts';
// Pure terminal contracts migrated from the frozen Axterm resources Contract (ADR-048).
import { z } from 'zod';

export const terminalRecordingSchema = z
  .object({
    terminalId: idSchema,
    state: z.enum(['active', 'stopped', 'error']),
    fileName: z.string().min(1).max(255),
    timestamps: z.boolean(),
    bytesWritten: z.number().int().nonnegative(),
    startedAt: timestampSchema,
    stoppedAt: timestampSchema.optional(),
    errorCode: z.string().max(100).optional(),
  })
  .strict();
export const terminalTransferProtocolSchema = z.enum(['zmodem', 'xmodem', 'trzsz']);
export const terminalTransferDirectionSchema = z.enum(['upload', 'download']);
export const terminalTransferStateSchema = z
  .object({
    terminalId: idSchema,
    runId: z.uuid().optional(),
    protocol: terminalTransferProtocolSchema,
    direction: terminalTransferDirectionSchema,
    state: z.enum([
      'waiting-selection',
      'waiting-peer',
      'transferring',
      'completed',
      'failed',
      'canceled',
    ]),
    selection: z.enum(['file', 'directory']).optional(),
    fileName: z.string().max(255).optional(),
    fileCount: z.number().int().min(0).max(10_000).optional(),
    transferredBytes: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().nonnegative().optional(),
    speedBytesPerSecond: z.number().int().nonnegative().optional(),
    errorCode: z.string().max(100).optional(),
    updatedAt: timestampSchema,
  })
  .strict();
export const terminalTransferActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      protocol: z.literal('xmodem'),
      direction: terminalTransferDirectionSchema,
      grantId: z.string().min(1).max(256),
      fileName: z.string().trim().min(1).max(255).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('provide-selection'),
      runId: z.uuid(),
      protocol: z.enum(['zmodem', 'trzsz']),
      grantId: z.string().min(1).max(256),
    })
    .strict(),
  z.object({ action: z.literal('cancel'), runId: z.uuid().optional() }).strict(),
]);
export const terminalTransferRecoveryRecordSchema = z
  .object({
    id: z.uuid(),
    protocol: terminalTransferProtocolSchema,
    name: z.string().min(1).max(255),
    createdAt: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    state: z.enum(['verified', 'absent', 'unverified', 'expired']),
  })
  .strict();
export type TerminalTransferState = z.infer<typeof terminalTransferStateSchema>;
export type TerminalTransferAction = z.infer<typeof terminalTransferActionSchema>;
export type TerminalTransferRecoveryRecord = z.infer<typeof terminalTransferRecoveryRecordSchema>;
export type TerminalTransferProtocol = z.infer<typeof terminalTransferProtocolSchema>;
export const terminalSessionSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['local', 'ssh', 'telnet', 'serial']),
    title: z.string(),
    state: z.enum(['opening', 'ready', 'closed', 'failed']),
    connectionId: idSchema.optional(),
    bookmarkId: idSchema.optional(),
    profileId: idSchema.optional(),
    appearance: terminalAppearanceSchema.default(DEFAULT_TERMINAL_APPEARANCE),
    behavior: terminalBehaviorSchema.default(DEFAULT_TERMINAL_BEHAVIOR),
    recording: terminalRecordingSchema.optional(),
    transfer: terminalTransferStateSchema.optional(),
    exitCode: z.number().int().nullable().optional(),
    createdAt: timestampSchema,
  })
  .strict();
export const createTerminalSchema = z
  .object({
    kind: z.enum(['local', 'ssh', 'telnet', 'serial']),
    connectionId: idSchema.optional(),
    bookmarkId: idSchema.optional(),
    profileId: idSchema.optional(),
    environment: z
      .record(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        z
          .string()
          .max(4_096)
          .refine((value) => !/[\r\n\0]/.test(value)),
      )
      .refine(
        (value) => Object.keys(value).length <= 64,
        'At most 64 environment values are allowed',
      )
      .optional(),
    workingDirectory: z
      .discriminatedUnion('scope', [
        z
          .object({
            scope: z.literal('local'),
            grantId: z.string().min(1).max(256),
            path: z
              .string()
              .max(4_096)
              .refine(
                (value) =>
                  !value.startsWith('/') &&
                  !value.startsWith('\\') &&
                  !value.includes('\\') &&
                  !value.includes('\0') &&
                  value
                    .split('/')
                    .every((segment) => segment !== '.' && segment !== '..' && !!segment),
                'Expected a portable path relative to the granted directory',
              )
              .or(z.literal('')),
          })
          .strict(),
        z
          .object({
            scope: z.literal('remote'),
            path: z
              .string()
              .min(1)
              .max(4_096)
              .refine((value) => value.startsWith('/'), 'Remote path must be absolute'),
          })
          .strict(),
      ])
      .optional(),
    cols: z.number().int().min(2).max(500).default(80),
    rows: z.number().int().min(2).max(300).default(24),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'ssh' && !value.connectionId)
      context.addIssue({ code: 'custom', message: 'SSH terminals require a connectionId' });
    if ((value.kind === 'telnet' || value.kind === 'serial') && !value.bookmarkId)
      context.addIssue({
        code: 'custom',
        message: `${value.kind} terminals require a bookmarkId`,
      });
    if (value.kind !== 'ssh' && value.connectionId)
      context.addIssue({ code: 'custom', message: 'Only SSH terminals use a connectionId' });
    if (value.kind !== 'ssh' && value.environment)
      context.addIssue({
        code: 'custom',
        message: 'Only SSH terminals accept command-line environment values',
        path: ['environment'],
      });
    if (
      value.kind !== 'ssh' &&
      value.kind !== 'telnet' &&
      value.kind !== 'serial' &&
      value.bookmarkId
    )
      context.addIssue({
        code: 'custom',
        message: 'Only SSH, Telnet or Serial terminals use a bookmarkId',
      });
    if (
      value.workingDirectory &&
      value.workingDirectory.scope !==
        (value.kind === 'local' ? 'local' : value.kind === 'ssh' ? 'remote' : undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'Terminal kind and working-directory scope must match',
        path: ['workingDirectory', 'scope'],
      });
  });
export const TERMINAL_INPUT_FRAME_MAX_BYTES = 64 * 1024;
export const TERMINAL_REPLAY_MAX_BYTES = 128 * 1024;
export const TERMINAL_CLIENT_PROTOCOL_PREFIX = 'terminal-client.';
export const TERMINAL_OUTPUT_FLOW_PROTOCOL = 'terminal-flow.v1';
export const TERMINAL_OUTPUT_FRAME_MAX_BYTES = 64 * 1024;
export const TERMINAL_OUTPUT_HIGH_WATER_BYTES = 256 * 1024;
export const TERMINAL_OUTPUT_LOW_WATER_BYTES = 64 * 1024;
export const TERMINAL_OUTPUT_PENDING_MAX_BYTES = 512 * 1024;
export const TERMINAL_OUTPUT_PENDING_MAX_FRAMES = 8_192;
export const terminalOutputFlowSchema = z
  .object({
    streamId: idSchema,
    highWaterBytes: z.literal(TERMINAL_OUTPUT_HIGH_WATER_BYTES),
    lowWaterBytes: z.literal(TERMINAL_OUTPUT_LOW_WATER_BYTES),
    maxPendingBytes: z.literal(TERMINAL_OUTPUT_PENDING_MAX_BYTES),
    maxFrameBytes: z.literal(TERMINAL_OUTPUT_FRAME_MAX_BYTES),
  })
  .strict();
export type TerminalOutputFlow = z.infer<typeof terminalOutputFlowSchema>;
export const terminalControlSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('outputConsumed'),
      streamId: idSchema,
      consumedBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      type: z.literal('resize'),
      cols: z.number().int().min(2).max(500),
      rows: z.number().int().min(2).max(300),
    })
    .strict(),
  z.object({ type: z.literal('signal'), signal: z.enum(['SIGINT', 'SIGTERM', 'SIGHUP']) }).strict(),
  z.object({ type: z.literal('ping'), nonce: z.string().max(128) }).strict(),
  z.object({ type: z.literal('close') }).strict(),
]);
export const terminalServerControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), outputFlow: terminalOutputFlowSchema.optional() }).strict(),
  z
    .object({
      type: z.literal('status'),
      state: z.enum(['opening', 'ready', 'closed', 'failed', 'reconnecting', 'stale']),
    })
    .strict(),
  z
    .object({
      type: z.literal('replay'),
      firstSequence: z.number().int().positive().optional(),
      lastSequence: z.number().int().nonnegative(),
      byteLength: z.number().int().nonnegative().max(TERMINAL_REPLAY_MAX_BYTES),
      truncated: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal('exit'), exitCode: z.number().int().nullable() }).strict(),
  z
    .object({
      type: z.literal('error'),
      code: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(/^[A-Z][A-Z0-9_]*$/),
    })
    .strict(),
  z.object({ type: z.literal('pong'), nonce: z.string().max(128) }).strict(),
  z
    .object({
      type: z.literal('shellIntegration'),
      state: z.enum(['pending', 'active', 'unavailable']),
    })
    .strict(),
  z.object({ type: z.literal('recording'), recording: terminalRecordingSchema }).strict(),
  z.object({ type: z.literal('transfer'), transfer: terminalTransferStateSchema }).strict(),
]);
export type TerminalAppearance = z.infer<typeof terminalAppearanceSchema>;
export type TerminalBehavior = z.infer<typeof terminalBehaviorSchema>;
export type TerminalRecording = z.infer<typeof terminalRecordingSchema>;
export type TerminalSession = z.infer<typeof terminalSessionSchema>;
export type TerminalServerControl = z.infer<typeof terminalServerControlSchema>;
export type CreateTerminalInput = z.infer<typeof createTerminalSchema>;
export type TerminalCommandOutcome =
  | { readonly status: 'accepted'; readonly id: string }
  | { readonly status: 'missing' | 'pending' | 'uncertain' | 'expired' };
export interface TerminalBaseline {
  readonly type: 'baseline';
  readonly generation: string;
  readonly revision: number;
  readonly sessions: readonly TerminalSession[];
}
export type TerminalDelta =
  | { readonly type: 'upsert'; readonly revision: number; readonly session: TerminalSession }
  | { readonly type: 'remove'; readonly revision: number; readonly id: string };
export type TerminalUpdate = TerminalBaseline | TerminalDelta;
export type TerminalFailureReason =
  | 'not-found'
  | 'forbidden'
  | 'stale'
  | 'invalid-input'
  | 'unavailable'
  | 'capacity'
  | 'closed'
  | 'cancelled'
  | 'internal'
  | 'precondition-required'
  | 'precondition-failed'
  | 'conflict'
  | 'receipt-expired';
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'terminals/failure': { readonly reason: TerminalFailureReason };
  }
}
export const TERMINAL_STREAM_PATH = '/streams/terminals';
import type { TypertResource } from './types.ts';
declare module './index.ts' {
  interface TypertResourceMap {
    terminal: TypertResource<string>;
  }
}

export {
  terminalProfileSchema,
  terminalProfileInputSchema,
  terminalProfilePatchSchema,
  DEFAULT_TERMINAL_THEME_ID,
  LIGHT_TERMINAL_THEME_ID,
} from './schemas/resources.ts';
export type {
  TerminalProfile,
  TerminalProfileInput,
  TerminalProfilePatch,
} from './schemas/resources.ts';
export * from './schemas/terminal-themes.ts';
export * from './schemas/command-history.ts';
/** Generated Remote carries a number; coercion belongs to the owner's query parser. */
export interface CommandHistoryQuery {
  readonly sort?: 'recent' | 'frequency';
  readonly search?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
import { terminalProfileSchema, type TerminalProfile } from './schemas/resources.ts';
import { terminalThemeSchema, type TerminalTheme } from './schemas/terminal-themes.ts';
import { commandHistoryPageSchema, type CommandHistoryPage } from './schemas/command-history.ts';
export const terminalFactsContentSchema = z
  .object({
    profiles: terminalProfileSchema.array(),
    themes: terminalThemeSchema.array(),
    history: commandHistoryPageSchema,
  })
  .strict();
export type TerminalFactsContent = z.infer<typeof terminalFactsContentSchema>;
export interface TerminalFactsBaseline {
  readonly generation: string;
  readonly cursor: number;
  readonly profiles: readonly TerminalProfile[];
  readonly themes: readonly TerminalTheme[];
  readonly history: CommandHistoryPage;
}
export interface TerminalFactsReceipt {
  readonly ids: readonly string[];
  readonly version?: number;
  readonly cursor: number;
}
export const TERMINAL_FACTS_CHUNK_CHARACTERS = 16_384;
export const TERMINAL_FACTS_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export type TerminalFactsUpdate =
  | {
      readonly type: 'begin';
      readonly mode: 'baseline' | 'replace';
      readonly generation: string;
      readonly cursor: number;
    }
  | {
      readonly type: 'chunk';
      readonly offset: number;
      readonly text: string;
      readonly final: boolean;
    }
  | { readonly type: 'commit'; readonly cursor: number };
declare module './index.ts' {
  interface TypertResourceMap {
    terminalProfile: TypertResource<string>;
    terminalTheme: TypertResource<string>;
    commandHistory: TypertResource<string>;
  }
}

export { DEFAULT_TERMINAL_APPEARANCE, DEFAULT_TERMINAL_TYPE } from './schemas/resources.ts';

/** Readonly selected preference facts; only the terminal owner updates or persists them. */
export type TerminalFactsView = ClientFactsView<TerminalFactsBaseline>;
declare module '@deepseek-ai/cordis' {
  interface Context {
    terminalFactsView: TerminalFactsView;
  }
}

/** Selected session facts; renderer byte objects are never exposed. */
export type TerminalSessionsView = ClientFactsView<TerminalBaseline>;
declare module '@deepseek-ai/cordis' {
  interface Context {
    terminalSessionsView: TerminalSessionsView;
  }
}

/** Private image bytes stay in storage/streaming HTTP; Client facts carry metadata only. */
export const TERMINAL_ASSET_MAX_BYTES = 16 * 1024 * 1024;
export const TERMINAL_ASSETS_MAX_COUNT = 256;
export const TERMINAL_ASSETS_CHUNK_CHARACTERS = 16384;
export const TERMINAL_ASSETS_MAX_SNAPSHOT_BYTES = 256 * 1024;
export const terminalBackgroundMetadataSchema = terminalBackgroundAssetSchema
  .extend({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    version: z.number().int().positive(),
    createdAt: timestampSchema,
  })
  .strict();
export type TerminalBackgroundMetadata = z.infer<typeof terminalBackgroundMetadataSchema>;
export const terminalAssetsContentSchema = z
  .object({ assets: terminalBackgroundMetadataSchema.array().max(TERMINAL_ASSETS_MAX_COUNT) })
  .strict();
export type TerminalAssetsContent = z.infer<typeof terminalAssetsContentSchema>;
export interface TerminalAssetsBaseline extends TerminalAssetsContent {
  readonly generation: string;
  readonly cursor: number;
}
export type TerminalAssetsUpdate = TerminalFactsUpdate;
export interface TerminalAssetReceipt {
  readonly asset: TerminalBackgroundMetadata;
  readonly cursor: number;
}
export interface TerminalAssetDeleteReceipt {
  readonly id: string;
  readonly cursor: number;
}
declare module './index.ts' {
  interface TypertResourceMap {
    terminalBackgroundAsset: TypertResource<string>;
  }
}

export const zAssetVersionSchema = z.number().int().positive();

export interface TerminalBackgroundContentDescriptor {
  readonly asset: TerminalBackgroundMetadata;
  readonly href: string;
}

export {
  DEFAULT_TERMINAL_BACKGROUND,
  terminalBackgroundSchema,
  terminalVisualSettingsSchema,
} from './schemas/terminal-visual.ts';
export type { TerminalBackground, TerminalVisualSettings } from './schemas/terminal-visual.ts';

export {
  DEFAULT_TERMINAL_SHORTCUT_BUTTONS,
  terminalShortcutButtonSchema,
  terminalShortcutButtonsSchema,
} from './schemas/resources.ts';
export type { TerminalShortcutButton } from './schemas/resources.ts';

/** Retained first-party bounded terminal information contract. */
export const terminalInformationGroupNameSchema = z.enum([
  'sysinfo',
  'cpu',
  'memory',
  'uptime',
  'users',
  'network',
  'disks',
  'activities',
]);
export const terminalInformationGroupStateSchema = z.enum([
  'ready',
  'stale',
  'unsupported',
  'error',
]);
const terminalInformationGroupSchema = <T extends z.ZodType>(data: T) =>
  z
    .object({
      state: terminalInformationGroupStateSchema,
      updatedAt: timestampSchema.nullable(),
      errorCode: z.string().max(64).nullable(),
      data: data.nullable(),
    })
    .strict();
export const terminalSystemInformationSchema = z
  .object({
    os: z.string().max(256),
    hostname: z.string().max(255),
    kernel: z.string().max(256),
    arch: z.string().max(64),
    shell: z.string().max(128),
  })
  .strict();
export const terminalMemoryInformationSchema = z
  .object({
    totalBytes: z.number().nonnegative(),
    availableBytes: z.number().nonnegative(),
    usedBytes: z.number().nonnegative(),
    swapTotalBytes: z.number().nonnegative().nullable(),
    swapUsedBytes: z.number().nonnegative().nullable(),
    percent: z.number().min(0).max(100),
  })
  .strict();
export const terminalUptimeInformationSchema = z
  .object({ seconds: z.number().nonnegative(), bootTime: timestampSchema.nullable() })
  .strict();
export const terminalNetworkInterfaceSchema = z
  .object({
    name: z.string().max(128),
    state: z.string().max(32).nullable(),
    ipv4: z.string().max(64).nullable(),
    receivedBytes: z.number().int().nonnegative().nullable(),
    transmittedBytes: z.number().int().nonnegative().nullable(),
    receiveRate: z.number().nonnegative().nullable(),
    transmitRate: z.number().nonnegative().nullable(),
  })
  .strict();
export const terminalNetworkInformationSchema = z
  .object({
    defaultInterface: z.string().max(128).nullable(),
    interfaces: z.array(terminalNetworkInterfaceSchema).max(32),
  })
  .strict();
export const terminalUserSessionSchema = z
  .object({
    username: z.string().max(128),
    terminal: z.string().max(128),
    startedAt: z.string().max(128),
    source: z.string().max(255).nullable(),
  })
  .strict();
export const terminalUsersInformationSchema = z
  .object({
    users: z.array(z.string().max(128)).max(64),
    sessions: z.array(terminalUserSessionSchema).max(64),
  })
  .strict();
export const terminalDiskInformationSchema = z
  .object({
    filesystem: z.string().max(255),
    totalBytes: z.number().int().nonnegative(),
    usedBytes: z.number().int().nonnegative(),
    availableBytes: z.number().int().nonnegative(),
    percent: z.number().min(0).max(100),
    mount: z.string().max(4_096),
  })
  .strict();
export const terminalActivityInformationSchema = z
  .object({
    pid: z.number().int().positive(),
    username: z.string().max(128),
    cpuPercent: z.number().nonnegative(),
    memoryBytes: z.number().int().nonnegative(),
    command: z.string().max(256),
  })
  .strict();
export const terminalInformationSnapshotSchema = z
  .object({
    terminalId: idSchema,
    kind: terminalSessionSchema.shape.kind,
    sampledAt: timestampSchema,
    cpuHistory: z
      .array(z.object({ sampledAt: timestampSchema, percent: z.number().min(0).max(100) }).strict())
      .max(60),
    groups: z
      .object({
        sysinfo: terminalInformationGroupSchema(terminalSystemInformationSchema),
        cpu: terminalInformationGroupSchema(z.number().min(0).max(100)),
        memory: terminalInformationGroupSchema(terminalMemoryInformationSchema),
        uptime: terminalInformationGroupSchema(terminalUptimeInformationSchema),
        users: terminalInformationGroupSchema(terminalUsersInformationSchema),
        network: terminalInformationGroupSchema(terminalNetworkInformationSchema),
        disks: terminalInformationGroupSchema(z.array(terminalDiskInformationSchema).max(64)),
        activities: terminalInformationGroupSchema(
          z.array(terminalActivityInformationSchema).max(50),
        ),
      })
      .strict(),
  })
  .strict();

export type TerminalInformationGroupName = z.infer<typeof terminalInformationGroupNameSchema>;
export type TerminalInformationSnapshot = z.infer<typeof terminalInformationSnapshotSchema>;
export const DEFAULT_TERMINAL_INFORMATION_ITEMS = [
  'sysinfo',
  'uptime',
  'cpu',
  'memory',
  'activities',
  'network',
  'disks',
] as const;
export interface TerminalInformationBaseline {
  readonly type: 'baseline';
  readonly generation: string;
  readonly revision: number;
  readonly snapshot: TerminalInformationSnapshot;
}

export const startTerminalRecordingSchema = z
  .object({
    grantId: z.string().min(1).max(256),
    timestamps: z.boolean(),
    includeRecent: z.boolean(),
  })
  .strict();
export type StartTerminalRecordingInput = z.infer<typeof startTerminalRecordingSchema>;

export type RemoteMonitorItem =
  | 'hostname'
  | 'cpu'
  | 'cpuHistory'
  | 'memory'
  | 'upload'
  | 'download'
  | 'uptime'
  | 'users'
  | 'disks';

export const DEFAULT_REMOTE_MONITOR_ITEMS = [
  'hostname',
  'cpu',
  'cpuHistory',
  'memory',
  'upload',
  'download',
  'uptime',
  'users',
  'disks',
] as const;
