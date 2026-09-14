import { z } from 'zod';

export const loopbackUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    Number(url.port) > 0 &&
    url.pathname === '/' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}, 'Expected a loopback HTTP origin with an assigned port');

export const desktopBootstrapSchema = z
  .object({
    baseUrl: loopbackUrlSchema,
    apiVersion: z.literal('v1'),
    runtimeId: z.uuid(),
    generation: z.uuid(),
    bootstrapToken: z.string().min(32).max(256),
    appVersion: z.string(),
  })
  .strict();
export type DesktopBootstrap = z.infer<typeof desktopBootstrapSchema>;
export interface DesktopBootstrapApi {
  resolve(): Promise<DesktopBootstrap>;
}

// Supervision only. No business operations or generic RPC payloads.
export const startupSchema = z
  .object({
    type: z.literal('startup'),
    generation: z.uuid(),
    appVersion: z.string(),
    devOrigin: loopbackUrlSchema.optional(),
    rendererDirectory: z.string().min(1).optional(),
    dataDirectory: z.string().min(1).optional(),
    hostCapabilityUrl: loopbackUrlSchema.optional(),
    hostCapabilityToken: z.string().min(32).max(256).optional(),
    runtimeIngressToken: z.string().min(32).max(256).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (!!value.hostCapabilityUrl && !!value.hostCapabilityToken) ||
      (!value.hostCapabilityUrl && !value.hostCapabilityToken),
    'Host capability URL and token must be provided together',
  );
export const parentEnvelopeSchema = z.discriminatedUnion('type', [
  startupSchema,
  z.object({ type: z.literal('shutdown') }).strict(),
]);
export const childEnvelopeSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('ready'),
      bootstrap: desktopBootstrapSchema,
      pid: z.number().int().positive(),
    })
    .strict(),
  z.object({ type: z.literal('crash'), code: z.literal('STARTUP_FAILED') }).strict(),
]);
export type StartupEnvelope = z.infer<typeof startupSchema>;
export type ParentEnvelope = z.infer<typeof parentEnvelopeSchema>;
export type ChildEnvelope = z.infer<typeof childEnvelopeSchema>;

export const hostCredentialPutSchema = z
  .object({
    kind: z.string().min(1).max(64),
    label: z.string().min(1).max(100),
    secret: z.string().min(1).max(131_072),
  })
  .strict();
export const hostCredentialReplaceSchema = z
  .object({ secret: z.string().min(1).max(131_072) })
  .strict();
export const hostCredentialMetadataSchema = z
  .object({
    ref: z.string().min(1),
    kind: z.string(),
    label: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    storage: z.literal('local'),
  })
  .strict();
export const hostCredentialResolveSchema = z.object({ secret: z.string() }).strict();
export const fileGrantSchema = z
  .object({
    grantId: z.string(),
    kind: z.enum(['file', 'directory', 'save-target']),
    name: z.string(),
    rootPath: z.string().min(1).max(4_096).optional(),
    permissions: z.array(z.enum(['read', 'write'])),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().optional(),
  })
  .strict();
export const resolvedGrantSchema = fileGrantSchema.extend({ path: z.string().min(1) }).strict();
export const localDirectoryGrantRequestSchema = z
  .object({ path: z.string().trim().min(1).max(4_096).optional() })
  .strict();
export const grantedDirectoryPathSchema = z
  .string()
  .max(4_096)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value.split('/').every((segment) => segment !== '.' && segment !== '..' && !!segment),
    'Expected a portable path relative to the granted directory',
  )
  .or(z.literal(''));
export const grantedDirectoryListRequestSchema = z
  .object({ path: grantedDirectoryPathSchema.default('') })
  .strict();
export const grantedEntryNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== '.' &&
      value !== '..' &&
      !value.includes('/') &&
      !value.includes('\\') &&
      !value.includes('\0'),
    'Expected a portable file name',
  );
export const grantedEntryPathSchema = grantedDirectoryPathSchema.refine(
  (value) => value.length > 0,
  'Expected a path to an entry inside the granted directory',
);
export const grantedEntryCreateRequestSchema = z
  .object({
    path: grantedDirectoryPathSchema.default(''),
    name: grantedEntryNameSchema,
    type: z.enum(['file', 'directory']),
  })
  .strict();
export const grantedEntryRenameRequestSchema = z
  .object({ path: grantedEntryPathSchema, name: grantedEntryNameSchema })
  .strict();
export const grantedEntryChmodRequestSchema = z
  .object({ path: grantedEntryPathSchema, mode: z.number().int().min(0).max(0o7777) })
  .strict();
export const grantedEntryPathRequestSchema = z.object({ path: grantedEntryPathSchema }).strict();
export const grantedFileOpenRequestSchema = z
  .object({ editorExecutable: z.string().trim().min(1).max(4_096).optional() })
  .strict();
export const grantedEntryPathsRequestSchema = z
  .object({ paths: z.array(grantedEntryPathSchema).min(1).max(10_000) })
  .strict();
