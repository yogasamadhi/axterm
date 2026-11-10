import type { TypertResource } from './types.ts';
import { z } from 'zod';
import { idSchema, timestampSchema } from './catalog.ts';
export const rdpSessionSchema = z
  .object({
    id: idSchema,
    bookmarkId: idSchema,
    title: z.string().min(1).max(100),
    state: z.enum(['created', 'attached', 'ready', 'closed', 'failed']),
    width: z.number().int().min(320).max(8_192),
    height: z.number().int().min(240).max(4_320),
    scaleViewport: z.boolean(),
    clipboard: z.boolean(),
    errorCode: z.string().max(100).optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const createRdpSessionSchema = z
  .object({
    bookmarkId: idSchema,
    width: z.number().int().min(320).max(8_192).optional(),
    height: z.number().int().min(240).max(4_320).optional(),
    temporaryPassword: z.string().max(16_384).optional(),
  })
  .strict();
export const rdpCredentialBootstrapSchema = z
  .object({
    username: z.string().min(1).max(128),
    password: z.string().max(16_384),
    domain: z.string().max(128),
    destination: z.string().min(1).max(320),
  })
  .strict();
export const resizeRdpSessionSchema = z
  .object({
    width: z.number().int().min(320).max(8_192),
    height: z.number().int().min(240).max(4_320),
  })
  .strict();
export const RDP_FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const vncSessionSchema = z
  .object({
    id: idSchema,
    bookmarkId: idSchema,
    title: z.string().min(1).max(100),
    state: z.enum(['created', 'connecting', 'ready', 'closed', 'failed']),
    viewOnly: z.boolean(),
    clipViewport: z.boolean(),
    scaleViewport: z.boolean(),
    qualityLevel: z.number().int().min(0).max(9),
    compressionLevel: z.number().int().min(0).max(9),
    shared: z.boolean(),
    showDotCursor: z.boolean(),
    clipboard: z.boolean(),
    errorCode: z.string().max(100).optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const createVncSessionSchema = z
  .object({
    bookmarkId: idSchema,
    temporaryPassword: z.string().max(16_384).optional(),
  })
  .strict();
export const vncCredentialBootstrapSchema = z
  .object({
    username: z.string().max(128),
    password: z.string().max(16_384),
  })
  .strict();
export const VNC_FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const spiceSessionSchema = z
  .object({
    id: idSchema,
    bookmarkId: idSchema,
    title: z.string().min(1).max(100),
    state: z.enum(['created', 'connecting', 'ready', 'closed', 'failed']),
    viewOnly: z.boolean(),
    scaleViewport: z.boolean(),
    activeChannels: z.number().int().nonnegative().max(16),
    errorCode: z.string().max(100).optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export const createSpiceSessionSchema = z
  .object({
    bookmarkId: idSchema,
    temporaryPassword: z.string().max(16_384).optional(),
  })
  .strict();
export const spiceCredentialBootstrapSchema = z
  .object({ password: z.string().max(16_384) })
  .strict();
export const SPICE_FRAME_MAX_BYTES = 4 * 1024 * 1024;

export const remoteDesktopProtocolSchema = z.enum(['rdp', 'vnc', 'spice']);
export type RemoteDesktopProtocol = z.infer<typeof remoteDesktopProtocolSchema>;
export type RdpSession = z.infer<typeof rdpSessionSchema>;
export type VncSession = z.infer<typeof vncSessionSchema>;
export type SpiceSession = z.infer<typeof spiceSessionSchema>;
export const remoteDesktopSessionSchema = z.discriminatedUnion('protocol', [
  rdpSessionSchema.extend({ protocol: z.literal('rdp') }),
  vncSessionSchema.extend({ protocol: z.literal('vnc') }),
  spiceSessionSchema.extend({ protocol: z.literal('spice') }),
]);
export type RemoteDesktopSession = z.infer<typeof remoteDesktopSessionSchema>;
export const createRemoteDesktopSessionSchema = z.discriminatedUnion('protocol', [
  createRdpSessionSchema.extend({ protocol: z.literal('rdp') }),
  createVncSessionSchema.extend({ protocol: z.literal('vnc') }),
  createSpiceSessionSchema.extend({ protocol: z.literal('spice') }),
]);
export type CreateRemoteDesktopSession = z.infer<typeof createRemoteDesktopSessionSchema>;
export const remoteDesktopCredentialsSchema = z
  .object({
    username: z.string().max(128),
    password: z.string().max(16384),
    domain: z.string().max(128),
    destination: z.string().min(1).max(320),
  })
  .strict();
export type RemoteDesktopCredentials = z.infer<typeof remoteDesktopCredentialsSchema>;
export const REMOTE_DESKTOP_CREDENTIAL_PATH = '/remote-desktop/credentials';
export const remoteDesktopBaselineSchema = z
  .object({
    type: z.literal('baseline'),
    generation: z.uuid(),
    revision: z.number().int().nonnegative(),
    sessions: z.array(remoteDesktopSessionSchema).max(24),
  })
  .strict();
export const remoteDesktopDeltaSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('upsert'),
      generation: z.uuid(),
      revision: z.number().int().positive(),
      session: remoteDesktopSessionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('remove'),
      generation: z.uuid(),
      revision: z.number().int().positive(),
      id: z.uuid(),
    })
    .strict(),
]);
export interface RemoteDesktopBaseline {
  readonly type: 'baseline';
  readonly generation: string;
  readonly revision: number;
  readonly sessions: readonly RemoteDesktopSession[];
}
export type RemoteDesktopDelta = z.infer<typeof remoteDesktopDeltaSchema>;
export type RemoteDesktopUpdate = RemoteDesktopBaseline | RemoteDesktopDelta;
export const REMOTE_DESKTOP_STREAM_PATH = '/remote-desktop/stream';
declare module './index.ts' {
  interface TypertResourceMap {
    remoteDesktopSession: TypertResource<string>;
  }
}
declare module './types.ts' {
  interface RemoteErrorDetailsMap {
    'remoteDesktop/failure': {
      reason:
        | 'closed'
        | 'invalid-input'
        | 'not-found'
        | 'capacity'
        | 'conflict'
        | 'receipt-expired'
        | 'unavailable';
    };
  }
}

/** Exact non-secret outcome of one generation-owned session admission. */
export type RemoteDesktopCommandOutcome =
  | { readonly status: 'accepted'; readonly id: string }
  | { readonly status: 'missing' | 'pending' | 'expired' | 'uncertain' | 'rejected' };

export interface RemoteDesktopProtocolAssets {
  readonly novnc: string;
}

export * from './native-web.ts';
import { nativeWebViewStateSchema, nativeWebUrlSchema } from './native-web.ts';
export const createWebSessionSchema = z
  .object({ bookmarkId: z.uuid(), windowId: z.uuid() })
  .strict();
export type CreateWebSession = z.infer<typeof createWebSessionSchema>;
export const webSessionSchema = nativeWebViewStateSchema
  .extend({
    windowId: z.uuid(),
    bookmarkId: z.uuid(),
    title: z.string().min(1).max(100),
    description: z.string().max(4096),
    currentUrl: nativeWebUrlSchema,
    userAgent: z.string().max(512).nullable(),
    hideAddressBar: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type WebSession = z.infer<typeof webSessionSchema>;
export const webSessionBaselineSchema = z
  .object({
    type: z.literal('baseline'),
    generation: z.uuid(),
    revision: z.number().int().nonnegative(),
    sessions: z.array(webSessionSchema).max(8),
  })
  .strict();
export const webSessionDeltaSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('upsert'),
      generation: z.uuid(),
      revision: z.number().int().positive(),
      session: webSessionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('remove'),
      generation: z.uuid(),
      revision: z.number().int().positive(),
      id: z.uuid(),
    })
    .strict(),
]);
export interface WebSessionBaseline {
  readonly type: 'baseline';
  readonly generation: string;
  readonly revision: number;
  readonly sessions: readonly WebSession[];
}
export type WebSessionDelta = z.infer<typeof webSessionDeltaSchema>;
export type WebSessionUpdate = WebSessionBaseline | WebSessionDelta;
