import createClient from 'openapi-fetch';
import {
  aiApprovalSchema,
  aiAttachmentPreviewSchema,
  aiConversationDetailSchema,
  aiConversationSchema,
  aiModelSchema,
  aiProviderSchema,
  aiProviderTestResultSchema,
  aiRunSchema,
  aiToolCallSchema,
  bootstrapResponseSchema,
  bookmarkTreeSchema,
  batchOperationSchema,
  clearBatchOperationsResultSchema,
  clearConnectionHistoryResultSchema,
  clearTransfersResultSchema,
  clearCommandHistoryResultSchema,
  commandHistoryPageSchema,
  connectionProfileSchema,
  connectionHistoryPageSchema,
  deleteConnectionHistoryResultSchema,
  deleteCommandHistoryResultSchema,
  deleteSshBookmarkEntryResultSchema,
  deleteSshBookmarkResultSchema,
  capabilitiesSchema,
  connectionSchema,
  credentialMetadataSchema,
  diagnosticsSchema,
  diagnosticExportSchema,
  electermDataPreviewSchema,
  electermDataImportResultSchema,
  electermDataExportResultSchema,
  syncProfileSchema,
  syncComparisonSchema,
  syncRunResultSchema,
  syncCommitResultSchema,
  testSyncProfileResultSchema,
  externalEditorSessionSchema,
  ftpConnectionSchema,
  fileComparisonSchema,
  healthSchema,
  hostGroupSchema,
  hostSchema,
  knownHostKeySchema,
  idSchema,
  interactionSchema,
  insertGrantedPathsResultSchema,
  problemSchema,
  promoteConnectionHistoryResultSchema,
  proxyTestResultSchema,
  quickCommandSchema,
  quickCommandTreeSchema,
  remoteFileEntrySchema,
  remoteTextSchema,
  rdpCredentialBootstrapSchema,
  rdpSessionSchema,
  vncCredentialBootstrapSchema,
  vncSessionSchema,
  spiceCredentialBootstrapSchema,
  spiceSessionSchema,
  webSessionActionSchema,
  webSessionAuthResponseSchema,
  webSessionPresentationSchema,
  webSessionSchema,
  nextDeepLinkIntentSchema,
  runtimeMetadataSchema,
  reconnectConnectionHistoryResultSchema,
  recordCommandHistoryResultSchema,
  settingsSchema,
  serialPortInfoSchema,
  sshConfigImportPreviewSchema,
  sshConfigImportResultSchema,
  sshAgentStatusSchema,
  sshBookmarkMutationResultSchema,
  TERMINAL_CLIENT_PROTOCOL_PREFIX,
  terminalProfileSchema,
  terminalThemeSchema,
  terminalThemeExportResultSchema,
  terminalBackgroundAssetSchema,
  terminalRecordingSchema,
  terminalTransferStateSchema,
  terminalInformationSnapshotSchema,
  terminalSessionSchema,
  transferSchema,
  triggerCollectionSchema,
  tunnelProfileSchema,
  tunnelSchema,
  widgetDefinitionSchema,
  widgetInstanceSchema,
  fileRenamePreviewSchema,
  fileRenameResultSchema,
  versionSchema,
  type AiModelInput,
  type AiModel,
  type AiModelPatch,
  type AiConversation,
  type AiConversationInput,
  type AiConversationPatch,
  type AiProvider,
  type AiProviderInput,
  type AiProviderPatch,
  type AiRequestInput,
  type BookmarkTree,
  type CreateBatchOperationInput,
  type ConnectionHistoryItem,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type ConnectionProfilePatch,
  type ConnectionHistorySort,
  type CommandHistoryItem,
  type CommandHistorySort,
  type CreateSshBookmarkInput,
  type CreateBookmarkGroupInput,
  type CreateBookmarkInput,
  type MoveBookmarkTreeNodeInput,
  type PromoteConnectionHistoryInput,
  type PreviewSshConfigImportInput,
  type CommitSshConfigImportInput,
  type ProxyTestRequest,
  type UpdateSshBookmarkInput,
  type UpdateBookmarkGroupInput,
  type UpdateBookmarkInput,
  type CreateCredentialInput,
  type CreateHostGroupInput,
  type CreateHostInput,
  type CreateFileComparison,
  type CreateTerminalInput,
  type Host,
  type HostGroup,
  type KnownHostKey,
  type QuickCommandInput,
  type QuickCommandPatch,
  type QuickCommandGroupInput,
  type QuickCommandGroupPatch,
  type QuickCommandTree,
  type MoveQuickCommandTreeNodeInput,
  type CreateRdpSessionInput,
  type CreateVncSessionInput,
  type CreateSpiceSessionInput,
  type CreateWebSessionInput,
  type WebSessionAction,
  type WebSessionAuthResponse,
  type WebSessionPresentation,
  type QuickConnectTargetInput,
  type RemoteCopyTransferRouteInput,
  type RuntimeMetadata,
  type Settings,
  type StartTunnelInput,
  type TerminalProfile,
  type TerminalProfileInput,
  type TerminalProfilePatch,
  type TerminalTheme,
  type TerminalThemeInput,
  type TerminalThemePatch,
  type TerminalTransferAction,
  type TransferRouteInput,
  type TunnelProfile,
  type TriggerCollection,
  type TriggerRuleInput,
  type TriggerRulePatch,
  type TunnelProfileInput,
  type UpdateSettingsInput,
  type RenameWidgetInstanceInput,
  type StartLocalFileServerInput,
  type StartLocalFtpServerInput,
  type StartLocalSshServerInput,
  type StartMcpServerInput,
  type PreviewFileRenameInput,
  type SyncDirection,
  type SyncProfile,
  type SyncProfileInput,
  type SyncProfilePatch,
} from '@workspace/contracts';
import {
  desktopWindowActionResultSchema,
  desktopBootstrapSchema,
  desktopWindowPreferencesPatchSchema,
  desktopWindowPreferencesResultSchema,
  desktopWindowStateSchema,
  fileGrantSchema,
  grantedDirectoryListingSchema,
  grantedTextSchema,
  updaterActionSchema,
  updaterStatusSchema,
  type DesktopWindowAction,
  type DesktopWindowPreferencesPatch,
  type DesktopBootstrapApi,
  type UpdaterAction,
} from '@workspace/contracts/desktop';
import type { paths } from './generated/api';

export class RuntimeClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly traceId?: string,
  ) {
    super(message);
  }
}
export interface RuntimeStatus {
  metadata: RuntimeMetadata;
  appVersion: string;
  apiVersion: 'v1';
  latencyMs: number;
}
interface Attached {
  api: ReturnType<typeof createClient<paths>>;
  baseUrl: string;
  sessionToken: string;
  generation: string;
  runtimeId: string;
}