export const grantedEntriesOperationRequestSchema = z
  .object({
    paths: z.array(grantedEntryPathSchema).min(1).max(1_000),
    destination: grantedDirectoryPathSchema,
    operation: z.enum(['copy', 'move']),
    conflict: z.enum(['skip', 'overwrite', 'rename']).default('rename'),
  })
  .strict();
export const grantedTransferPathRequestSchema = z
  .object({
    path: grantedDirectoryPathSchema,
    intent: z.enum(['read', 'write-target']),
  })
  .strict();
export const grantedDirectoryEntrySchema = z
  .object({
    name: z.string().min(1).max(1_024),
    path: grantedDirectoryPathSchema,
    type: z.enum(['file', 'directory', 'symlink', 'other']),
    size: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative().optional(),
    modifiedAt: z.iso.datetime().optional(),
    accessedAt: z.iso.datetime().optional(),
    owner: z.string().optional(),
    group: z.string().optional(),
  })
  .strict();
export const grantedDirectoryListingSchema = z
  .object({
    grantId: z.string().min(1),
    rootName: z.string().min(1),
    path: grantedDirectoryPathSchema,
    entries: z.array(grantedDirectoryEntrySchema).max(10_000),
    truncated: z.boolean(),
  })
  .strict();
export const grantedTextSchema = z
  .object({
    name: z.string().min(1),
    content: z.string().max(2 * 1024 * 1024),
  })
  .strict();
export const externalUrlSchema = z.object({ url: z.url() }).strict();
export const hostWebUrlSchema = z
  .url()
  .max(4_096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Expected a credential-free HTTP(S) URL');
export const hostWebViewBoundsSchema = z
  .object({
    x: z.number().int().min(0).max(32_768),
    y: z.number().int().min(0).max(32_768),
    width: z.number().int().min(1).max(32_768),
    height: z.number().int().min(1).max(32_768),
  })
  .strict();
export const hostWebViewCreateSchema = z
  .object({
    id: z.uuid(),
    url: hostWebUrlSchema,
    userAgent: z.string().trim().min(1).max(512).nullable().default(null),
  })
  .strict();
export const hostWebViewPresentationSchema = z
  .object({
    bounds: hostWebViewBoundsSchema.optional(),
    visible: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Expected a presentation change');
export const hostWebViewActionSchema = z
  .object({
    action: z.enum([
      'back',
      'forward',
      'reload',
      'stop',
      'set-zoom',
      'open-external',
      'open-blocked-external',
    ]),
    zoomFactor: z.number().min(0.25).max(5).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === 'set-zoom' && value.zoomFactor === undefined)
      context.addIssue({
        code: 'custom',
        path: ['zoomFactor'],
        message: 'Zoom factor is required',
      });
    if (value.action !== 'set-zoom' && value.zoomFactor !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['zoomFactor'],
        message: 'Zoom factor is only valid for set-zoom',
      });
  });
export const hostWebViewAuthResponseSchema = z
  .object({
    challengeId: z.uuid(),
    username: z.string().max(1_024),
    password: z.string().max(16_384),
  })
  .strict();
export const hostWebViewStateSchema = z
  .object({
    id: z.uuid(),
    state: z.enum(['created', 'loading', 'ready', 'auth-required', 'failed']),
    url: hostWebUrlSchema,
    title: z.string().max(1_024),
    loading: z.boolean(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    zoomFactor: z.number().min(0.25).max(5),
    visible: z.boolean(),
    blockedUrl: hostWebUrlSchema.optional(),
    errorCode: z.string().max(100).optional(),
    authChallenge: z
      .object({
        id: z.uuid(),
        host: z.string().max(253),
        realm: z.string().max(512).optional(),
        isProxy: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const notificationSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    body: z.string().max(500),
  })
  .strict();
export const updaterStatusSchema = z
  .object({
    state: z.enum(['disabled', 'idle', 'checking', 'available', 'downloading', 'ready', 'error']),
    availableVersion: z.string().optional(),
    progress: z.number().min(0).max(100).optional(),
    errorCode: z.string().optional(),
  })
  .strict();
export const updaterActionSchema = z
  .object({ action: z.enum(['check', 'download', 'cancel', 'install']) })
  .strict();
export const signedUpdateManifestSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    publishedAt: z.iso.datetime(),
    notes: z.string().max(20_000).default(''),
    artifact: z
      .object({
        url: z.url().max(4_096),
        fileName: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .regex(/^[0-9A-Za-z][0-9A-Za-z._+-]*$/),
        size: z
          .number()
          .int()
          .positive()
          .max(4 * 1024 * 1024 * 1024),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        signature: z
          .string()
          .regex(/^[A-Za-z0-9+/]+={0,2}$/)
          .max(512),
      })
      .strict(),
  })
  .strict();
export const desktopLifecycleStateSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    state: z.enum(['active', 'suspended']),
    lastEvent: z.enum(['started', 'suspend', 'resume']),
    changedAt: z.iso.datetime(),
  })
  .strict();
