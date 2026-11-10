import {
  externalHttpUrlSchema,
  desktopLifecycleStateSchema,
  updaterStatusSchema,
  updaterActionSchema,
  desktopWindowPreferenceRecordSchema,
  nativeDesktopWindowStateSchema,
} from '@axterm/plugin-api/desktop';
import {
  nativeWebViewCreateSchema,
  nativeWebViewStateSchema,
  nativeWebViewPresentationSchema,
  nativeWebViewActionSchema,
  nativeWebViewAuthResponseSchema,
} from '@axterm/plugin-api/remote-desktop';
import { desktopLaunchSchema } from '@axterm/plugin-api/session-intents';
import { z } from 'zod';
import { credentialMutationMarkerSchema } from '@axterm/plugin-api/saved-credentials';
import { vaultAddressSchema, vaultMetadataSchema } from '@axterm/infra-credential-vault';
import {
  fileGrantRequestSchema,
  fileGrantSchema,
  managedFileImportSchema,
  grantedDirectoryPathSchema,
} from '@axterm/plugin-api/files';
import { fileAuthoritySchema } from '@axterm/plugin-api/host';
const empty = z.object({}).strict();
const ref = z.string().regex(/^cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const secret = z
  .string()
  .min(1)
  .max(4 * 1024 * 1024);
const leaseId = z.uuid();
/** This is a closed native capability table, never arbitrary service/method dispatch. */
export const nativeCapabilities = {
  'desktop.lifecycle': { input: empty, output: desktopLifecycleStateSchema },
  'updater.status': { input: empty, output: updaterStatusSchema },
  'updater.perform': {
    input: z.object({ key: z.uuid(), action: updaterActionSchema.shape.action }).strict(),
    output: updaterStatusSchema,
    maxTimeoutMs: 30 * 60_000 + 5_000,
  },
  'updater.drain': {
    input: z.object({ key: z.uuid() }).strict(),
    output: z.literal(true),
    maxTimeoutMs: 30 * 60_000 + 5_000,
  },
  'window.configure': {
    input: z
      .object({ record: desktopWindowPreferenceRecordSchema, applyBounds: z.boolean() })
      .strict(),
    output: nativeDesktopWindowStateSchema,
  },
  'window.state': { input: empty, output: nativeDesktopWindowStateSchema },
  'externalUrl.open': {
    input: z.object({ key: z.uuid(), url: externalHttpUrlSchema }).strict(),
    output: z.literal(true),
  },
  'externalUrl.drain': { input: z.object({ key: z.uuid() }).strict(), output: z.literal(true) },
  'webView.create': { input: nativeWebViewCreateSchema, output: nativeWebViewStateSchema },
  'webView.state': {
    input: z.object({ windowId: z.uuid(), id: z.uuid() }).strict(),
    output: nativeWebViewStateSchema,
  },
  'webView.present': {
    input: z
      .object({ windowId: z.uuid(), id: z.uuid(), presentation: nativeWebViewPresentationSchema })
      .strict(),
    output: nativeWebViewStateSchema,
  },
  'webView.action': {
    input: z
      .object({ windowId: z.uuid(), id: z.uuid(), action: nativeWebViewActionSchema })
      .strict(),
    output: nativeWebViewStateSchema,
  },
  'webView.authenticate': {
    input: z
      .object({ windowId: z.uuid(), id: z.uuid(), response: nativeWebViewAuthResponseSchema })
      .strict(),
    output: nativeWebViewStateSchema,
  },
  'webView.close': {
    input: z.object({ windowId: z.uuid(), id: z.uuid() }).strict(),
    output: z.literal(true),
  },
  'desktopLaunch.next': {
    input: z.object({ windowId: z.uuid() }).strict(),
    output: desktopLaunchSchema.nullable(),
  },
  'fileGrant.import.prepare': { input: managedFileImportSchema, output: fileGrantSchema },
  'fileGrant.import.commit': {
    input: z.object({ id: z.string().min(1).max(256) }).strict(),
    output: fileGrantSchema,
  },
  'fileGrant.import.discard': {
    input: z.object({ id: z.string().min(1).max(256) }).strict(),
    output: z.literal(true),
  },
  'fileGrant.open': {
    input: z
      .object({
        key: z.uuid(),
        grantId: z.string().min(1).max(256),
        path: grantedDirectoryPathSchema,
      })
      .strict(),
    output: z.literal(true),
  },
  'fileGrant.reveal': {
    input: z
      .object({
        key: z.uuid(),
        grantId: z.string().min(1).max(256),
        path: grantedDirectoryPathSchema,
      })
      .strict(),
    output: z.literal(true),
  },
  'fileGrant.application.drain': {
    input: z.object({ key: z.uuid() }).strict(),
    output: z.literal(true),
  },
  'fileGrant.create': {
    input: fileGrantRequestSchema,
    output: fileGrantSchema.nullable(),
    maxTimeoutMs: 300_000,
  },
  'fileGrant.list': {
    input: z
      .object({
        offset: z.number().int().min(0).max(16384).default(0),
        limit: z.number().int().min(1).max(256).default(256),
        revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .strict(),
    output: z
      .object({
        revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        items: fileGrantSchema.array().max(256),
        nextOffset: z.number().int().nonnegative().nullable(),
      })
      .strict(),
  },
  'fileGrant.authorize': {
    input: z
      .object({ grantId: z.string().min(1).max(256), permission: z.enum(['read', 'write']) })
      .strict(),
    output: fileAuthoritySchema,
  },
  'fileGrant.revoke': {
    input: z.object({ grantId: z.string().min(1).max(256) }).strict(),
    output: z.literal(true),
  },
  'vault.ready': { input: empty, output: z.literal(true) },
  'vault.list': { input: empty, output: z.array(vaultMetadataSchema).max(100_000) },
  'vault.get': { input: z.object({ ref }).strict(), output: secret },
  'vault.put': {
    input: z.object({ kind: z.string().max(4096), label: z.string().max(4096), secret }).strict(),
    output: vaultMetadataSchema,
  },
  'vault.replace': { input: z.object({ ref, secret }).strict(), output: vaultMetadataSchema },
  'vault.createAt': {
    input: z
      .object({
        ref,
        kind: z.string().max(4096),
        label: z.string().max(4096),
        secret,
        mutation: credentialMutationMarkerSchema,
      })
      .strict(),
    output: vaultMetadataSchema,
  },
  'vault.replaceManaged': {
    input: z.object({ ref, secret, mutation: credentialMutationMarkerSchema }).strict(),
    output: vaultMetadataSchema,
  },
  'vault.delete': { input: z.object({ ref }).strict(), output: z.literal(true) },
  'vault.deleteManaged': {
    input: z.object({ ref, expected: credentialMutationMarkerSchema }).strict(),
    output: z.enum(['deleted', 'missing', 'changed']),
  },
  'vault.address.read': {
    input: z.object({ address: vaultAddressSchema }).strict(),
    output: z.object({ value: secret.optional() }).strict(),
  },
  'vault.address.list': {
    input: z.object({ space: z.enum(['reference', 'record']) }).strict(),
    output: z.array(vaultAddressSchema).max(100_000),
  },
  'vault.address.delete': {
    input: z.object({ address: vaultAddressSchema }).strict(),
    output: z.boolean(),
  },
  'vault.address.acquire': {
    input: z.object({ address: vaultAddressSchema }).strict(),
    output: z.object({ leaseId, value: secret.optional() }).strict(),
  },
  'vault.address.commit': {
    input: z.object({ leaseId, value: secret }).strict(),
    output: z.literal(true),
  },
  'vault.address.release': { input: z.object({ leaseId }).strict(), output: z.literal(true) },
} as const;
export type NativeMethod = keyof typeof nativeCapabilities;
export type NativeInput<K extends NativeMethod> = z.infer<(typeof nativeCapabilities)[K]['input']>;
export type NativeOutput<K extends NativeMethod> = z.infer<
  (typeof nativeCapabilities)[K]['output']
>;
export type NativeHandlers = {
  [K in NativeMethod]: (
    input: NativeInput<K>,
    signal: AbortSignal,
  ) => NativeOutput<K> | Promise<NativeOutput<K>>;
};
export const nativeErrorCodes = [
  'CLOSED',
  'INVALID',
  'CORRUPT',
  'KEY_MISSING',
  'NOT_FOUND',
  'CONFLICT',
  'IO',
  'MUTATION_FAILED',
  'PROTOCOL',
  'FAILED',
  'LIMIT',
  'TIMEOUT',
  'CANCELLED',
  'LEASE_EXPIRED',
  'FORBIDDEN',
  'STALE',
  'UNAVAILABLE',
] as const;
export type NativeErrorCode = (typeof nativeErrorCodes)[number];
export class NativeError extends Error {
  readonly code: NativeErrorCode;
  constructor(code: NativeErrorCode) {
    super(`DESKTOP_NATIVE_${code}`);
    this.name = 'NativeError';
    this.code = code;
  }
}
const audience = {
  kind: z.literal('axterm-native'),
  version: z.literal(1),
  generation: z.uuid(),
  id: z.uuid(),
};
export const nativeFrameSchema = z.discriminatedUnion('type', [
  z.object({ ...audience, type: z.literal('closed') }).strict(),
  z
    .object({
      ...audience,
      type: z.literal('request'),
      method: z.enum(Object.keys(nativeCapabilities) as [NativeMethod, ...NativeMethod[]]),
      input: z.unknown(),
    })
    .strict(),
  z.object({ ...audience, type: z.literal('cancel') }).strict(),
  z.object({ ...audience, type: z.literal('result'), value: z.unknown() }).strict(),
  z.object({ ...audience, type: z.literal('error'), code: z.enum(nativeErrorCodes) }).strict(),
]);
export type NativeFrame = z.infer<typeof nativeFrameSchema>;
export const MAX_NATIVE_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_NATIVE_REQUESTS = 32;
export const NATIVE_REQUEST_TIMEOUT_MS = 30_000;
export function parseNativeFrame(value: unknown): NativeFrame {
  try {
    const text = JSON.stringify(value);
    if (!text || Buffer.byteLength(text) > MAX_NATIVE_FRAME_BYTES)
      throw new NativeError('PROTOCOL');
    return nativeFrameSchema.parse(JSON.parse(text));
  } catch {
    throw new NativeError('PROTOCOL');
  }
}
export function isNativeFrame(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'axterm-native'
  );
}