/** Auth stays in this closure, never in query data or browser storage. */
export function createRuntimeClient(discovery: DesktopBootstrapApi, transport = globalThis.fetch) {
  let attached: Attached | undefined;
  let connecting: Promise<Attached> | undefined;
  let controller = new AbortController();
  let epoch = 0;
  let disposed = false;

  function reset() {
    epoch += 1;
    controller.abort();
    controller = new AbortController();
    attached = undefined;
    connecting = undefined;
  }

  async function connect(): Promise<Attached> {
    if (disposed) throw new RuntimeClientError('DISPOSED', 'Runtime client is closed');
    if (attached) return attached;
    if (connecting) return connecting;
    const currentEpoch = epoch;
    const signal = controller.signal;
    const pending = (async () => {
      const bootstrap = desktopBootstrapSchema.parse(await discovery.resolve());
      const auth: { sessionToken?: string } = {};
      const api = createClient<paths>({ baseUrl: bootstrap.baseUrl, fetch: transport });
      api.use({
        onRequest({ request }) {
          if (auth.sessionToken)
            request.headers.set('Authorization', `Bearer ${auth.sessionToken}`);
          request.headers.set('X-Runtime-Generation', bootstrap.generation);
          return request;
        },
        async onResponse({ response }) {
          verifyGeneration(response, bootstrap.generation, currentEpoch);
          if (!response.ok) throw await responseError(response);
        },
      });
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
      healthSchema.parse((await api.GET('/health', { signal: requestSignal })).data);
      const credentials = bootstrapResponseSchema.parse(
        (
          await api.POST('/api/v1/auth/bootstrap', {
            body: { bootstrapToken: bootstrap.bootstrapToken },
            signal: requestSignal,
          })
        ).data,
      );
      if (
        credentials.generation !== bootstrap.generation ||
        credentials.runtimeId !== bootstrap.runtimeId
      )
        throw new RuntimeClientError('STALE_GENERATION', 'Runtime identity changed');
      auth.sessionToken = credentials.sessionToken;
      versionSchema.parse((await api.GET('/api/v1/version', { signal: requestSignal })).data);
      capabilitiesSchema.parse(
        (await api.GET('/api/v1/capabilities', { signal: requestSignal })).data,
      );
      if (epoch !== currentEpoch)
        throw new RuntimeClientError('STALE_GENERATION', 'Runtime changed');
      attached = {
        api,
        baseUrl: bootstrap.baseUrl,
        sessionToken: credentials.sessionToken,
        generation: bootstrap.generation,
        runtimeId: bootstrap.runtimeId,
      };
      return attached;
    })();
    connecting = pending;
    try {
      return await pending;
    } finally {
      if (connecting === pending) connecting = undefined;
    }
  }

  function verifyGeneration(response: Response, generation: string, currentEpoch: number) {
    if (epoch !== currentEpoch) throw new RuntimeClientError('STALE_GENERATION', 'Runtime changed');
    const received = response.headers.get('X-Runtime-Generation');
    if (received && received !== generation)
      throw new RuntimeClientError('STALE_GENERATION', 'Runtime changed');
  }

  async function request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ) {
    const currentEpoch = epoch;
    try {
      const connection = await connect();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(30_000),
        ...(options.signal ? [options.signal] : []),
      ]);
      const response = await transport(
        new Request(new URL(path, connection.baseUrl), {
          method: options.method ?? 'GET',
          headers: {
            Authorization: `Bearer ${connection.sessionToken}`,
            'X-Runtime-Generation': connection.generation,
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...options.headers,
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal,
        }),
      );
      verifyGeneration(response, connection.generation, currentEpoch);
      if (!response.ok) throw await responseError(response);
      if (response.status === 204) return undefined;
      return response.json();
    } catch (error) {
      if (currentEpoch !== epoch)
        throw new RuntimeClientError('STALE_GENERATION', 'Runtime changed');
      const known = error instanceof RuntimeClientError ? error : undefined;
      if (
        !options.signal?.aborted &&
        (!known || ['UNAUTHORIZED', 'STALE_GENERATION'].includes(known.code))
      )
        reset();
      if (known) throw known;
      throw new RuntimeClientError('RUNTIME_UNAVAILABLE', 'The local runtime is unavailable');
    }
  }

  async function importDroppedFile(file: File, signal?: AbortSignal) {
    const currentEpoch = epoch;
    try {
      const connection = await connect();
      const response = await transport(
        new Request(new URL('/api/v1/file-grants/import', connection.baseUrl), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${connection.sessionToken}`,
            'X-Runtime-Generation': connection.generation,
            'Content-Type': 'application/octet-stream',
            'X-Axterm-File-Name': encodeURIComponent(file.name),
            'X-Axterm-File-Size': String(file.size),
          },
          body: file,
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30 * 60_000),
            ...(signal ? [signal] : []),
          ]),
        }),
      );
      verifyGeneration(response, connection.generation, currentEpoch);
      if (!response.ok) throw await responseError(response);
      return fileGrantSchema.parse(await response.json());
    } catch (error) {
      if (currentEpoch !== epoch)
        throw new RuntimeClientError('STALE_GENERATION', 'Runtime changed');
      const known = error instanceof RuntimeClientError ? error : undefined;
      if (!signal?.aborted && (!known || ['UNAUTHORIZED', 'STALE_GENERATION'].includes(known.code)))
        reset();
      if (known) throw known;
      if (signal?.aborted) throw error;
      throw new RuntimeClientError('RUNTIME_UNAVAILABLE', 'The local runtime is unavailable');
    }
  }

  async function requestBlob(path: string): Promise<Blob> {
    const currentEpoch = epoch;
    try {
      const connection = await connect();
      const response = await transport(
        new Request(new URL(path, connection.baseUrl), {
          headers: {
            Authorization: `Bearer ${connection.sessionToken}`,
            'X-Runtime-Generation': connection.generation,
          },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        }),
      );
      verifyGeneration(response, connection.generation, currentEpoch);
      if (!response.ok) throw await responseError(response);
      return response.blob();
    } catch (error) {
      if (currentEpoch !== epoch)
        throw new RuntimeClientError('STALE_GENERATION', 'Runtime changed');
      if (error instanceof RuntimeClientError) throw error;
      throw new RuntimeClientError('RUNTIME_UNAVAILABLE', 'The local runtime is unavailable');
    }
  }

  async function status(signal?: AbortSignal): Promise<RuntimeStatus> {
    const currentEpoch = epoch;
    try {
      const connection = await connect();
      const combinedSignal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(5_000),
        ...(signal ? [signal] : []),
      ]);
      const startedAt = performance.now();
      const [runtime, version] = await Promise.all([
        connection.api.GET('/api/v1/runtime', { signal: combinedSignal }),
        connection.api.GET('/api/v1/version', { signal: combinedSignal }),
      ]);
      const metadata = runtimeMetadataSchema.parse(runtime.data);
      if (
        currentEpoch !== epoch ||
        metadata.generation !== connection.generation ||
        metadata.runtimeId !== connection.runtimeId
      )
        throw new RuntimeClientError('STALE_GENERATION', 'Runtime identity changed');
      return {
        metadata,
        ...versionSchema.parse(version.data),
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      if (currentEpoch !== epoch)
        throw new RuntimeClientError('STALE_GENERATION', 'Runtime changed');
      if (currentEpoch === epoch && !signal?.aborted) reset();
      if (error instanceof RuntimeClientError) throw error;
      throw new RuntimeClientError('RUNTIME_UNAVAILABLE', 'The local runtime is unavailable');
    }
  }

  return {
    status,
    importDroppedFile,
    bookmarkTree: () =>
      request('/api/v1/bookmark-tree').then((value) => bookmarkTreeSchema.parse(value)),
    createSshBookmark: (tree: BookmarkTree, input: CreateSshBookmarkInput) =>
      request('/api/v1/ssh-bookmarks', {
        method: 'POST',
        body: input,
        headers: { 'If-Match': tree.etag },
      }).then((value) => sshBookmarkMutationResultSchema.parse(value)),
    updateSshBookmark: (
      tree: BookmarkTree,
      host: Host,
      bookmarkId: string,
      input: UpdateSshBookmarkInput,
    ) =>
      request(`/api/v1/ssh-bookmarks/${bookmarkId}`, {
        method: 'PATCH',
        body: input,
        headers: {
          'If-Match': `"v${host.version}"`,
          'X-Bookmark-Tree-If-Match': tree.etag,
        },
      }).then((value) => sshBookmarkMutationResultSchema.parse(value)),
    deleteSshBookmark: (tree: BookmarkTree, host: Host, bookmarkId: string) =>
      request(`/api/v1/ssh-bookmarks/${bookmarkId}`, {
        method: 'DELETE',
        headers: {
          'If-Match': `"v${host.version}"`,
          'X-Bookmark-Tree-If-Match': tree.etag,
        },
      }).then((value) => deleteSshBookmarkEntryResultSchema.parse(value)),
    deleteSshBookmarkHost: (tree: BookmarkTree, host: Host) =>
      request(`/api/v1/ssh-bookmark-hosts/${host.id}`, {
        method: 'DELETE',
        headers: {
          'If-Match': `"v${host.version}"`,
          'X-Bookmark-Tree-If-Match': tree.etag,
        },
      }).then((value) => deleteSshBookmarkResultSchema.parse(value)),
    createBookmarkGroup: (tree: BookmarkTree, input: CreateBookmarkGroupInput) =>
      request('/api/v1/bookmark-groups', {
        method: 'POST',
        body: input,
        headers: { 'If-Match': tree.etag },
      }).then((value) => bookmarkTreeSchema.parse(value)),
    updateBookmarkGroup: (tree: BookmarkTree, id: string, input: UpdateBookmarkGroupInput) =>
      request(`/api/v1/bookmark-groups/${id}`, {
        method: 'PATCH',
        body: input,
        headers: { 'If-Match': tree.etag },
      }).then((value) => bookmarkTreeSchema.parse(value)),
    deleteBookmarkGroup: (tree: BookmarkTree, id: string) =>
      request(`/api/v1/bookmark-groups/${id}`, {
        method: 'DELETE',
        headers: { 'If-Match': tree.etag },
      }).then((value) => bookmarkTreeSchema.parse(value)),
    createBookmark: (tree: BookmarkTree, input: CreateBookmarkInput) =>
      request('/api/v1/bookmarks', {
        method: 'POST',
        body: input,
        headers: { 'If-Match': tree.etag },
      }).then((value) => bookmarkTreeSchema.parse(value)),
    updateBookmark: (tree: BookmarkTree, id: string, input: UpdateBookmarkInput) =>
      request(`/api/v1/bookmarks/${id}`, {
        method: 'PATCH',
        body: input,
        headers: { 'If-Match': tree.etag },
      }).then((value) => bookmarkTreeSchema.parse(value)),
    deleteBookmark: (tree: BookmarkTree, id: string) =>
      request(`/api/v1/bookmarks/${id}`, {
        method: 'DELETE',
        headers: { 'If-Match': tree.etag },
      }).then((value) => bookmarkTreeSchema.parse(value)),
    moveBookmarkTreeNode: (tree: BookmarkTree, input: MoveBookmarkTreeNodeInput) =>
      request('/api/v1/bookmark-tree/moves', {
        method: 'POST',
        body: input,
        headers: { 'If-Match': tree.etag },
      }).then((value) => bookmarkTreeSchema.parse(value)),
    connectionProfiles: () =>
      request('/api/v1/connection-profiles').then((value) =>
        connectionProfileSchema.array().parse(value),
      ),
    createConnectionProfile: (input: ConnectionProfileInput) =>
      request('/api/v1/connection-profiles', { method: 'POST', body: input }).then((value) =>
        connectionProfileSchema.parse(value),
      ),
    previewElectermData: (grantId: string) =>
      request('/api/v1/data/electerm/previews', {
        method: 'POST',
        body: { grantId },
      }).then((value) => electermDataPreviewSchema.parse(value)),
    cancelElectermDataPreview: (previewId: string) =>
      request(`/api/v1/data/electerm/previews/${previewId}`, { method: 'DELETE' }),
    commitElectermDataImport: (previewId: string, tree: BookmarkTree) =>
      request('/api/v1/data/electerm/imports', {
        method: 'POST',
        body: { previewId },
        headers: { 'If-Match': tree.etag },
      }).then((value) => electermDataImportResultSchema.parse(value)),
    exportElectermData: (grantId: string) =>
      request('/api/v1/data/electerm/exports', {
        method: 'POST',
        body: { grantId },
      }).then((value) => electermDataExportResultSchema.parse(value)),
    syncProfiles: () =>
      request('/api/v1/sync/profiles').then((value) => syncProfileSchema.array().parse(value)),
    createSyncProfile: (input: SyncProfileInput) =>
      request('/api/v1/sync/profiles', { method: 'POST', body: input }).then((value) =>
        syncProfileSchema.parse(value),
      ),
    updateSyncProfile: (profile: SyncProfile, input: SyncProfilePatch) =>
      request(`/api/v1/sync/profiles/${profile.id}`, {
        method: 'PATCH',
        body: input,
        headers: { 'If-Match': `"v${profile.version}"` },
      }).then((value) => syncProfileSchema.parse(value)),
    deleteSyncProfile: (profile: SyncProfile) =>
      request(`/api/v1/sync/profiles/${profile.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"v${profile.version}"` },
      }),
    testSyncProfile: (id: string) =>
      request(`/api/v1/sync/profiles/${id}/test`, { method: 'POST' }).then((value) =>
        testSyncProfileResultSchema.parse(value),
      ),
    compareSyncProfile: (id: string) =>
      request(`/api/v1/sync/profiles/${id}/comparison`).then((value) =>
        syncComparisonSchema.parse(value),
      ),
    runDataSync: (id: string, direction: SyncDirection) =>
      request(`/api/v1/sync/profiles/${id}/runs`, {
        method: 'POST',
        body: { direction },
      }).then((value) => syncRunResultSchema.parse(value)),
    commitDataSyncDownload: (id: string, previewId: string, tree: BookmarkTree) =>
      request(`/api/v1/sync/profiles/${id}/download-commits`, {
        method: 'POST',
        body: { previewId },
        headers: { 'If-Match': tree.etag },
      }).then((value) => syncCommitResultSchema.parse(value)),
    dataSyncDownloadPreview: (id: string) =>
      request(`/api/v1/sync/profiles/${id}/download-preview`).then((value) =>
        electermDataPreviewSchema.parse(value),
      ),
    cancelDataSyncDownload: (id: string) =>
      request(`/api/v1/sync/profiles/${id}/download-preview`, { method: 'DELETE' }).then((value) =>
        syncProfileSchema.parse(value),
      ),
    cancelDataSyncRun: (id: string) =>
      request(`/api/v1/sync/profiles/${id}/run`, { method: 'DELETE' }),
    updateConnectionProfile: (entity: ConnectionProfile, input: ConnectionProfilePatch) =>
      request(`/api/v1/connection-profiles/${entity.id}`, {
        method: 'PATCH',
        body: input,
        headers: { 'If-Match': `"v${entity.version}"` },
      }).then((value) => connectionProfileSchema.parse(value)),
    deleteConnectionProfile: (entity: ConnectionProfile) =>
      request(`/api/v1/connection-profiles/${entity.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"v${entity.version}"` },
      }),
    hostGroups: () =>
      request('/api/v1/host-groups').then((value) => hostGroupSchema.array().parse(value)),
    createHostGroup: (input: CreateHostGroupInput) =>
      request('/api/v1/host-groups', { method: 'POST', body: input }).then((value) =>
        hostGroupSchema.parse(value),
      ),
    updateHostGroup: (entity: HostGroup, update: Partial<Pick<HostGroup, 'name' | 'sortOrder'>>) =>
      request(`/api/v1/host-groups/${entity.id}`, {
        method: 'PATCH',
        body: update,
        headers: { 'If-Match': `"v${entity.version}"` },
      }).then((value) => hostGroupSchema.parse(value)),
    deleteHostGroup: (entity: HostGroup) =>
      request(`/api/v1/host-groups/${entity.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"v${entity.version}"` },
      }),
    hosts: () => request('/api/v1/hosts').then((value) => hostSchema.array().parse(value)),
    knownHostKeys: () =>
      request('/api/v1/known-host-keys').then((value) => knownHostKeySchema.array().parse(value)),
    deleteKnownHostKey: (knownHostKey: KnownHostKey) =>
      request(`/api/v1/known-host-keys/${knownHostKey.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"v${knownHostKey.version}"` },
      }),
    createHost: (input: CreateHostInput) =>
      request('/api/v1/hosts', { method: 'POST', body: input }).then((value) =>
        hostSchema.parse(value),
      ),
    importHosts: async (grantId: string, groupId: string | null = null, tree?: BookmarkTree) => {
      const current = tree ?? bookmarkTreeSchema.parse(await request('/api/v1/bookmark-tree'));
      return request('/api/v1/hosts/import', {
        method: 'POST',
        body: { grantId, groupId },
        headers: { 'If-Match': current.etag },
      }).then((value) => sshConfigImportResultSchema.parse(value));
    },
    previewSshConfigImport: (input: PreviewSshConfigImportInput) =>
      request('/api/v1/hosts/import/preview', { method: 'POST', body: input }).then((value) =>
        sshConfigImportPreviewSchema.parse(value),
      ),
    commitSshConfigImport: (input: CommitSshConfigImportInput, tree: BookmarkTree) =>
      request('/api/v1/hosts/import/commit', {
        method: 'POST',
        body: input,
        headers: { 'If-Match': tree.etag },
      }).then((value) => sshConfigImportResultSchema.parse(value)),
    updateHost: (entity: Host, update: Partial<CreateHostInput>) =>
      request(`/api/v1/hosts/${entity.id}`, {
        method: 'PATCH',
        body: update,
        headers: { 'If-Match': `"v${entity.version}"` },
      }).then((value) => hostSchema.parse(value)),
    deleteHost: (entity: Host) =>
      request(`/api/v1/hosts/${entity.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"v${entity.version}"` },
      }),
    settings: () => request('/api/v1/settings').then((value) => settingsSchema.parse(value)),
    updateSettings: (settings: Settings, input: UpdateSettingsInput) =>
      request('/api/v1/settings', {
        method: 'PATCH',
        body: input,
        headers: { 'If-Match': `"v${settings.version}"` },
      }).then((value) => settingsSchema.parse(value)),
    credentials: () =>
      request('/api/v1/credentials').then((value) => credentialMetadataSchema.array().parse(value)),
    createCredential: (input: CreateCredentialInput) =>
      request('/api/v1/credentials', { method: 'POST', body: input }).then((value) =>
        credentialMetadataSchema.parse(value),
      ),
    deleteCredential: (ref: string) =>
      request(`/api/v1/credentials/${encodeURIComponent(ref)}`, { method: 'DELETE' }),
    connections: () =>
      request('/api/v1/connections').then((value) => connectionSchema.array().parse(value)),
    createConnection: (
      hostId: string,
      temporarySecret?: string,
      temporaryPassphrase?: string,
      connectionProfileId?: string,
      temporaryCertificate?: string,
    ) =>
      request('/api/v1/connections', {
        method: 'POST',
        body: {
          hostId,
          ...(connectionProfileId ? { connectionProfileId } : {}),
          ...(temporarySecret ? { temporarySecret } : {}),
          ...(temporaryPassphrase ? { temporaryPassphrase } : {}),
          ...(temporaryCertificate ? { temporaryCertificate } : {}),
        },
      }).then((value) => connectionSchema.parse(value)),
    probeSshAgent: (path?: string) =>
      request('/api/v1/ssh/agent/probe', {
        method: 'POST',
        body: path ? { path } : {},
      }).then((value) => sshAgentStatusSchema.parse(value)),
    createQuickConnection: (
      target: QuickConnectTargetInput,
      temporarySecret?: string,
      temporaryPassphrase?: string,
      connectionProfileId?: string,
      temporaryCredentialGrantId?: string,
    ) =>
      request('/api/v1/connections', {
        method: 'POST',
        body: {
          target,
          ...(connectionProfileId ? { connectionProfileId } : {}),
          ...(temporarySecret ? { temporarySecret } : {}),
          ...(temporaryPassphrase ? { temporaryPassphrase } : {}),
          ...(temporaryCredentialGrantId ? { temporaryCredentialGrantId } : {}),
        },
      }).then((value) => connectionSchema.parse(value)),
    retryConnection: (id: string) =>
      request(`/api/v1/connections/${id}/retry`, { method: 'POST' }).then((value) =>
        connectionSchema.parse(value),
      ),
    cancelConnectionReconnect: (id: string) =>
      request(`/api/v1/connections/${id}/reconnect/cancel`, { method: 'POST' }).then((value) =>
        connectionSchema.parse(value),
      ),
    closeConnection: (id: string) => request(`/api/v1/connections/${id}`, { method: 'DELETE' }),
    ftpConnections: () =>
      request('/api/v1/ftp/connections').then((value) => ftpConnectionSchema.array().parse(value)),
    createFtpConnection: (bookmarkId: string) =>
      request('/api/v1/ftp/connections', {
        method: 'POST',
        body: { bookmarkId },
      }).then((value) => ftpConnectionSchema.parse(value)),
    closeFtpConnection: (id: string) =>
      request(`/api/v1/ftp/connections/${id}`, { method: 'DELETE' }),
    serialPorts: () =>
      request('/api/v1/serial/ports').then((value) => serialPortInfoSchema.array().parse(value)),
    testProxy: (input: ProxyTestRequest) =>
      request('/api/v1/proxy/test', { method: 'POST', body: input }).then((value) =>
        proxyTestResultSchema.parse(value),
      ),
    connectionHistory: (
      input: { sort?: ConnectionHistorySort; limit?: number; cursor?: string } = {},
    ) => {
      const query = new URLSearchParams();
      if (input.sort) query.set('sort', input.sort);
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      if (input.cursor) query.set('cursor', input.cursor);
      const suffix = query.size ? `?${query.toString()}` : '';
      return request(`/api/v1/connection-history${suffix}`).then((value) =>
        connectionHistoryPageSchema.parse(value),
      );
    },
    deleteConnectionHistory: (item: ConnectionHistoryItem, idempotencyKey = crypto.randomUUID()) =>
      request(`/api/v1/connection-history/${item.id}`, {
        method: 'DELETE',
        headers: {
          'If-Match': `"v${item.version}"`,
          'Idempotency-Key': idempotencyKey,
        },
      }).then((value) => deleteConnectionHistoryResultSchema.parse(value)),
    clearConnectionHistory: (state: { etag: string }, idempotencyKey = crypto.randomUUID()) =>
      request('/api/v1/connection-history', {
        method: 'DELETE',
        headers: { 'If-Match': state.etag, 'Idempotency-Key': idempotencyKey },
      }).then((value) => clearConnectionHistoryResultSchema.parse(value)),
    reconnectConnectionHistory: (
      item: ConnectionHistoryItem,
      temporarySecret?: string,
      temporaryPassphrase?: string,
      idempotencyKey = crypto.randomUUID(),
    ) =>
      request(`/api/v1/connection-history/${item.id}/reconnect`, {
        method: 'POST',
        headers: {
          'If-Match': `"v${item.version}"`,
          'Idempotency-Key': idempotencyKey,
        },
        body: {
          ...(temporarySecret ? { temporarySecret } : {}),
          ...(temporaryPassphrase ? { temporaryPassphrase } : {}),
        },
      }).then((value) => reconnectConnectionHistoryResultSchema.parse(value)),
    promoteConnectionHistory: (
      item: ConnectionHistoryItem,
      tree: BookmarkTree,
      input: PromoteConnectionHistoryInput,
      idempotencyKey = crypto.randomUUID(),
    ) =>
      request(`/api/v1/connection-history/${item.id}/bookmark`, {
        method: 'POST',
        headers: {
          'If-Match': `"v${item.version}"`,
          'X-Bookmark-Tree-If-Match': tree.etag,
          'Idempotency-Key': idempotencyKey,
        },
        body: input,
      }).then((value) => promoteConnectionHistoryResultSchema.parse(value)),
    commandHistory: (
      input: { sort?: CommandHistorySort; search?: string; limit?: number; cursor?: string } = {},
    ) => {
      const query = new URLSearchParams();
      if (input.sort) query.set('sort', input.sort);
      if (input.search) query.set('search', input.search);
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      if (input.cursor) query.set('cursor', input.cursor);
      const suffix = query.size ? `?${query.toString()}` : '';
      return request(`/api/v1/command-history${suffix}`).then((value) =>
        commandHistoryPageSchema.parse(value),
      );
    },
    recordCommandHistory: (
      terminalId: string,
      command: string,
      idempotencyKey = crypto.randomUUID(),
    ) =>
      request('/api/v1/command-history', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: { terminalId, command, source: 'shellIntegration' },
      }).then((value) => recordCommandHistoryResultSchema.parse(value)),
    deleteCommandHistory: (item: CommandHistoryItem, idempotencyKey = crypto.randomUUID()) =>
      request(`/api/v1/command-history/${item.id}`, {
        method: 'DELETE',
        headers: {
          'If-Match': `"v${item.version}"`,
          'Idempotency-Key': idempotencyKey,
        },
      }).then((value) => deleteCommandHistoryResultSchema.parse(value)),
    clearCommandHistory: (state: { etag: string }, idempotencyKey = crypto.randomUUID()) =>
      request('/api/v1/command-history', {
        method: 'DELETE',
        headers: { 'If-Match': state.etag, 'Idempotency-Key': idempotencyKey },
      }).then((value) => clearCommandHistoryResultSchema.parse(value)),
    interactions: () =>
      request('/api/v1/interactions').then((value) => interactionSchema.array().parse(value)),
    respondInteraction: (
      id: string,
      input: { accepted: boolean; remember?: boolean; values?: Record<string, string> },
    ) => request(`/api/v1/interactions/${id}/respond`, { method: 'POST', body: input }),
    terminals: () =>
      request('/api/v1/terminals').then((value) => terminalSessionSchema.array().parse(value)),
    createTerminal: (input: CreateTerminalInput) =>
      request('/api/v1/terminals', { method: 'POST', body: input }).then((value) =>
        terminalSessionSchema.parse(value),
      ),
    terminal: (id: string) =>
      request(`/api/v1/terminals/${id}`).then((value) => terminalSessionSchema.parse(value)),
    terminalInformation: (id: string, signal?: AbortSignal) =>
      request(`/api/v1/terminals/${id}/information`, signal ? { signal } : {}).then((value) =>
        terminalInformationSnapshotSchema.parse(value),
      ),
    terminalTransfer: (id: string) =>
      request(`/api/v1/terminals/${id}/transfer`).then((value) =>
        terminalTransferStateSchema.nullable().parse(value),
      ),
    performTerminalTransferAction: (id: string, action: TerminalTransferAction) =>
      request(`/api/v1/terminals/${id}/transfer/actions`, {
        method: 'POST',
        body: action,
      }).then((value) => terminalTransferStateSchema.parse(value)),
    startTerminalRecording: (
      id: string,
      input: { grantId: string; timestamps: boolean; includeRecent?: boolean },
    ) =>
      request(`/api/v1/terminals/${id}/recording`, {
        method: 'POST',
        body: { includeRecent: true, ...input },
      }).then((value) => terminalRecordingSchema.parse(value)),
    stopTerminalRecording: (id: string) =>
      request(`/api/v1/terminals/${id}/recording`, { method: 'DELETE' }).then((value) =>
        terminalRecordingSchema.parse(value),
      ),
    insertGrantedTerminalPaths: (id: string, grantIds: string[]) =>
      request(`/api/v1/terminals/${id}/granted-paths`, {
        method: 'POST',
        body: { grantIds },
      }).then((value) => insertGrantedPathsResultSchema.parse(value)),
    closeTerminal: (id: string) => request(`/api/v1/terminals/${id}`, { method: 'DELETE' }),
    rdpSessions: () =>
      request('/api/v1/rdp/sessions').then((value) => rdpSessionSchema.array().parse(value)),
    createRdpSession: (input: CreateRdpSessionInput) =>
      request('/api/v1/rdp/sessions', { method: 'POST', body: input }).then((value) =>
        rdpSessionSchema.parse(value),
      ),
    rdpSession: (id: string) =>
      request(`/api/v1/rdp/sessions/${id}`).then((value) => rdpSessionSchema.parse(value)),
    claimRdpCredentials: (id: string) =>
      request(`/api/v1/rdp/sessions/${id}/credentials/claim`, { method: 'POST' }).then((value) =>
        rdpCredentialBootstrapSchema.parse(value),
      ),
    resizeRdpSession: (id: string, width: number, height: number) =>
      request(`/api/v1/rdp/sessions/${id}`, {
        method: 'PATCH',
        body: { width, height },
      }).then((value) => rdpSessionSchema.parse(value)),
    closeRdpSession: (id: string) => request(`/api/v1/rdp/sessions/${id}`, { method: 'DELETE' }),
    async rdpSocketDescriptor(id: string) {
      const connection = await connect();
      const validatedId = idSchema.parse(id);
      const url = new URL(`/api/v1/rdp/sessions/${validatedId}/stream`, connection.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return {
        url: url.toString(),
        protocols: ['rdp.v1', `auth.${connection.sessionToken}`],
      };
    },
    vncSessions: () =>
      request('/api/v1/vnc/sessions').then((value) => vncSessionSchema.array().parse(value)),
    createVncSession: (input: CreateVncSessionInput) =>
      request('/api/v1/vnc/sessions', { method: 'POST', body: input }).then((value) =>
        vncSessionSchema.parse(value),
      ),
    vncSession: (id: string) =>
      request(`/api/v1/vnc/sessions/${id}`).then((value) => vncSessionSchema.parse(value)),
    claimVncCredentials: (id: string) =>
      request(`/api/v1/vnc/sessions/${id}/credentials/claim`, { method: 'POST' }).then((value) =>
        vncCredentialBootstrapSchema.parse(value),
      ),
    closeVncSession: (id: string) => request(`/api/v1/vnc/sessions/${id}`, { method: 'DELETE' }),
    async vncSocketDescriptor(id: string) {
      const connection = await connect();
      const validatedId = idSchema.parse(id);
      const url = new URL(`/api/v1/vnc/sessions/${validatedId}/stream`, connection.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return {
        url: url.toString(),
        protocols: ['vnc.v1', `auth.${connection.sessionToken}`],
      };
    },
    spiceSessions: () =>
      request('/api/v1/spice/sessions').then((value) => spiceSessionSchema.array().parse(value)),
    createSpiceSession: (input: CreateSpiceSessionInput) =>
      request('/api/v1/spice/sessions', { method: 'POST', body: input }).then((value) =>
        spiceSessionSchema.parse(value),
      ),
    spiceSession: (id: string) =>
      request(`/api/v1/spice/sessions/${id}`).then((value) => spiceSessionSchema.parse(value)),
    claimSpiceCredentials: (id: string) =>
      request(`/api/v1/spice/sessions/${id}/credentials/claim`, { method: 'POST' }).then((value) =>
        spiceCredentialBootstrapSchema.parse(value),
      ),
    closeSpiceSession: (id: string) =>
      request(`/api/v1/spice/sessions/${id}`, { method: 'DELETE' }),
    async spiceSocketDescriptor(id: string) {
      const connection = await connect();
      const validatedId = idSchema.parse(id);
      const url = new URL(`/api/v1/spice/sessions/${validatedId}/stream`, connection.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return {
        url: url.toString(),
        protocols: ['spice.v1', `auth.${connection.sessionToken}`],
      };
    },
    webSessions: () =>
      request('/api/v1/web/sessions').then((value) => webSessionSchema.array().parse(value)),
    createWebSession: (input: CreateWebSessionInput) =>
      request('/api/v1/web/sessions', { method: 'POST', body: input }).then((value) =>
        webSessionSchema.parse(value),
      ),
    webSession: (id: string) =>
      request(`/api/v1/web/sessions/${id}`).then((value) => webSessionSchema.parse(value)),
    presentWebSession: (id: string, input: WebSessionPresentation) =>
      request(`/api/v1/web/sessions/${id}`, {
        method: 'PATCH',
        body: webSessionPresentationSchema.parse(input),
      }).then((value) => webSessionSchema.parse(value)),
    performWebSessionAction: (id: string, input: WebSessionAction) =>
      request(`/api/v1/web/sessions/${id}/actions`, {
        method: 'POST',
        body: webSessionActionSchema.parse(input),
      }).then((value) => webSessionSchema.parse(value)),
    answerWebSessionAuthentication: (id: string, input: WebSessionAuthResponse) =>
      request(`/api/v1/web/sessions/${id}/auth`, {
        method: 'POST',
        body: webSessionAuthResponseSchema.parse(input),
      }).then((value) => webSessionSchema.parse(value)),
    closeWebSession: (id: string) => request(`/api/v1/web/sessions/${id}`, { method: 'DELETE' }),
    nextDeepLinkIntent: () =>
      request('/api/v1/desktop/deep-links/next').then((value) =>
        nextDeepLinkIntentSchema.parse(value),
      ),
    async openTerminalSocket(id: string, clientId: string) {
      const connection = await connect();
      const validatedClientId = idSchema.parse(clientId);
      const url = new URL(`/api/v1/terminals/${id}/stream`, connection.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return new WebSocket(url, [
        'terminal.v1',
        `${TERMINAL_CLIENT_PROTOCOL_PREFIX}${validatedClientId}`,
        `auth.${connection.sessionToken}`,
      ]);
    },
    remoteFiles: (connectionId: string, path: string) =>
      request(`/api/v1/sftp/${connectionId}/list?path=${encodeURIComponent(path)}`).then((value) =>
        remoteFileEntrySchema.array().parse(value),
      ),
    ftpFiles: (connectionId: string, path: string) =>
      request(`/api/v1/ftp/${connectionId}/list?path=${encodeURIComponent(path)}`).then((value) =>
        remoteFileEntrySchema.array().parse(value),
      ),
    createFtpDirectory: (connectionId: string, path: string) =>
      request(`/api/v1/ftp/${connectionId}/mkdir`, { method: 'POST', body: { path } }),
    createFtpFile: (connectionId: string, path: string) =>
      request(`/api/v1/ftp/${connectionId}/touch`, { method: 'POST', body: { path } }),
    renameFtpPath: (connectionId: string, from: string, to: string) =>
      request(`/api/v1/ftp/${connectionId}/rename`, { method: 'POST', body: { from, to } }),
    deleteFtpPath: (connectionId: string, path: string) =>
      request(`/api/v1/ftp/${connectionId}/path?path=${encodeURIComponent(path)}`, {
        method: 'DELETE',
      }),
    createRemoteDirectory: (connectionId: string, path: string) =>
      request(`/api/v1/sftp/${connectionId}/mkdir`, { method: 'POST', body: { path } }),
    createRemoteFile: (connectionId: string, path: string) =>
      request(`/api/v1/sftp/${connectionId}/touch`, { method: 'POST', body: { path } }),
    renameRemotePath: (connectionId: string, from: string, to: string) =>
      request(`/api/v1/sftp/${connectionId}/rename`, { method: 'POST', body: { from, to } }),
    deleteRemotePath: (connectionId: string, path: string) =>
      request(`/api/v1/sftp/${connectionId}/path?path=${encodeURIComponent(path)}`, {
        method: 'DELETE',
      }),
    readRemoteText: (connectionId: string, path: string) =>
      request(`/api/v1/sftp/${connectionId}/text?path=${encodeURIComponent(path)}`).then((value) =>
        remoteTextSchema.parse(value),
      ),
    writeRemoteText: (
      connectionId: string,
      input: {
        path: string;
        content: string;
        overwriteRevision: string;
        lineEnding: 'lf' | 'crlf';
      },
    ) =>
      request(`/api/v1/sftp/${connectionId}/text`, { method: 'POST', body: input }).then((value) =>
        remoteTextSchema.parse(value),
      ),
    createExternalEditor: (connectionId: string, path: string) =>
      request(`/api/v1/sftp/${connectionId}/external-editors`, {
        method: 'POST',
        body: { path },
      }).then((value) => externalEditorSessionSchema.parse(value)),
    getExternalEditor: (id: string) =>
      request(`/api/v1/external-editors/${id}`).then((value) =>
        externalEditorSessionSchema.parse(value),
      ),
    pushExternalEditorChanges: (id: string) =>
      request(`/api/v1/external-editors/${id}/push`, { method: 'POST' }).then((value) =>
        externalEditorSessionSchema.parse(value),
      ),
    closeExternalEditor: (id: string) =>
      request(`/api/v1/external-editors/${id}`, { method: 'DELETE' }),
    compareFiles: (input: CreateFileComparison) =>
      request('/api/v1/file-comparisons', { method: 'POST', body: input }).then((value) =>
        fileComparisonSchema.parse(value),
      ),
    chmod: (connectionId: string, path: string, mode: number) =>
      request(`/api/v1/sftp/${connectionId}/chmod`, { method: 'POST', body: { path, mode } }),
    operateRemoteEntries: (
      connectionId: string,
      input: {
        paths: string[];
        destination: string;
        operation: 'copy' | 'move';
        conflict: 'skip' | 'overwrite' | 'rename';
      },
    ) => request(`/api/v1/sftp/${connectionId}/operate`, { method: 'POST', body: input }),
    createFileGrant: (
      kind: 'open-file' | 'open-directory' | 'save-file' | 'home-directory' | 'directory-path',
      path?: string,
    ) =>
      request('/api/v1/file-grants', {
        method: 'POST',
        body: { kind, ...(kind === 'directory-path' ? { path } : {}) },
      }).then((value) => (value === undefined ? undefined : fileGrantSchema.parse(value))),
    revokeFileGrant: (grantId: string) =>
      request(`/api/v1/file-grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' }),
    listGrantedDirectory: (grantId: string, path = '') =>
      request(`/api/v1/file-grants/${encodeURIComponent(grantId)}/list`, {
        method: 'POST',
        body: { path },
      }).then((value) => grantedDirectoryListingSchema.parse(value)),
    createGrantedEntry: (
      grantId: string,
      input: { path: string; name: string; type: 'file' | 'directory' },
    ) =>
      request(`/api/v1/file-grants/${encodeURIComponent(grantId)}/entries`, {
        method: 'POST',
        body: input,
      }),
    renameGrantedEntry: (grantId: string, path: string, name: string) =>
      request(`/api/v1/file-grants/${encodeURIComponent(grantId)}/rename`, {
        method: 'POST',
        body: { path, name },
      }),
    chmodGrantedEntry: (grantId: string, path: string, mode: number) =>
      request(`/api/v1/file-grants/${encodeURIComponent(grantId)}/chmod`, {
        method: 'POST',
        body: { path, mode },
      }),
    deleteGrantedEntry: (grantId: string, path: string) =>
      request(`/api/v1/file-grants/${encodeURIComponent(grantId)}/delete`, {
        method: 'POST',
        body: { path },
      }),
    openGrantedEntry: (grantId: string, path: string) =>
      request(`/api/v1/file-grants/${encodeURIComponent(grantId)}/open`, {
        method: 'POST',
        body: { path },
      }),
    revealGrantedEntry: (grantId: string, path: string) =>
      request(`/api/v1/file-grants/${encodeURIComponent(grantId)}/reveal`, {
        method: 'POST',
        body: { path },
      }),
    copyGrantedEntryPaths: (grantId: string, paths: string[]) =>
      request(`/api/v1/file-grants/${encodeURIComponent(grantId)}/copy-path`, {
        method: 'POST',
        body: { paths },
      }),
    operateGrantedEntries: (
      grantId: string,
      input: {
        paths: string[];
        destination: string;
        operation: 'copy' | 'move';
        conflict: 'skip' | 'overwrite' | 'rename';
      },
    ) =>
      request(`/api/v1/file-grants/${encodeURIComponent(grantId)}/operate`, {
        method: 'POST',
        body: input,
      }),
    readGrantedText: (grantId: string) =>
      request(`/api/v1/file-grants/${encodeURIComponent(grantId)}/read-text`, {
        method: 'POST',
      }).then((value) => grantedTextSchema.parse(value)),
    createTransfer: (
      connectionId: string,
      direction: 'upload' | 'download',
      input: TransferRouteInput,
    ) =>
      request(`/api/v1/sftp/${connectionId}/${direction}`, {
        method: 'POST',
        body: input,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      }).then((value) => transferSchema.parse(value)),
    createFtpTransfer: (
      connectionId: string,
      direction: 'upload' | 'download',
      input: TransferRouteInput,
    ) =>
      request(`/api/v1/ftp/${connectionId}/${direction}`, {
        method: 'POST',
        body: input,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      }).then((value) => transferSchema.parse(value)),
    createRemoteTransfer: (input: RemoteCopyTransferRouteInput) =>
      request('/api/v1/remote-transfers', {
        method: 'POST',
        body: input,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      }).then((value) => transferSchema.parse(value)),
    transfers: () =>
      request('/api/v1/transfers').then((value) => transferSchema.array().parse(value)),
    cancelTransfer: (id: string) => request(`/api/v1/transfers/${id}/cancel`, { method: 'POST' }),
    pauseTransfer: (id: string) => request(`/api/v1/transfers/${id}/pause`, { method: 'POST' }),
    resumeTransfer: (id: string) => request(`/api/v1/transfers/${id}/resume`, { method: 'POST' }),
    retryTransfer: (id: string) =>
      request(`/api/v1/transfers/${id}/retry`, { method: 'POST' }).then((value) =>
        transferSchema.parse(value),
      ),
    resolveTransferConflict: (
      id: string,
      input: { strategy: 'skip' | 'overwrite' | 'rename'; applyToAll: boolean },
    ) =>
      request(`/api/v1/transfers/${id}/conflict`, {
        method: 'POST',
        body: input,
      }),
    clearCompletedTransfers: () =>
      request('/api/v1/transfers/clear', { method: 'POST' }).then((value) =>
        clearTransfersResultSchema.parse(value),
      ),
    quickCommands: () =>
      request('/api/v1/quick-commands').then((value) => quickCommandSchema.array().parse(value)),
    quickCommandTree: () =>
      request('/api/v1/quick-command-tree').then((value) => quickCommandTreeSchema.parse(value)),
    createQuickCommand: (tree: QuickCommandTree, input: QuickCommandInput) =>
      request('/api/v1/quick-commands', {
        method: 'POST',
        body: input,
        headers: { 'If-Match': tree.etag },
      }).then((value) => quickCommandTreeSchema.parse(value)),
    updateQuickCommand: (tree: QuickCommandTree, id: string, input: QuickCommandPatch) =>
      request(`/api/v1/quick-commands/${id}`, {
        method: 'PATCH',
        body: input,
        headers: { 'If-Match': tree.etag },
      }).then((value) => quickCommandTreeSchema.parse(value)),
    deleteQuickCommand: (tree: QuickCommandTree, id: string) =>
      request(`/api/v1/quick-commands/${id}`, {
        method: 'DELETE',
        headers: { 'If-Match': tree.etag },
      }).then((value) => quickCommandTreeSchema.parse(value)),
    createQuickCommandGroup: (tree: QuickCommandTree, input: QuickCommandGroupInput) =>
      request('/api/v1/quick-command-groups', {
        method: 'POST',
        body: input,
        headers: { 'If-Match': tree.etag },
      }).then((value) => quickCommandTreeSchema.parse(value)),
    updateQuickCommandGroup: (tree: QuickCommandTree, id: string, input: QuickCommandGroupPatch) =>
      request(`/api/v1/quick-command-groups/${id}`, {
        method: 'PATCH',
        body: input,
        headers: { 'If-Match': tree.etag },
      }).then((value) => quickCommandTreeSchema.parse(value)),
    deleteQuickCommandGroup: (tree: QuickCommandTree, id: string) =>
      request(`/api/v1/quick-command-groups/${id}`, {
        method: 'DELETE',
        headers: { 'If-Match': tree.etag },
      }).then((value) => quickCommandTreeSchema.parse(value)),
    moveQuickCommandTreeNode: (tree: QuickCommandTree, input: MoveQuickCommandTreeNodeInput) =>
      request('/api/v1/quick-command-tree/moves', {
        method: 'POST',
        body: input,
        headers: { 'If-Match': tree.etag },
      }).then((value) => quickCommandTreeSchema.parse(value)),
    terminalThemes: () =>
      request('/api/v1/terminal-themes').then((value) => terminalThemeSchema.array().parse(value)),
    createTerminalTheme: (input: TerminalThemeInput) =>
      request('/api/v1/terminal-themes', { method: 'POST', body: input }).then((value) =>
        terminalThemeSchema.parse(value),
      ),
    cloneTerminalTheme: (id: string, name?: string) =>
      request(`/api/v1/terminal-themes/${id}/clone`, {
        method: 'POST',
        body: name ? { name } : {},
      }).then((value) => terminalThemeSchema.parse(value)),
    updateTerminalTheme: (theme: TerminalTheme, input: TerminalThemePatch) =>
      request(`/api/v1/terminal-themes/${theme.id}`, {
        method: 'PATCH',
        body: input,
        headers: { 'If-Match': `"v${theme.version}"` },
      }).then((value) => terminalThemeSchema.parse(value)),
    deleteTerminalTheme: (theme: TerminalTheme) =>
      request(`/api/v1/terminal-themes/${theme.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"v${theme.version}"` },
      }),
    importTerminalTheme: (grantId: string) =>
      request('/api/v1/terminal-themes/imports', { method: 'POST', body: { grantId } }).then(
        (value) => terminalThemeSchema.parse(value),
      ),
    exportTerminalTheme: (id: string, grantId: string) =>
      request(`/api/v1/terminal-themes/${id}/exports`, {
        method: 'POST',
        body: { grantId },
      }).then((value) => terminalThemeExportResultSchema.parse(value)),
    importTerminalBackgroundAsset: (grantId: string) =>
      request('/api/v1/terminal-background-assets', {
        method: 'POST',
        body: { grantId },
      }).then((value) => terminalBackgroundAssetSchema.parse(value)),
    terminalBackgroundAssetBlob: (id: string) =>
      requestBlob(`/api/v1/terminal-background-assets/${id}/content`),
    deleteTerminalBackgroundAsset: (id: string) =>
      request(`/api/v1/terminal-background-assets/${id}`, { method: 'DELETE' }),
    batchOperations: () =>
      request('/api/v1/batch-operations').then((value) =>
        batchOperationSchema.array().parse(value),
      ),
    batchOperation: (id: string) =>
      request(`/api/v1/batch-operations/${id}`).then((value) => batchOperationSchema.parse(value)),
    createBatchOperation: (input: CreateBatchOperationInput) =>
      request('/api/v1/batch-operations', {
        method: 'POST',
        body: input,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      }).then((value) => batchOperationSchema.parse(value)),
    cancelBatchOperation: (id: string) =>
      request(`/api/v1/batch-operations/${id}/cancel`, { method: 'POST' }).then((value) =>
        batchOperationSchema.parse(value),
      ),
    clearBatchOperations: () =>
      request('/api/v1/batch-operations/clear', { method: 'POST' }).then((value) =>
        clearBatchOperationsResultSchema.parse(value),
      ),
    widgets: () =>
      request('/api/v1/widgets').then((value) => widgetDefinitionSchema.array().parse(value)),
    widgetInstances: () =>
      request('/api/v1/widgets/instances').then((value) =>
        widgetInstanceSchema.array().parse(value),
      ),
    widgetInstance: (id: string) =>
      request(`/api/v1/widgets/instances/${id}`).then((value) => widgetInstanceSchema.parse(value)),
    startLocalFileServerWidget: (input: StartLocalFileServerInput) =>
      request('/api/v1/widgets/local-file-server/instances', {
        method: 'POST',
        body: input,
      }).then((value) => widgetInstanceSchema.parse(value)),
    startLocalFtpServerWidget: (input: StartLocalFtpServerInput) =>
      request('/api/v1/widgets/local-ftp-server/instances', {
        method: 'POST',
        body: input,
      }).then((value) => widgetInstanceSchema.parse(value)),
    startLocalSshServerWidget: (input: StartLocalSshServerInput) =>
      request('/api/v1/widgets/local-ssh-server/instances', {
        method: 'POST',
        body: input,
      }).then((value) => widgetInstanceSchema.parse(value)),
    startMcpServerWidget: (input: StartMcpServerInput) =>
      request('/api/v1/widgets/mcp-server/instances', {
        method: 'POST',
        body: input,
      }).then((value) => widgetInstanceSchema.parse(value)),
    previewFileRenameWidget: (input: PreviewFileRenameInput) =>
      request('/api/v1/widgets/file-renamer/previews', { method: 'POST', body: input }).then(
        (value) => fileRenamePreviewSchema.parse(value),
      ),
    runFileRenameWidget: (previewId: string, idempotencyKey = crypto.randomUUID()) =>
      request('/api/v1/widgets/file-renamer/runs', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: { previewId },
      }).then((value) => fileRenameResultSchema.parse(value)),
    renameWidgetInstance: (id: string, input: RenameWidgetInstanceInput) =>
      request(`/api/v1/widgets/instances/${id}`, { method: 'PATCH', body: input }).then((value) =>
        widgetInstanceSchema.parse(value),
      ),
    stopWidgetInstance: (id: string) =>
      request(`/api/v1/widgets/instances/${id}`, { method: 'DELETE' }).then((value) =>
        widgetInstanceSchema.parse(value),
      ),
    triggers: () =>
      request('/api/v1/triggers').then((value) => triggerCollectionSchema.parse(value)),
    createTrigger: (collection: TriggerCollection, input: TriggerRuleInput) =>
      request('/api/v1/triggers', {
        method: 'POST',
        body: input,
        headers: { 'If-Match': collection.etag },
      }).then((value) => triggerCollectionSchema.parse(value)),
    updateTrigger: (collection: TriggerCollection, id: string, input: TriggerRulePatch) =>
      request(`/api/v1/triggers/${id}`, {
        method: 'PATCH',
        body: input,
        headers: { 'If-Match': collection.etag },
      }).then((value) => triggerCollectionSchema.parse(value)),
    deleteTrigger: (collection: TriggerCollection, id: string) =>
      request(`/api/v1/triggers/${id}`, {
        method: 'DELETE',
        headers: { 'If-Match': collection.etag },
      }).then((value) => triggerCollectionSchema.parse(value)),
    replaceTriggers: (collection: TriggerCollection, inputs: TriggerRuleInput[]) =>
      request('/api/v1/triggers', {
        method: 'PUT',
        body: inputs,
        headers: { 'If-Match': collection.etag },
      }).then((value) => triggerCollectionSchema.parse(value)),
    terminalProfiles: () =>
      request('/api/v1/terminal-profiles').then((value) =>
        terminalProfileSchema.array().parse(value),
      ),
    createTerminalProfile: (input: TerminalProfileInput) =>
      request('/api/v1/terminal-profiles', { method: 'POST', body: input }).then((value) =>
        terminalProfileSchema.parse(value),
      ),
    updateTerminalProfile: (profile: TerminalProfile, input: TerminalProfilePatch) =>
      request(`/api/v1/terminal-profiles/${profile.id}`, {
        method: 'PATCH',
        body: input,
        headers: { 'If-Match': `"v${profile.version}"` },
      }).then((value) => terminalProfileSchema.parse(value)),
    tunnelProfiles: () =>
      request('/api/v1/tunnel-profiles').then((value) => tunnelProfileSchema.array().parse(value)),
    createTunnelProfile: (input: TunnelProfileInput) =>
      request('/api/v1/tunnel-profiles', { method: 'POST', body: input }).then((value) =>
        tunnelProfileSchema.parse(value),
      ),
    updateTunnelProfile: (profile: TunnelProfile, input: Partial<TunnelProfileInput>) =>
      request(`/api/v1/tunnel-profiles/${profile.id}`, {
        method: 'PATCH',
        body: input,
        headers: { 'If-Match': `"v${profile.version}"` },
      }).then((value) => tunnelProfileSchema.parse(value)),
    deleteTunnelProfile: (profile: TunnelProfile) =>
      request(`/api/v1/tunnel-profiles/${profile.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"v${profile.version}"` },
      }),
    tunnels: () => request('/api/v1/tunnels').then((value) => tunnelSchema.array().parse(value)),
    startTunnel: (input: StartTunnelInput) =>
      request('/api/v1/tunnels', {
        method: 'POST',
        body: input,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      }).then((value) => tunnelSchema.parse(value)),
    stopTunnel: (id: string) => request(`/api/v1/tunnels/${id}`, { method: 'DELETE' }),
    aiProviders: () =>
      request('/api/v1/ai/providers').then((value) => aiProviderSchema.array().parse(value)),
    createAiProvider: (input: AiProviderInput) =>
      request('/api/v1/ai/providers', { method: 'POST', body: input }).then((value) =>
        aiProviderSchema.parse(value),
      ),
    updateAiProvider: (provider: AiProvider, input: AiProviderPatch) =>
      request(`/api/v1/ai/providers/${provider.id}`, {
        method: 'PATCH',
        body: input,
        headers: { 'If-Match': `"v${provider.version}"` },
      }).then((value) => aiProviderSchema.parse(value)),
    deleteAiProvider: (provider: AiProvider) =>
      request(`/api/v1/ai/providers/${provider.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"v${provider.version}"` },
      }),
    testAiProvider: (id: string) =>
      request(`/api/v1/ai/providers/${id}/test`, { method: 'POST' }).then((value) =>
        aiProviderTestResultSchema.parse(value),
      ),
    aiModels: () =>
      request('/api/v1/ai/models').then((value) => aiModelSchema.array().parse(value)),
    createAiModel: (input: AiModelInput) =>
      request('/api/v1/ai/models', { method: 'POST', body: input }).then((value) =>
        aiModelSchema.parse(value),
      ),
    updateAiModel: (model: AiModel, input: AiModelPatch) =>
      request(`/api/v1/ai/models/${model.id}`, {
        method: 'PATCH',
        body: input,
        headers: { 'If-Match': `"v${model.version}"` },
      }).then((value) => aiModelSchema.parse(value)),
    deleteAiModel: (model: AiModel) =>
      request(`/api/v1/ai/models/${model.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"v${model.version}"` },
      }),
    aiConversations: () =>
      request('/api/v1/ai/conversations').then((value) =>
        aiConversationSchema.array().parse(value),
      ),
    createAiConversation: (input: AiConversationInput) =>
      request('/api/v1/ai/conversations', { method: 'POST', body: input }).then((value) =>
        aiConversationSchema.parse(value),
      ),
    aiConversation: (id: string) =>
      request(`/api/v1/ai/conversations/${id}`).then((value) =>
        aiConversationDetailSchema.parse(value),
      ),
    updateAiConversation: (conversation: AiConversation, input: AiConversationPatch) =>
      request(`/api/v1/ai/conversations/${conversation.id}`, {
        method: 'PATCH',
        body: input,
        headers: { 'If-Match': `"v${conversation.version}"` },
      }).then((value) => aiConversationSchema.parse(value)),
    deleteAiConversation: (conversation: AiConversation) =>
      request(`/api/v1/ai/conversations/${conversation.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `"v${conversation.version}"` },
      }),
    prepareAiAttachment: (grantId: string, signal?: AbortSignal) =>
      request('/api/v1/ai/attachments', {
        method: 'POST',
        body: { grantId },
        ...(signal ? { signal } : {}),
      }).then((value) => aiAttachmentPreviewSchema.parse(value)),
    discardAiAttachment: (id: string) =>
      request(`/api/v1/ai/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    startAi: (input: AiRequestInput) =>
      request('/api/v1/ai/runs', {
        method: 'POST',
        body: input,
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      }).then((value) => aiRunSchema.parse(value)),
    aiRuns: () => request('/api/v1/ai/runs').then((value) => aiRunSchema.array().parse(value)),
    aiRun: (id: string) =>
      request(`/api/v1/ai/runs/${id}`).then((value) => aiRunSchema.parse(value)),
    aiToolCalls: (runId: string) =>
      request(`/api/v1/ai/runs/${runId}/tools`).then((value) =>
        aiToolCallSchema.array().parse(value),
      ),
    aiApprovals: () =>
      request('/api/v1/ai/approvals').then((value) => aiApprovalSchema.array().parse(value)),
    decideApproval: (id: string, decision: 'approve_once' | 'reject', argsHash: string) =>
      request(`/api/v1/ai/approvals/${id}/decision`, {
        method: 'POST',
        body: { decision, argsHash },
      }).then((value) => aiRunSchema.parse(value)),
    cancelAi: (id: string) => request(`/api/v1/ai/runs/${id}/cancel`, { method: 'POST' }),
    diagnostics: () =>
      request('/api/v1/diagnostics/runtime').then((value) => diagnosticsSchema.parse(value)),
    updaterStatus: () =>
      request('/api/v1/desktop/updater').then((value) => updaterStatusSchema.parse(value)),
    performUpdaterAction: (action: UpdaterAction) =>
      request('/api/v1/desktop/updater/actions', {
        method: 'POST',
        body: updaterActionSchema.parse({ action }),
      }).then((value) => updaterStatusSchema.parse(value)),
    exportDiagnostics: (grantId: string) =>
      request('/api/v1/diagnostics/export', { method: 'POST', body: { grantId } }).then((value) =>
        diagnosticExportSchema.parse(value),
      ),
    openExternal: (url: string) =>
      request('/api/v1/external-url/open', { method: 'POST', body: { url } }),
    windowStatus: () =>
      request('/api/v1/desktop/window').then((value) => desktopWindowStateSchema.parse(value)),
    performWindowAction: (action: DesktopWindowAction) =>
      request('/api/v1/desktop/window/actions', { method: 'POST', body: { action } }).then(
        (value) => desktopWindowActionResultSchema.parse(value),
      ),
    windowPreferences: () =>
      request('/api/v1/desktop/window/preferences').then((value) =>
        desktopWindowPreferencesResultSchema.parse(value),
      ),
    updateWindowPreferences: (input: DesktopWindowPreferencesPatch) =>
      request('/api/v1/desktop/window/preferences', {
        method: 'PATCH',
        body: desktopWindowPreferencesPatchSchema.parse(input),
      }).then((value) => desktopWindowPreferencesResultSchema.parse(value)),
    async eventStream(
      kind: 'domain' | 'realtime',
      onEvent: (event: { type: string; data: unknown; id?: string }) => void,
      signal?: AbortSignal,
    ) {
      let after: string | undefined;
      let failures = 0;
      while (!disposed && !signal?.aborted) {
        const currentEpoch = epoch;
        try {
          const connection = await connect();
          const url = new URL(`/api/v1/events/${kind}`, connection.baseUrl);
          if (kind === 'domain' && after) url.searchParams.set('after', after);
          const response = await transport(
            new Request(url, {
              headers: {
                Authorization: `Bearer ${connection.sessionToken}`,
                'X-Runtime-Generation': connection.generation,
              },
              signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]),
            }),
          );
          verifyGeneration(response, connection.generation, currentEpoch);
          if (!response.ok || !response.body) throw await responseError(response);
          await consumeSse(response.body, (event) => {
            if (event.type === 'cursor.invalid') after = undefined;
            else if (kind === 'domain' && event.id) after = event.id;
            onEvent(event);
          });
          failures = 0;
        } catch (error) {
          if (signal?.aborted || disposed) return;
          if (error instanceof RuntimeClientError && error.code === 'UNAUTHORIZED') reset();
          failures += 1;
        }
        await abortableDelay(Math.min(2_000, 100 * 2 ** Math.min(failures, 4)), signal);
      }
    },
    reconnect: reset,
    dispose() {
      disposed = true;
      reset();
    },
  };
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function responseError(response: Response) {
  const parsed = problemSchema.safeParse(
    await response
      .clone()
      .json()
      .catch(() => undefined),
  );
  return new RuntimeClientError(
    parsed.success ? parsed.data.code : 'HTTP_ERROR',
    parsed.success ? parsed.data.title : 'Runtime request failed',
    response.status,
    parsed.success ? parsed.data.traceId : undefined,
  );
}

async function consumeSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: { type: string; data: unknown; id?: string }) => void,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r/g, '');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let type = 'message';
        let id: string | undefined;
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('id:')) id = line.slice(3).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length)
          onEvent({
            type,
            data: JSON.parse(data.join('\n')),
            ...(id ? { id } : {}),
          });
      }
    }
  } finally {
    reader.releaseLock();
  }
}