export const desktopWindowStateSchema = z
  .object({
    minimized: z.boolean(),
    maximized: z.boolean(),
    fullScreen: z.boolean(),
    focused: z.boolean(),
    visible: z.boolean(),
    canMinimize: z.boolean(),
    canMaximize: z.boolean(),
    canClose: z.boolean(),
  })
  .strict();
export const desktopWindowActionSchema = z
  .object({ action: z.enum(['minimize', 'toggle-maximize', 'toggle-fullscreen', 'close']) })
  .strict();
export const desktopWindowActionResultSchema = z
  .object({
    accepted: z.literal(true),
    state: desktopWindowStateSchema,
  })
  .strict();
export const desktopWindowBoundsSchema = z
  .object({
    x: z.number().int().min(-100_000).max(100_000),
    y: z.number().int().min(-100_000).max(100_000),
    width: z.number().int().min(320).max(32_768),
    height: z.number().int().min(240).max(32_768),
  })
  .strict();
export const desktopWindowPreferencesSchema = z
  .object({
    titleBarStyle: z.enum(['custom', 'system']),
    opacity: z.number().min(0).max(1),
    zoomFactor: z.number().min(0.5).max(8),
    bounds: desktopWindowBoundsSchema.nullable(),
    globalHotkey: z.string().trim().max(80).default('Control+2'),
    allowMultiInstance: z.boolean().default(false),
    confirmBeforeExit: z.boolean().default(false),
  })
  .strict();
export const desktopWindowPreferencesPatchSchema = z
  .object({
    titleBarStyle: desktopWindowPreferencesSchema.shape.titleBarStyle.optional(),
    opacity: desktopWindowPreferencesSchema.shape.opacity.optional(),
    zoomFactor: desktopWindowPreferencesSchema.shape.zoomFactor.optional(),
    bounds: desktopWindowBoundsSchema.nullable().optional(),
    globalHotkey: desktopWindowPreferencesSchema.shape.globalHotkey.removeDefault().optional(),
    allowMultiInstance: desktopWindowPreferencesSchema.shape.allowMultiInstance
      .removeDefault()
      .optional(),
    confirmBeforeExit: desktopWindowPreferencesSchema.shape.confirmBeforeExit
      .removeDefault()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Expected at least one window preference');
export const desktopWindowPreferencesResultSchema = z
  .object({
    preferences: desktopWindowPreferencesSchema,
    requiresRestart: z.boolean(),
    globalHotkeyRegistered: z.boolean(),
  })
  .strict();
export type HostCredentialMetadata = z.infer<typeof hostCredentialMetadataSchema>;
export type FileGrant = z.infer<typeof fileGrantSchema>;
export type GrantedDirectoryEntry = z.infer<typeof grantedDirectoryEntrySchema>;
export type GrantedDirectoryListing = z.infer<typeof grantedDirectoryListingSchema>;
export type GrantedEntryCreateRequest = z.infer<typeof grantedEntryCreateRequestSchema>;
export type GrantedEntryRenameRequest = z.infer<typeof grantedEntryRenameRequestSchema>;
export type GrantedEntryChmodRequest = z.infer<typeof grantedEntryChmodRequestSchema>;
export type GrantedFileOpenRequest = z.infer<typeof grantedFileOpenRequestSchema>;
export type GrantedEntriesOperationRequest = z.infer<typeof grantedEntriesOperationRequestSchema>;
export type GrantedText = z.infer<typeof grantedTextSchema>;
export type HostWebViewBounds = z.infer<typeof hostWebViewBoundsSchema>;
export type HostWebViewCreate = z.infer<typeof hostWebViewCreateSchema>;
export type HostWebViewPresentation = z.infer<typeof hostWebViewPresentationSchema>;
export type HostWebViewAction = z.infer<typeof hostWebViewActionSchema>;
export type HostWebViewAuthResponse = z.infer<typeof hostWebViewAuthResponseSchema>;
export type HostWebViewState = z.infer<typeof hostWebViewStateSchema>;
export type DesktopLifecycleState = z.infer<typeof desktopLifecycleStateSchema>;
export type UpdaterStatus = z.infer<typeof updaterStatusSchema>;
export type UpdaterAction = z.infer<typeof updaterActionSchema>['action'];
export type SignedUpdateManifest = z.infer<typeof signedUpdateManifestSchema>;
export type DesktopWindowState = z.infer<typeof desktopWindowStateSchema>;
export type DesktopWindowAction = z.infer<typeof desktopWindowActionSchema>['action'];
export type DesktopWindowActionResult = z.infer<typeof desktopWindowActionResultSchema>;
export type DesktopWindowBounds = z.infer<typeof desktopWindowBoundsSchema>;
export type DesktopWindowPreferences = z.infer<typeof desktopWindowPreferencesSchema>;
export type DesktopWindowPreferencesPatch = z.infer<typeof desktopWindowPreferencesPatchSchema>;
export type DesktopWindowPreferencesResult = z.infer<typeof desktopWindowPreferencesResultSchema>;
