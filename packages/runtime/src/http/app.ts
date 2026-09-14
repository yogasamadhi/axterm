import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { stream, streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import {
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  capabilitiesSchema,
  healthSchema,
  problemSchema,
  runtimeMetadataSchema,
  versionSchema,
  createHostGroupSchema,
  createHostSchema,
  hostGroupSchema,
  hostSchema,
  knownHostKeySchema,
  idSchema,
  settingsSchema,
  updateHostGroupSchema,
  updateHostSchema,
  updateSettingsSchema,
  createTerminalSchema,
  startTerminalRecordingSchema,
  terminalRecordingSchema,
  terminalTransferActionSchema,
  terminalTransferStateSchema,
  terminalInformationSnapshotSchema,
  terminalSessionSchema,
  createCredentialSchema,
  replaceCredentialSchema,
  credentialMetadataSchema,
  connectionSchema,
  createConnectionSchema,
  ftpConnectionSchema,
  createFtpConnectionSchema,
  serialPortInfoSchema,
  createRdpSessionSchema,
  rdpCredentialBootstrapSchema,
  rdpSessionSchema,
  resizeRdpSessionSchema,
  createVncSessionSchema,
  vncCredentialBootstrapSchema,
  vncSessionSchema,
  createSpiceSessionSchema,
  spiceCredentialBootstrapSchema,
  spiceSessionSchema,
  createWebSessionSchema,
  webSessionActionSchema,
  webSessionAuthResponseSchema,
  webSessionPresentationSchema,
  webSessionSchema,
  deepLinkIntentSchema,
  deepLinkReceiptSchema,
  enqueueDeepLinkSchema,
  interactionSchema,
  interactionResponseSchema,
  openExternalUrlSchema,
  chmodPathSchema,
  droppedFileImportHeadersSchema,
  fileGrantRequestSchema,
  insertGrantedPathsResultSchema,
  insertGrantedPathsSchema,
  pathInputSchema,
  remoteFileEntrySchema,
  remoteEntriesOperationRequestSchema,
  remoteCopyTransferRouteInputSchema,
  remotePathSchema,
  remoteTextSchema,
  renamePathSchema,
  transferRouteInputSchema,
  transferConflictDecisionSchema,
  clearTransfersResultSchema,
  transferSchema,
  writeRemoteTextSchema,
  createExternalEditorSchema,
  externalEditorSessionSchema,
  createFileComparisonSchema,
  fileComparisonSchema,
  importHostsSchema,
  previewSshConfigImportSchema,
  sshConfigImportPreviewSchema,
  commitSshConfigImportSchema,
  sshConfigImportResultSchema,
  sshAgentProbeInputSchema,
  sshAgentStatusSchema,
  quickCommandInputSchema,
  quickCommandPatchSchema,
  quickCommandSchema,
  quickCommandGroupInputSchema,
  quickCommandGroupPatchSchema,
  quickCommandTreeSchema,
  moveQuickCommandTreeNodeSchema,
  batchOperationSchema,
  clearBatchOperationsResultSchema,
  createBatchOperationSchema,
  widgetDefinitionSchema,
  widgetInstanceSchema,
  startLocalFileServerSchema,
  startLocalFtpServerSchema,
  startLocalSshServerSchema,
  startMcpServerSchema,
  renameWidgetInstanceSchema,
  previewFileRenameSchema,
  fileRenamePreviewSchema,
  runFileRenameSchema,
  fileRenameResultSchema,
  triggerCollectionSchema,
  triggerRuleInputSchema,
  triggerRulePatchSchema,
  replaceTriggersSchema,
  terminalProfileInputSchema,
  terminalProfilePatchSchema,
  terminalProfileSchema,
  terminalThemeSchema,
  terminalThemeInputSchema,
  terminalThemePatchSchema,
  cloneTerminalThemeSchema,
  terminalThemeGrantRequestSchema,
  terminalThemeExportResultSchema,
  terminalBackgroundAssetSchema,
  startTunnelSchema,
  tunnelProfileInputSchema,
  tunnelProfilePatchSchema,
  tunnelProfileSchema,
  tunnelSchema,
  aiApprovalDecisionSchema,
  aiApprovalSchema,
  aiAttachmentPrepareSchema,
  aiAttachmentPreviewSchema,
  aiConversationDetailSchema,
  aiConversationInputSchema,
  aiConversationPatchSchema,
  aiConversationSchema,
  aiModelInputSchema,
  aiModelPatchSchema,
  aiModelSchema,
  aiProviderInputSchema,
  aiProviderPatchSchema,
  aiProviderSchema,
  aiProviderTestResultSchema,
  aiRequestSchema,
  aiRunSchema,
  aiToolCallSchema,
  aiUseCaseInputSchema,
  diagnosticsSchema,
  diagnosticLogsSchema,
  diagnosticExportRequestSchema,
  diagnosticExportSchema,
  bookmarkTreeSchema,
  createBookmarkGroupSchema,
  updateBookmarkGroupSchema,
  createBookmarkSchema,
  updateBookmarkSchema,
  moveBookmarkTreeNodeSchema,
  createSshBookmarkSchema,
  updateSshBookmarkSchema,
  sshBookmarkMutationResultSchema,
  deleteSshBookmarkEntryResultSchema,
  deleteSshBookmarkResultSchema,
  clearConnectionHistoryResultSchema,
  connectionHistoryPageQuerySchema,
  connectionHistoryPageSchema,
  deleteConnectionHistoryResultSchema,
  promoteConnectionHistoryResultSchema,
  promoteConnectionHistorySchema,
  reconnectConnectionHistoryResultSchema,
  reconnectConnectionHistorySchema,
  clearCommandHistoryResultSchema,
  commandHistoryPageQuerySchema,
  commandHistoryPageSchema,
  deleteCommandHistoryResultSchema,
  recordCommandHistoryResultSchema,
  recordCommandHistorySchema,
  proxyTestRequestSchema,
  proxyTestResultSchema,
  connectionProfileInputSchema,
  connectionProfilePatchSchema,
  connectionProfileSchema,
  previewElectermDataSchema,
  electermDataPreviewSchema,
  commitElectermDataSchema,
  electermDataImportResultSchema,
  exportElectermDataSchema,
  electermDataExportResultSchema,
  syncProfileInputSchema,
  syncProfilePatchSchema,
  syncProfileSchema,
  syncComparisonSchema,
  runDataSyncSchema,
  syncRunResultSchema,
  commitDataSyncSchema,
  syncCommitResultSchema,
  testSyncProfileResultSchema,
  type RuntimeMetadata,
} from '@workspace/contracts';
import type { RuntimeAuth } from '../bootstrap/auth';
import { ApplicationError, isApplicationError } from '../application/errors';
import { etagFor, type ProductRepository } from '../adapters/sqlite/product-repository';
import { z } from 'zod';
import type { TerminalService } from '../application/terminal-service';
import type { HostCapabilityClient } from '../adapters/host-capability/client';
import type { ConnectionService } from '../application/connection-service';
import type { InteractionService } from '../application/interaction-service';
import type { SftpService } from '../application/sftp-service';
import type { TransferService } from '../application/transfer-service';
import type { RealtimeHub, RealtimeEvent } from '../application/realtime-hub';
import {
  desktopWindowActionResultSchema,
  desktopWindowActionSchema,
  desktopWindowPreferencesPatchSchema,
  desktopWindowPreferencesResultSchema,
  desktopWindowStateSchema,
  fileGrantSchema,
  grantedDirectoryListRequestSchema,
  grantedDirectoryListingSchema,
  grantedEntriesOperationRequestSchema,
  grantedEntryCreateRequestSchema,
  grantedEntryChmodRequestSchema,
  grantedEntryPathRequestSchema,
  grantedEntryPathsRequestSchema,
  grantedEntryRenameRequestSchema,
  grantedTextSchema,
  updaterActionSchema,
  updaterStatusSchema,
} from '@workspace/contracts/desktop';
import type { HostImportService } from '../application/host-import-service';
import type { TerminalProfile, TunnelProfile } from '@workspace/contracts';
import type { TunnelService } from '../application/tunnel-service';
import type { AiService, AiRunEvent } from '../application/ai-service';
import type { AiModel, AiProvider } from '@workspace/contracts';
import type { DiagnosticService } from '../application/diagnostic-service';
import type { Logger } from 'pino';
import type { BookmarkTreeService } from '../application/bookmark-tree-service';
import type { SshBookmarkService } from '../application/ssh-bookmark-service';
import type { ConnectionHistoryService } from '../application/connection-history-service';
import type { ProxyService } from '../application/proxy-service';
import type { CommandHistoryService } from '../application/command-history-service';
import type { ConnectionProfileService } from '../application/connection-profile-service';
import type { ElectermDataService } from '../application/electerm-data-service';
import type { ExternalEditorService } from '../application/external-editor-service';
import type { FileComparisonService } from '../application/file-comparison-service';
import type { FtpConnectionService } from '../application/ftp-connection-service';
import type { TelnetService } from '../application/telnet-service';
import type { SerialService } from '../application/serial-service';
import type { RdpSessionService } from '../application/rdp-session-service';
import type { VncSessionService } from '../application/vnc-session-service';
import type { SpiceSessionService } from '../application/spice-session-service';
import type { WebSessionService } from '../application/web-session-service';
import type { DeepLinkIntentService } from '../application/deep-link-intent-service';
import type { TerminalTransferService } from '../application/terminal-transfer-service';
import type { QuickCommandService } from '../application/quick-command-service';
import type { BatchOperationService } from '../application/batch-operation-service';
import type { TriggerService } from '../application/trigger-service';
import type { TerminalInformationService } from '../application/terminal-information-service';
import type { WidgetService } from '../application/widget-service';
import type { TerminalThemeService } from '../application/terminal-theme-service';
import type { TerminalBackgroundAssetService } from '../application/terminal-background-asset-service';
import type { DataSyncService } from '../application/data-sync-service';

type Env = { Variables: { traceId: string } };
export interface AppOptions {
  auth: RuntimeAuth;
  metadata: RuntimeMetadata;
  appVersion: string;
  getOrigin(): string;
  devOrigin?: string;
  onBootstrapRotated(): void;
  repository: ProductRepository;
  bookmarks: BookmarkTreeService;
  sshBookmarks: SshBookmarkService;
  terminals: TerminalService;
  terminalTransfers: TerminalTransferService;
  terminalInformation: TerminalInformationService;
  widgets: WidgetService;
  hostCapabilities?: HostCapabilityClient;
  connections: ConnectionService;
  proxies: ProxyService;
  connectionHistory: ConnectionHistoryService;
  commandHistory: CommandHistoryService;
  connectionProfiles: ConnectionProfileService;
  quickCommands: QuickCommandService;
  terminalThemes: TerminalThemeService;
  terminalBackgroundAssets: TerminalBackgroundAssetService;
  batchOperations: BatchOperationService;
  triggers: TriggerService;
  electermData: ElectermDataService;
  dataSync: DataSyncService;
  interactions: InteractionService;
  sftp: SftpService;
  ftpConnections: FtpConnectionService;
  ftpFiles: SftpService;
  telnet: TelnetService;
  serial: SerialService;
  rdp: RdpSessionService;
  vnc: VncSessionService;
  spice: SpiceSessionService;
  web: WebSessionService;
  deepLinks: DeepLinkIntentService;
  runtimeIngressToken?: string;
  externalEditors?: ExternalEditorService;
  fileComparisons?: FileComparisonService;
  transfers: TransferService;
  realtime: RealtimeHub;
  hostImporter: HostImportService;
  tunnels: TunnelService;
  ai: AiService;
  diagnostics: DiagnosticService;
  logger: Logger;
  capabilities?: Array<
    | 'runtime.metadata'
    | 'persistence'
    | 'host.manager'
    | 'bookmark.tree'
    | 'connection.history'
    | 'command.history'
    | 'connection.profiles'
    | 'data.electerm'
    | 'quick-command.tree'
    | 'batch-operations'
    | 'terminal.triggers'
    | 'terminal.information'
    | 'widgets'
    | 'widgets.file-renamer'
    | 'widgets.local-file-server'
    | 'widgets.local-ftp-server'
    | 'widgets.local-ssh-server'
    | 'widgets.mcp-server'
    | 'terminal.local'
    | 'terminal.ssh'
    | 'proxy.ssh'
    | 'sftp'
    | 'sftp.recursive'
    | 'sftp.edit'
    | 'sftp.chmod'
    | 'ftp'
    | 'ftps'
    | 'ftp.recursive'
    | 'terminal.telnet'
    | 'terminal.serial'
    | 'terminal.transfers'
    | 'session.rdp'
    | 'session.vnc'
    | 'session.spice'
    | 'session.web'
    | 'tunnels'
    | 'ai'
    | 'ai.tools'
    | 'desktop.window'
    | 'desktop.deep-links'
  >;
}

function problem(
  c: Context<Env>,
  status: 400 | 401 | 403 | 404 | 409 | 412 | 413 | 428 | 429 | 500 | 503,
  code: string,
  title: string,
) {
  return c.json({ type: 'about:blank', title, status, code, traceId: c.get('traceId') }, status, {
    'Content-Type': 'application/problem+json',
  });
}

const errorResponse = {
  description: 'Problem Details',
  content: { 'application/problem+json': { schema: problemSchema } },
};
const errors = {
  400: errorResponse,
  401: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
  412: errorResponse,
  413: errorResponse,
  428: errorResponse,
  429: errorResponse,
  500: errorResponse,
  503: errorResponse,
};
const security = [{ bearerAuth: [] }];

export function createRuntimeApp(options: AppOptions) {
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) return problem(c, 400, 'VALIDATION_ERROR', 'Invalid request');
    },
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
  });
  app.use('*', async (c, next) => {
    c.set('traceId', randomUUID());
    c.header('X-Trace-Id', c.get('traceId'));
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    // Health intentionally discloses no discovery metadata, including in headers.
    if (c.req.path !== '/health') c.header('X-Runtime-Generation', options.metadata.generation);
    const origin = c.req.header('Origin');
    const expected = options.devOrigin ?? options.getOrigin();
    // Host validation also prevents DNS-rebinding access to this loopback service.
    if (c.req.header('Host') !== new URL(options.getOrigin()).host) {
      return problem(c, 403, 'FORBIDDEN', 'Untrusted host');
    }
    if (origin !== undefined && origin !== expected) {
      return problem(c, 403, 'FORBIDDEN', 'Untrusted origin');
    }
    if (origin === expected) {
      c.header('Access-Control-Allow-Origin', expected);
      c.header('Vary', 'Origin');
      c.header(
        'Access-Control-Expose-Headers',
        'X-Runtime-Generation, X-Trace-Id, ETag, X-Host-ETag, X-Connection-History-ETag',
      );
    }
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      c.header(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-Runtime-Generation, X-Axterm-File-Name, X-Axterm-File-Size, If-Match, X-Bookmark-Tree-If-Match, Idempotency-Key, Last-Event-ID',
      );
      return c.body(null, 204);
    }
    const query = new URL(c.req.url).searchParams;
    if (['token', 'auth', 'authorization', 'session'].some((name) => query.has(name)))
      return problem(c, 400, 'VALIDATION_ERROR', 'Credentials are not allowed in URLs');
    await next();
    options.logger.info(
      { traceId: c.get('traceId'), method: c.req.method, route: c.req.path, status: c.res.status },
      'runtime request',
    );
  });
  app.use('*', async (c, next) => {
    const maxSize =
      c.req.path === '/api/v1/auth/bootstrap'
        ? 4_096
        : c.req.path === '/api/v1/file-grants/import'
          ? 4 * 1024 * 1024 * 1024
          : 2_200_000;
    return bodyLimit({
      maxSize,
      onError: (context) => problem(context, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'),
    })(c, next);
  });
  app.use('/api/v1/*', async (c, next) => {
    if (c.req.path === '/api/v1/auth/bootstrap') {
      if (!options.auth.allowAttempt())
        return problem(c, 429, 'RATE_LIMITED', 'Too many authentication attempts');
    } else if (!options.auth.authorize(c.req.header('Authorization'))) {
      return problem(c, 401, 'UNAUTHORIZED', 'Authentication required');
    }
    const generation = c.req.header('X-Runtime-Generation');
    if (generation && generation !== options.metadata.generation) {
      return problem(c, 401, 'STALE_GENERATION', 'Runtime generation changed');
    }
    await next();
  });
  app.openapi(
    createRoute({
      method: 'get',
      path: '/health',
      operationId: 'health',
      responses: {
        200: {
          description: 'Liveness only',
          content: { 'application/json': { schema: healthSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json({ status: 'ok' as const }, 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/auth/bootstrap',
      operationId: 'authBootstrap',
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: bootstrapRequestSchema } },
        },
      },
      responses: {
        200: {
          description: 'Memory-only session',
          content: { 'application/json': { schema: bootstrapResponseSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const token = options.auth.exchange(c.req.valid('json').bootstrapToken);
      if (!token) return problem(c, 401, 'UNAUTHORIZED', 'Bootstrap token is invalid or expired');
      options.onBootstrapRotated();
      return c.json(
        {
          sessionToken: token,
          generation: options.metadata.generation,
          runtimeId: options.metadata.runtimeId,
        },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/auth/logout',
      operationId: 'authLogout',
      security,
      responses: { 204: { description: 'Session revoked' }, ...errors },
    }),
    (c) => {
      options.auth.logout();
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/version',
      operationId: 'getVersion',
      security,
      responses: {
        200: {
          description: 'API compatibility',
          content: { 'application/json': { schema: versionSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json({ apiVersion: 'v1' as const, appVersion: options.appVersion }, 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/runtime',
      operationId: 'getRuntimeMetadata',
      security,
      responses: {
        200: {
          description: 'Runtime metadata',
          content: { 'application/json': { schema: runtimeMetadataSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(options.metadata, 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/capabilities',
      operationId: 'getCapabilities',
      security,
      responses: {
        200: {
          description: 'Implemented capabilities',
          content: { 'application/json': { schema: capabilitiesSchema } },
        },
        ...errors,
      },
    }),
    (c) =>
      c.json(
        {
          apiVersion: 'v1' as const,
          capabilities: options.capabilities ?? [
            'runtime.metadata' as const,
            'persistence' as const,
            'host.manager' as const,
            'bookmark.tree' as const,
            'connection.history' as const,
            'command.history' as const,
            'connection.profiles' as const,
            ...(options.hostCapabilities ? (['data.electerm'] as const) : []),
            ...(options.hostCapabilities ? (['data.sync'] as const) : []),
            'quick-command.tree' as const,
            'batch-operations' as const,
            'terminal.triggers' as const,
            'terminal.information' as const,
            'widgets' as const,
            ...(options.hostCapabilities ? (['widgets.file-renamer'] as const) : []),
            ...(options.hostCapabilities ? (['widgets.local-file-server'] as const) : []),
            ...(options.hostCapabilities ? (['widgets.local-ftp-server'] as const) : []),
            ...(options.hostCapabilities ? (['widgets.local-ssh-server'] as const) : []),
            ...(options.hostCapabilities ? (['widgets.mcp-server'] as const) : []),
            'terminal.local' as const,
            'terminal.ssh' as const,
            'proxy.ssh' as const,
            'sftp' as const,
            'sftp.recursive' as const,
            'sftp.edit' as const,
            'sftp.chmod' as const,
            'ftp' as const,
            'ftps' as const,
            'ftp.recursive' as const,
            'terminal.telnet' as const,
            'terminal.serial' as const,
            ...(options.hostCapabilities ? (['terminal.transfers'] as const) : []),
            'session.rdp' as const,
            'session.vnc' as const,
            'session.spice' as const,
            ...(options.hostCapabilities ? (['session.web'] as const) : []),
            'tunnels' as const,
            'ai' as const,
            'ai.tools' as const,
            ...(options.hostCapabilities ? (['desktop.window'] as const) : []),
            ...(options.runtimeIngressToken ? (['desktop.deep-links'] as const) : []),
          ],
        },
        200,
      ),
  );
  registerBookmarkRoutes(app, options.bookmarks, options.sshBookmarks);
  registerConnectionProfileRoutes(app, options.connectionProfiles);
  registerQuickCommandRoutes(app, options.quickCommands);
  registerTerminalThemeRoutes(app, options.terminalThemes, options.terminalBackgroundAssets);
  registerBatchOperationRoutes(app, options.batchOperations);
  registerWidgetRoutes(app, options.widgets);
  registerTriggerRoutes(app, options.triggers);
  registerElectermDataRoutes(app, options.electermData);
  registerDataSyncRoutes(app, options.dataSync);
  registerHostRoutes(app, options.repository);
  registerTerminalRoutes(
    app,
    options.terminals,
    options.terminalTransfers,
    options.terminalInformation,
    options.connections,
    options.repository,
    options.hostCapabilities,
    options.telnet,
    options.serial,
  );
  registerCredentialRoutes(app, options.hostCapabilities);
  registerConnectionRoutes(app, options.connections, options.interactions);
  registerRdpRoutes(app, options.rdp);
  registerVncRoutes(app, options.vnc);
  registerSpiceRoutes(app, options.spice);
  registerWebRoutes(app, options.web);
  registerDeepLinkRoutes(
    app,
    options.deepLinks,
    options.metadata.generation,
    options.runtimeIngressToken,
  );
  registerFtpRoutes(
    app,
    options.ftpConnections,
    options.ftpFiles,
    options.transfers,
    options.hostCapabilities,
  );
  registerProxyRoutes(app, options.proxies);
  registerConnectionHistoryRoutes(app, options.connectionHistory, options.connections);
  registerCommandHistoryRoutes(app, options.commandHistory);
  registerSftpRoutes(app, options.sftp, options.transfers, options.hostCapabilities);
  registerFileComparisonRoutes(app, options.fileComparisons);
  registerExternalEditorRoutes(app, options.externalEditors);
  registerEventRoutes(app, options.repository, options.realtime);
  registerWorkspaceRoutes(app, options.repository, options.hostImporter);
  registerTunnelRoutes(app, options.repository, options.tunnels);
  registerAiRoutes(app, options.repository, options.ai);
  registerDiagnosticRoutes(app, options.diagnostics);
  registerNativeCapabilityRoutes(app, options.hostCapabilities);
  app.notFound((c) => problem(c, 404, 'NOT_FOUND', 'Resource not found'));
  app.onError((error, c) => {
    // Never echo parser input, tokens, paths, stack traces or exception messages.
    if (isApplicationError(error)) return problem(c, error.status, error.code, error.message);
    if ('status' in error && error.status === 400)
      return problem(c, 400, 'VALIDATION_ERROR', 'Invalid request');
    options.logger.warn(
      { traceId: c.get('traceId'), route: c.req.path, err: error },
      'runtime request failed',
    );
    return problem(c, 500, 'INTERNAL_ERROR', 'The request could not be completed');
  });
  return app;
}

function registerElectermDataRoutes(app: OpenAPIHono<Env>, service: ElectermDataService) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/data/electerm/previews',
      operationId: 'previewElectermData',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: previewElectermDataSchema } },
        },
      },
      responses: {
        200: {
          description: 'Bounded Electerm migration preview with field-level mapping report',
          content: { 'application/json': { schema: electermDataPreviewSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await service.preview(c.req.valid('json').grantId), 200),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/data/electerm/previews/{id}',
      operationId: 'cancelElectermDataPreview',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Electerm migration preview discarded' }, ...errors },
    }),
    (c) => {
      service.cancel(c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/data/electerm/imports',
      operationId: 'commitElectermDataImport',
      security,
      request: {
        headers: bookmarkTreeMutationHeadersSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: commitElectermDataSchema } },
        },
      },
      responses: {
        201: {
          description: 'Electerm data imported as one transactional migration',
          content: { 'application/json': { schema: electermDataImportResultSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const result = await service.commit(c.req.valid('json').previewId, c.req.header('If-Match'));
      c.header('ETag', result.tree.etag);
      return c.json(result, 201);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/data/electerm/exports',
      operationId: 'exportElectermData',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: exportElectermDataSchema } },
        },
      },
      responses: {
        201: {
          description: 'Electerm-compatible portable data written to a granted path',
          content: { 'application/json': { schema: electermDataExportResultSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await service.export(c.req.valid('json').grantId), 201),
  );
}

const syncProfileMutationHeadersSchema = z.object({
  'If-Match': z
    .string()
    .regex(/^"v\d+"$/)
    .openapi({ param: { name: 'If-Match', in: 'header' }, example: '"v1"' }),
});

function registerDataSyncRoutes(app: OpenAPIHono<Env>, service: DataSyncService) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/sync/profiles',
      operationId: 'listSyncProfiles',
      security,
      responses: {
        200: {
          description: 'Configured sync profiles without credential references',
          content: { 'application/json': { schema: syncProfileSchema.array() } },
        },
        ...errors,
      },
    }),
    (c) => c.json(service.list(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/sync/profiles',
      operationId: 'createSyncProfile',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: syncProfileInputSchema } },
        },
      },
      responses: {
        201: {
          description: 'Sync profile created',
          content: { 'application/json': { schema: syncProfileSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const profile = await service.create(c.req.valid('json'));
      c.header('ETag', etagFor(profile.version));
      return c.json(profile, 201);
    },
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/sync/profiles/{id}',
      operationId: 'updateSyncProfile',
      security,
      request: {
        params: idParamsSchema,
        headers: syncProfileMutationHeadersSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: syncProfilePatchSchema } },
        },
      },
      responses: {
        200: {
          description: 'Sync profile updated',
          content: { 'application/json': { schema: syncProfileSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const profile = await service.update(
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.header('If-Match'),
      );
      c.header('ETag', etagFor(profile.version));
      return c.json(profile, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/sync/profiles/{id}',
      operationId: 'deleteSyncProfile',
      security,
      request: { params: idParamsSchema, headers: syncProfileMutationHeadersSchema },
      responses: {
        204: { description: 'Sync profile and its local Vault entries deleted' },
        ...errors,
      },
    }),
    async (c) => {
      await service.delete(c.req.valid('param').id, c.req.header('If-Match'));
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/sync/profiles/{id}/test',
      operationId: 'testSyncProfile',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'Provider connection and remote document validation succeeded',
          content: { 'application/json': { schema: testSyncProfileResultSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await service.test(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/sync/profiles/{id}/comparison',
      operationId: 'compareSyncProfile',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'Per-category local and remote comparison',
          content: { 'application/json': { schema: syncComparisonSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await service.compare(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/sync/profiles/{id}/runs',
      operationId: 'runDataSync',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: runDataSyncSchema } },
        },
      },
      responses: {
        200: {
          description: 'Upload completed or download preview created',
          content: { 'application/json': { schema: syncRunResultSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const input = c.req.valid('json');
      return c.json(await service.run(c.req.valid('param').id, input.direction), 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/sync/profiles/{id}/download-commits',
      operationId: 'commitDataSyncDownload',
      security,
      request: {
        params: idParamsSchema,
        headers: bookmarkTreeMutationHeadersSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: commitDataSyncSchema } },
        },
      },
      responses: {
        200: {
          description: 'Reviewed remote data committed',
          content: { 'application/json': { schema: syncCommitResultSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const result = await service.commitDownload(
        c.req.valid('param').id,
        c.req.valid('json').previewId,
        c.req.header('If-Match'),
      );
      c.header('ETag', etagFor(result.profile.version));
      return c.json(result, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/sync/profiles/{id}/download-preview',
      operationId: 'getDataSyncDownloadPreview',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'Pending remote data preview awaiting explicit confirmation',
          content: { 'application/json': { schema: electermDataPreviewSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(service.pendingDownload(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/sync/profiles/{id}/download-preview',
      operationId: 'cancelDataSyncDownload',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'Pending remote data preview discarded',
          content: { 'application/json': { schema: syncProfileSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(service.cancelDownload(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/sync/profiles/{id}/run',
      operationId: 'cancelDataSyncRun',
      security,
      request: { params: idParamsSchema },
      responses: {
        204: { description: 'Running provider request cancellation requested' },
        ...errors,
      },
    }),
    (c) => {
      service.cancel(c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
}

function registerProxyRoutes(app: OpenAPIHono<Env>, proxies: ProxyService) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/proxy/test',
      operationId: 'testSshProxy',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: proxyTestRequestSchema } },
        },
      },
      responses: {
        200: {
          description: 'Validated proxy tunnel result with safe endpoint metadata',
          content: { 'application/json': { schema: proxyTestResultSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await proxies.test(c.req.valid('json'), c.req.raw.signal), 200),
  );
}

function registerNativeCapabilityRoutes(
  app: OpenAPIHono<Env>,
  host: HostCapabilityClient | undefined,
) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/desktop/updater',
      operationId: 'getDesktopUpdaterStatus',
      security,
      responses: {
        200: {
          description: 'Current Desktop Host updater state',
          content: { 'application/json': { schema: updaterStatusSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      if (!host)
        throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Updater is unavailable', 503);
      return c.json(await host.updaterStatus(), 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/desktop/updater/actions',
      operationId: 'performDesktopUpdaterAction',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: updaterActionSchema } },
        },
      },
      responses: {
        202: {
          description: 'Updater action accepted by Desktop Host',
          content: { 'application/json': { schema: updaterStatusSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      if (!host)
        throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Updater is unavailable', 503);
      return c.json(await host.updaterAction(c.req.valid('json').action), 202);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/external-url/open',
      operationId: 'openExternalUrl',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: openExternalUrlSchema } },
        },
      },
      responses: { 204: { description: 'URL opened by Desktop Host' }, ...errors },
    }),
    async (c) => {
      if (!host)
        throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'External URLs are unavailable', 503);
      await host.openExternal(c.req.valid('json').url);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/desktop/window',
      operationId: 'getDesktopWindowState',
      security,
      responses: {
        200: {
          description: 'Current Axterm window state',
          content: { 'application/json': { schema: desktopWindowStateSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      if (!host)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Window controls are unavailable',
          503,
        );
      return c.json(await host.windowStatus(), 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/desktop/window/actions',
      operationId: 'performDesktopWindowAction',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: desktopWindowActionSchema } },
        },
      },
      responses: {
        202: {
          description: 'Window action accepted by Desktop Host',
          content: { 'application/json': { schema: desktopWindowActionResultSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      if (!host)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Window controls are unavailable',
          503,
        );
      return c.json(await host.performWindowAction(c.req.valid('json').action), 202);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/desktop/window/preferences',
      operationId: 'getDesktopWindowPreferences',
      security,
      responses: {
        200: {
          description: 'Application-local desktop window preferences',
          content: { 'application/json': { schema: desktopWindowPreferencesResultSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      if (!host)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Window preferences are unavailable',
          503,
        );
      return c.json(await host.windowPreferences(), 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/desktop/window/preferences',
      operationId: 'updateDesktopWindowPreferences',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: desktopWindowPreferencesPatchSchema } },
        },
      },
      responses: {
        200: {
          description: 'Updated application-local desktop window preferences',
          content: { 'application/json': { schema: desktopWindowPreferencesResultSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      if (!host)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Window preferences are unavailable',
          503,
        );
      return c.json(await host.updateWindowPreferences(c.req.valid('json')), 200);
    },
  );
}

function registerDiagnosticRoutes(app: OpenAPIHono<Env>, diagnostics: DiagnosticService) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/diagnostics/runtime',
      operationId: 'getRuntimeDiagnostics',
      security,
      responses: {
        200: {
          description: 'Runtime diagnostics',
          content: { 'application/json': { schema: diagnosticsSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await diagnostics.snapshot(), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/diagnostics/logs',
      operationId: 'getDiagnosticLogs',
      security,
      responses: {
        200: {
          description: 'Sanitized diagnostic logs',
          content: { 'application/json': { schema: diagnosticLogsSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await diagnostics.logs(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/diagnostics/export',
      operationId: 'exportDiagnostics',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: diagnosticExportRequestSchema } },
        },
      },
      responses: {
        201: {
          description: 'Sanitized diagnostic bundle written to a granted path',
          content: { 'application/json': { schema: diagnosticExportSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await diagnostics.export(c.req.valid('json').grantId), 201),
  );
}

function registerAiRoutes(app: OpenAPIHono<Env>, repository: ProductRepository, ai: AiService) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ai/providers',
      operationId: 'listAiProviders',
      security,
      responses: {
        200: {
          description: 'AI providers',
          content: { 'application/json': { schema: z.array(aiProviderSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(repository.listJson('ai_providers'), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ai/providers',
      operationId: 'createAiProvider',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: aiProviderInputSchema } },
        },
      },
      responses: {
        201: {
          description: 'AI provider',
          content: { 'application/json': { schema: aiProviderSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(repository.createJson('ai_providers', c.req.valid('json'), 'ai-provider'), 201),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/ai/providers/{id}',
      operationId: 'updateAiProvider',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: aiProviderPatchSchema } },
        },
      },
      responses: {
        200: {
          description: 'AI provider',
          content: { 'application/json': { schema: aiProviderSchema } },
        },
        ...errors,
      },
    }),
    (c) =>
      c.json(
        repository.updateJson<AiProvider>(
          'ai_providers',
          c.req.valid('param').id,
          c.req.valid('json'),
          c.req.header('If-Match'),
          'ai-provider',
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ai/providers/{id}/test',
      operationId: 'testAiProvider',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'AI provider connection result',
          content: { 'application/json': { schema: aiProviderTestResultSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await ai.testProvider(c.req.valid('param').id, c.req.raw.signal), 200),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/ai/providers/{id}',
      operationId: 'deleteAiProvider',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    (c) => {
      repository.deleteJson(
        'ai_providers',
        c.req.valid('param').id,
        c.req.header('If-Match'),
        'ai-provider',
      );
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ai/models',
      operationId: 'listAiModels',
      security,
      responses: {
        200: {
          description: 'AI models',
          content: { 'application/json': { schema: z.array(aiModelSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(repository.listJson('ai_models'), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ai/models',
      operationId: 'createAiModel',
      security,
      request: {
        body: { required: true, content: { 'application/json': { schema: aiModelInputSchema } } },
      },
      responses: {
        201: {
          description: 'AI model',
          content: { 'application/json': { schema: aiModelSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(repository.createJson('ai_models', c.req.valid('json'), 'ai-model'), 201),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/ai/models/{id}',
      operationId: 'updateAiModel',
      security,
      request: {
        params: idParamsSchema,
        body: { required: true, content: { 'application/json': { schema: aiModelPatchSchema } } },
      },
      responses: {
        200: {
          description: 'AI model',
          content: { 'application/json': { schema: aiModelSchema } },
        },
        ...errors,
      },
    }),
    (c) =>
      c.json(
        repository.updateJson<AiModel>(
          'ai_models',
          c.req.valid('param').id,
          c.req.valid('json'),
          c.req.header('If-Match'),
          'ai-model',
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/ai/models/{id}',
      operationId: 'deleteAiModel',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    (c) => {
      repository.deleteJson(
        'ai_models',
        c.req.valid('param').id,
        c.req.header('If-Match'),
        'ai-model',
      );
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ai/conversations',
      operationId: 'listAiConversations',
      security,
      responses: {
        200: {
          description: 'AI conversations ordered by latest activity',
          content: { 'application/json': { schema: z.array(aiConversationSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(ai.conversations(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ai/conversations',
      operationId: 'createAiConversation',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: aiConversationInputSchema } },
        },
      },
      responses: {
        201: {
          description: 'AI conversation',
          content: { 'application/json': { schema: aiConversationSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(ai.createConversation(c.req.valid('json')), 201),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ai/conversations/{id}',
      operationId: 'getAiConversation',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'AI conversation and messages',
          content: { 'application/json': { schema: aiConversationDetailSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(ai.conversation(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/ai/conversations/{id}',
      operationId: 'updateAiConversation',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: aiConversationPatchSchema } },
        },
      },
      responses: {
        200: {
          description: 'AI conversation',
          content: { 'application/json': { schema: aiConversationSchema } },
        },
        ...errors,
      },
    }),
    (c) =>
      c.json(
        ai.updateConversation(
          c.req.valid('param').id,
          c.req.valid('json'),
          c.req.header('If-Match'),
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/ai/conversations/{id}',
      operationId: 'deleteAiConversation',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    (c) => {
      ai.deleteConversation(c.req.valid('param').id, c.req.header('If-Match'));
      return c.body(null, 204);
    },
  );
  for (const useCase of [
    'explain-command',
    'explain-output',
    'generate-command',
    'diagnose',
  ] as const) {
    const useCaseValue = (
      {
        'explain-command': 'explainCommand',
        'explain-output': 'explainOutput',
        'generate-command': 'generateCommand',
        diagnose: 'diagnose',
      } as const
    )[useCase];
    app.openapi(
      createRoute({
        method: 'post',
        path: `/api/v1/ai/${useCase}`,
        operationId: `ai${useCaseValue[0]!.toUpperCase()}${useCaseValue.slice(1)}`,
        security,
        request: {
          body: {
            required: true,
            content: { 'application/json': { schema: aiUseCaseInputSchema } },
          },
        },
        responses: {
          202: { description: 'AI run', content: { 'application/json': { schema: aiRunSchema } } },
          ...errors,
        },
      }),
      (c) =>
        c.json(
          ai.start(
            { ...c.req.valid('json'), useCase: useCaseValue },
            c.req.header('Idempotency-Key'),
          ),
          202,
        ),
    );
  }
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ai/attachments',
      operationId: 'prepareAiAttachment',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: aiAttachmentPrepareSchema } },
        },
      },
      responses: {
        201: {
          description: 'Bounded, redacted AI attachment preview',
          content: { 'application/json': { schema: aiAttachmentPreviewSchema } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(await ai.prepareAttachment(c.req.valid('json').grantId, c.req.raw.signal), 201),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/ai/attachments/{id}',
      operationId: 'discardAiAttachment',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Attachment draft discarded' }, ...errors },
    }),
    (c) => {
      ai.discardAttachment(c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ai/runs',
      operationId: 'startAiRun',
      security,
      request: {
        body: { required: true, content: { 'application/json': { schema: aiRequestSchema } } },
      },
      responses: {
        202: { description: 'AI run', content: { 'application/json': { schema: aiRunSchema } } },
        ...errors,
      },
    }),
    (c) => c.json(ai.start(c.req.valid('json'), c.req.header('Idempotency-Key')), 202),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ai/runs',
      operationId: 'listAiRuns',
      security,
      responses: {
        200: {
          description: 'AI runs',
          content: { 'application/json': { schema: z.array(aiRunSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(ai.list(), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ai/runs/{id}',
      operationId: 'getAiRun',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: { description: 'AI run', content: { 'application/json': { schema: aiRunSchema } } },
        ...errors,
      },
    }),
    (c) => c.json(ai.get(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ai/runs/{id}/tools',
      operationId: 'listAiToolCalls',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'AI tool calls',
          content: { 'application/json': { schema: z.array(aiToolCallSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(ai.toolCalls(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ai/approvals',
      operationId: 'listAiApprovals',
      security,
      responses: {
        200: {
          description: 'AI approvals',
          content: { 'application/json': { schema: z.array(aiApprovalSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(ai.approvals(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ai/approvals/{id}/decision',
      operationId: 'decideAiApproval',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: aiApprovalDecisionSchema } },
        },
      },
      responses: {
        200: { description: 'AI run', content: { 'application/json': { schema: aiRunSchema } } },
        ...errors,
      },
    }),
    async (c) => c.json(await ai.decideApproval(c.req.valid('param').id, c.req.valid('json')), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ai/runs/{id}/cancel',
      operationId: 'cancelAiRun',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Canceled' }, ...errors },
    }),
    (c) => {
      ai.cancel(c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ai/runs/{id}/stream',
      operationId: 'streamAiRun',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: { description: 'AI stream', content: { 'text/event-stream': { schema: z.string() } } },
        ...errors,
      },
    }),
    (c) =>
      streamSSE(c, async (stream) => {
        const queue: AiRunEvent[] = [];
        let overflow = false;
        const unsubscribe = ai.subscribe(c.req.valid('param').id, (event) => {
          if (queue.length >= 200) overflow = true;
          else queue.push(event);
        });
        try {
          while (!stream.aborted && !overflow) {
            const event = queue.shift();
            if (event) {
              await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
              if (
                event.type === 'state' &&
                event.data &&
                typeof event.data === 'object' &&
                'state' in event.data &&
                ['succeeded', 'failed', 'canceled'].includes(String(event.data.state))
              )
                break;
            } else await stream.sleep(50);
          }
        } finally {
          unsubscribe();
        }
      }),
  );
}

function registerTunnelRoutes(
  app: OpenAPIHono<Env>,
  repository: ProductRepository,
  tunnels: TunnelService,
) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/tunnel-profiles',
      operationId: 'listTunnelProfiles',
      security,
      responses: {
        200: {
          description: 'Tunnel profiles',
          content: { 'application/json': { schema: z.array(tunnelProfileSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(repository.listJson('tunnel_profiles'), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/tunnel-profiles',
      operationId: 'createTunnelProfile',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: tunnelProfileInputSchema } },
        },
      },
      responses: {
        201: {
          description: 'Tunnel profile',
          content: { 'application/json': { schema: tunnelProfileSchema } },
        },
        ...errors,
      },
    }),
    (c) =>
      c.json(repository.createJson('tunnel_profiles', c.req.valid('json'), 'tunnel-profile'), 201),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/tunnel-profiles/{id}',
      operationId: 'updateTunnelProfile',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: tunnelProfilePatchSchema } },
        },
      },
      responses: {
        200: {
          description: 'Tunnel profile',
          content: { 'application/json': { schema: tunnelProfileSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const id = c.req.valid('param').id;
      const current = repository.getJson<TunnelProfile>('tunnel_profiles', id);
      const input = tunnelProfileInputSchema.parse({
        name: current.name,
        hostId: current.hostId,
        type: current.type,
        bindHost: current.bindHost,
        bindPort: current.bindPort,
        targetHost: current.targetHost,
        targetPort: current.targetPort,
        allowNonLoopback: current.allowNonLoopback,
        ...c.req.valid('json'),
      });
      return c.json(
        repository.updateJson<TunnelProfile>(
          'tunnel_profiles',
          id,
          input,
          c.req.header('If-Match'),
          'tunnel-profile',
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/tunnel-profiles/{id}',
      operationId: 'deleteTunnelProfile',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    (c) => {
      repository.deleteJson(
        'tunnel_profiles',
        c.req.valid('param').id,
        c.req.header('If-Match'),
        'tunnel-profile',
      );
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/tunnels',
      operationId: 'listTunnels',
      security,
      responses: {
        200: {
          description: 'Active tunnels',
          content: { 'application/json': { schema: z.array(tunnelSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(tunnels.list(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/tunnels',
      operationId: 'startTunnel',
      security,
      request: {
        body: { required: true, content: { 'application/json': { schema: startTunnelSchema } } },
      },
      responses: {
        201: {
          description: 'Started tunnel',
          content: { 'application/json': { schema: tunnelSchema } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(await tunnels.start(c.req.valid('json'), c.req.header('Idempotency-Key')), 201),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/tunnels/{id}',
      operationId: 'stopTunnel',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Stopped' }, ...errors },
    }),
    async (c) => {
      await tunnels.close(c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
}

function registerEventRoutes(
  app: OpenAPIHono<Env>,
  repository: ProductRepository,
  realtime: RealtimeHub,
) {
  const eventQuerySchema = z
    .object({ after: z.coerce.number().int().nonnegative().default(0) })
    .strict();
  const eventResponse = {
    200: {
      description: 'Server-sent event stream',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    ...errors,
  };
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/events/domain',
      operationId: 'streamDomainEvents',
      security,
      request: { query: eventQuerySchema },
      responses: eventResponse,
    }),
    (c) =>
      streamSSE(c, async (stream) => {
        const headerCursor = Number(c.req.header('Last-Event-ID') ?? 0);
        let cursor = Math.max(
          c.req.valid('query').after,
          Number.isSafeInteger(headerCursor) ? headerCursor : 0,
        );
        const bounds = repository.eventBounds();
        if (
          cursor > bounds.latest ||
          (cursor > 0 && bounds.earliest > 0 && cursor < bounds.earliest - 1)
        ) {
          await stream.writeSSE({
            event: 'cursor.invalid',
            data: JSON.stringify({
              code: 'EVENT_CURSOR_INVALID',
              earliest: bounds.earliest,
              latest: bounds.latest,
            }),
          });
          return;
        }
        let lastHeartbeat = Date.now();
        while (!stream.aborted) {
          const events = repository.listEvents(cursor, 200);
          for (const event of events) {
            await stream.writeSSE({
              id: String(event.cursor),
              event: event.type,
              data: JSON.stringify(event),
            });
            cursor = event.cursor;
          }
          if (Date.now() - lastHeartbeat >= 15_000) {
            await stream.writeSSE({ event: 'heartbeat', data: '{}' });
            lastHeartbeat = Date.now();
          }
          await stream.sleep(events.length === 200 ? 0 : 500);
        }
      }),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/events/realtime',
      operationId: 'streamRealtimeEvents',
      security,
      responses: eventResponse,
    }),
    (c) =>
      streamSSE(c, async (stream) => {
        const queue: RealtimeEvent[] = [];
        let overflow = false;
        const unsubscribe = realtime.subscribe((event) => {
          if (queue.length >= 100) overflow = true;
          else queue.push(event);
        });
        let heartbeat = Date.now();
        try {
          while (!stream.aborted && !overflow) {
            const event = queue.shift();
            if (event)
              await stream.writeSSE({
                event: event.type,
                data: JSON.stringify(event.data),
              });
            else if (Date.now() - heartbeat >= 15_000) {
              await stream.writeSSE({ event: 'heartbeat', data: '{}' });
              heartbeat = Date.now();
            } else await stream.sleep(100);
          }
          if (overflow && !stream.aborted)
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ code: 'SLOW_CONSUMER' }),
            });
        } finally {
          unsubscribe();
        }
      }),
  );
}

const connectionParamsSchema = z.object({ connectionId: idSchema }).strict();
const connectionPathQuerySchema = z.object({ path: remotePathSchema }).strict();
const droppedFileRouteHeadersSchema = z.object({
  'X-Axterm-File-Name': z.string().openapi({ param: { name: 'X-Axterm-File-Name', in: 'header' } }),
  'X-Axterm-File-Size': z.coerce
    .number()
    .openapi({ param: { name: 'X-Axterm-File-Size', in: 'header' } }),
});
function registerFileComparisonRoutes(
  app: OpenAPIHono<Env>,
  fileComparisons: FileComparisonService | undefined,
) {
  const requireFileComparisons = () => {
    if (!fileComparisons)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'File comparison is unavailable', 503);
    return fileComparisons;
  };
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/file-comparisons',
      operationId: 'compareFiles',
      description:
        'Compares two authorized local or connected remote files with bounded UTF-8 content.',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: createFileComparisonSchema } },
        },
      },
      responses: {
        200: {
          description: 'File comparison result',
          content: { 'application/json': { schema: fileComparisonSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await requireFileComparisons().compare(c.req.valid('json')), 200),
  );
}

function registerFtpRoutes(
  app: OpenAPIHono<Env>,
  connections: FtpConnectionService,
  files: SftpService,
  transfers: TransferService,
  host: HostCapabilityClient | undefined,
) {
  const requireHost = () => {
    if (!host)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'File grants are unavailable', 503);
    return host;
  };
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ftp/connections',
      operationId: 'listFtpConnections',
      security,
      responses: {
        200: {
          description: 'FTP connections',
          content: { 'application/json': { schema: z.array(ftpConnectionSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(connections.list(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ftp/connections',
      operationId: 'createFtpConnection',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: createFtpConnectionSchema } },
        },
      },
      responses: {
        201: {
          description: 'FTP connection',
          content: { 'application/json': { schema: ftpConnectionSchema } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(await connections.create(c.req.valid('json').bookmarkId, c.req.raw.signal), 201),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ftp/connections/{connectionId}',
      operationId: 'getFtpConnection',
      security,
      request: { params: connectionParamsSchema },
      responses: {
        200: {
          description: 'FTP connection',
          content: { 'application/json': { schema: ftpConnectionSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(connections.get(c.req.valid('param').connectionId), 200),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/ftp/connections/{connectionId}',
      operationId: 'closeFtpConnection',
      security,
      request: { params: connectionParamsSchema },
      responses: { 204: { description: 'Closed' }, ...errors },
    }),
    async (c) => {
      await connections.close(c.req.valid('param').connectionId);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/ftp/{connectionId}/list',
      operationId: 'listFtpFiles',
      security,
      request: { params: connectionParamsSchema, query: connectionPathQuerySchema },
      responses: {
        200: {
          description: 'FTP directory entries',
          content: { 'application/json': { schema: z.array(remoteFileEntrySchema) } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(await files.list(c.req.valid('param').connectionId, c.req.valid('query').path), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ftp/{connectionId}/mkdir',
      operationId: 'createFtpDirectory',
      security,
      request: {
        params: connectionParamsSchema,
        body: { required: true, content: { 'application/json': { schema: pathInputSchema } } },
      },
      responses: { 204: { description: 'Created' }, ...errors },
    }),
    async (c) => {
      await files.mkdir(c.req.valid('param').connectionId, c.req.valid('json').path);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ftp/{connectionId}/touch',
      operationId: 'createFtpFile',
      security,
      request: {
        params: connectionParamsSchema,
        body: { required: true, content: { 'application/json': { schema: pathInputSchema } } },
      },
      responses: { 204: { description: 'Created' }, ...errors },
    }),
    async (c) => {
      await files.touch(c.req.valid('param').connectionId, c.req.valid('json').path);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ftp/{connectionId}/rename',
      operationId: 'renameFtpPath',
      security,
      request: {
        params: connectionParamsSchema,
        body: { required: true, content: { 'application/json': { schema: renamePathSchema } } },
      },
      responses: { 204: { description: 'Renamed' }, ...errors },
    }),
    async (c) => {
      const input = c.req.valid('json');
      await files.rename(c.req.valid('param').connectionId, input.from, input.to);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/ftp/{connectionId}/path',
      operationId: 'deleteFtpPath',
      security,
      request: { params: connectionParamsSchema, query: connectionPathQuerySchema },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await files.delete(c.req.valid('param').connectionId, c.req.valid('query').path);
      return c.body(null, 204);
    },
  );
  for (const direction of ['upload', 'download'] as const) {
    app.openapi(
      createRoute({
        method: 'post',
        path: `/api/v1/ftp/{connectionId}/${direction}`,
        operationId: direction === 'upload' ? 'uploadFtp' : 'downloadFtp',
        security,
        request: {
          params: connectionParamsSchema,
          body: {
            required: true,
            content: { 'application/json': { schema: transferRouteInputSchema } },
          },
        },
        responses: {
          202: {
            description: 'FTP transfer queued',
            content: { 'application/json': { schema: transferSchema } },
          },
          ...errors,
        },
      }),
      (c) => {
        requireHost();
        return c.json(
          transfers.create(
            {
              ...c.req.valid('json'),
              connectionId: c.req.valid('param').connectionId,
              direction,
              protocol: 'ftp',
            },
            c.req.header('Idempotency-Key'),
          ),
          202,
        );
      },
    );
  }
}

function registerSftpRoutes(
  app: OpenAPIHono<Env>,
  sftp: SftpService,
  transfers: TransferService,
  host: HostCapabilityClient | undefined,
) {
  const requireHost = () => {
    if (!host)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'File grants are unavailable', 503);
    return host;
  };
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/file-grants',
      operationId: 'createFileGrant',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: fileGrantRequestSchema } },
        },
      },
      responses: {
        201: {
          description: 'File grant',
          content: { 'application/json': { schema: fileGrantSchema } },
        },
        204: { description: 'Dialog canceled' },
        ...errors,
      },
    }),
    async (c) => {
      const input = c.req.valid('json');
      const grant =
        input.kind === 'home-directory'
          ? await requireHost().openLocalDirectory()
          : input.kind === 'directory-path'
            ? await requireHost().openLocalDirectory(input.path)
            : await requireHost().openDialog(input.kind);
      return grant ? c.json(grant, 201) : c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/file-grants/import',
      operationId: 'importDroppedFileGrant',
      description:
        'Streams one user-dropped browser File into a temporary, generation-bound Desktop File Grant.',
      security,
      request: { headers: droppedFileRouteHeadersSchema },
      responses: {
        201: {
          description: 'Temporary dropped-file grant',
          content: { 'application/json': { schema: fileGrantSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const body = c.req.raw.body;
      if (!body)
        throw new ApplicationError('VALIDATION_ERROR', 'Dropped file body is required', 400);
      const headers = droppedFileImportHeadersSchema.parse(c.req.valid('header'));
      const grant = await requireHost().importDroppedFile(
        decodeDroppedFileName(headers['X-Axterm-File-Name']),
        headers['X-Axterm-File-Size'],
        body,
        c.req.raw.signal,
      );
      return c.json(grant, 201);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/file-grants/{ref}/list',
      operationId: 'listGrantedDirectory',
      description:
        'Lists one relative directory within a generation-bound Desktop directory grant.',
      security,
      request: {
        params: credentialParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: grantedDirectoryListRequestSchema } },
        },
      },
      responses: {
        200: {
          description: 'Granted local directory entries without an absolute path',
          content: { 'application/json': { schema: grantedDirectoryListingSchema } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        await requireHost().listGrantedDirectory(
          c.req.valid('param').ref,
          c.req.valid('json').path,
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/file-grants/{ref}/read-text',
      operationId: 'readGrantedText',
      security,
      request: { params: credentialParamsSchema },
      responses: {
        200: {
          description: 'Bounded UTF-8 text from the granted file',
          content: { 'application/json': { schema: grantedTextSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await requireHost().readGrantedText(c.req.valid('param').ref), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/file-grants/{ref}/entries',
      operationId: 'createGrantedEntry',
      description: 'Creates an empty file or directory inside an authorized local directory.',
      security,
      request: {
        params: credentialParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: grantedEntryCreateRequestSchema } },
        },
      },
      responses: { 204: { description: 'Created' }, ...errors },
    }),
    async (c) => {
      await requireHost().createGrantedEntry(c.req.valid('param').ref, c.req.valid('json'));
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/file-grants/{ref}/rename',
      operationId: 'renameGrantedEntry',
      description: 'Renames one entry without exposing its absolute local path.',
      security,
      request: {
        params: credentialParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: grantedEntryRenameRequestSchema } },
        },
      },
      responses: { 204: { description: 'Renamed' }, ...errors },
    }),
    async (c) => {
      await requireHost().renameGrantedEntry(c.req.valid('param').ref, c.req.valid('json'));
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/file-grants/{ref}/chmod',
      operationId: 'chmodGrantedEntry',
      description: 'Changes mode bits on one non-symlink entry in an authorized local directory.',
      security,
      request: {
        params: credentialParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: grantedEntryChmodRequestSchema } },
        },
      },
      responses: { 204: { description: 'Permissions changed' }, ...errors },
    }),
    async (c) => {
      const input = c.req.valid('json');
      await requireHost().chmodGrantedEntry(c.req.valid('param').ref, input.path, input.mode);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/file-grants/{ref}/delete',
      operationId: 'deleteGrantedEntry',
      description: 'Deletes one entry inside an authorized local directory.',
      security,
      request: {
        params: credentialParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: grantedEntryPathRequestSchema } },
        },
      },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await requireHost().deleteGrantedEntry(c.req.valid('param').ref, c.req.valid('json').path);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/file-grants/{ref}/open',
      operationId: 'openGrantedEntry',
      description: 'Opens an authorized local entry with its system default application.',
      security,
      request: {
        params: credentialParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: grantedEntryPathRequestSchema } },
        },
      },
      responses: { 204: { description: 'Opened' }, ...errors },
    }),
    async (c) => {
      await requireHost().openGrantedEntry(c.req.valid('param').ref, c.req.valid('json').path);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/file-grants/{ref}/reveal',
      operationId: 'revealGrantedEntry',
      description: 'Reveals an authorized local entry in the native file manager.',
      security,
      request: {
        params: credentialParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: grantedEntryPathRequestSchema } },
        },
      },
      responses: { 204: { description: 'Revealed' }, ...errors },
    }),
    async (c) => {
      await requireHost().revealGrantedEntry(c.req.valid('param').ref, c.req.valid('json').path);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/file-grants/{ref}/copy-path',
      operationId: 'copyGrantedEntryPaths',
      description: 'Copies authorized absolute local paths inside Desktop Host.',
      security,
      request: {
        params: credentialParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: grantedEntryPathsRequestSchema } },
        },
      },
      responses: { 204: { description: 'Copied' }, ...errors },
    }),
    async (c) => {
      await requireHost().copyGrantedEntryPaths(
        c.req.valid('param').ref,
        c.req.valid('json').paths,
      );
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/file-grants/{ref}/operate',
      operationId: 'operateGrantedEntries',
      description: 'Copies or moves entries within one authorized local directory grant.',
      security,
      request: {
        params: credentialParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: grantedEntriesOperationRequestSchema } },
        },
      },
      responses: { 204: { description: 'Operation completed' }, ...errors },
    }),
    async (c) => {
      await requireHost().operateGrantedEntries(c.req.valid('param').ref, c.req.valid('json'));
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/file-grants/{ref}',
      operationId: 'revokeFileGrant',
      security,
      request: { params: credentialParamsSchema },
      responses: { 204: { description: 'Revoked' }, ...errors },
    }),
    async (c) => {
      await requireHost().revokeGrant(c.req.valid('param').ref);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/sftp/{connectionId}/home',
      operationId: 'getRemoteHomeDirectory',
      security,
      request: { params: connectionParamsSchema },
      responses: {
        200: {
          description: 'Canonical home directory for the authenticated SSH account',
          content: { 'application/json': { schema: pathInputSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await sftp.home(c.req.valid('param').connectionId), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/sftp/{connectionId}/list',
      operationId: 'listRemoteFiles',
      security,
      request: { params: connectionParamsSchema, query: connectionPathQuerySchema },
      responses: {
        200: {
          description: 'Remote entries',
          content: { 'application/json': { schema: z.array(remoteFileEntrySchema) } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(await sftp.list(c.req.valid('param').connectionId, c.req.valid('query').path), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/sftp/{connectionId}/stat',
      operationId: 'statRemoteFile',
      security,
      request: { params: connectionParamsSchema, query: connectionPathQuerySchema },
      responses: {
        200: {
          description: 'Remote entry',
          content: { 'application/json': { schema: remoteFileEntrySchema } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(await sftp.stat(c.req.valid('param').connectionId, c.req.valid('query').path), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/sftp/{connectionId}/mkdir',
      operationId: 'createRemoteDirectory',
      security,
      request: {
        params: connectionParamsSchema,
        body: { required: true, content: { 'application/json': { schema: pathInputSchema } } },
      },
      responses: { 204: { description: 'Created' }, ...errors },
    }),
    async (c) => {
      await sftp.mkdir(c.req.valid('param').connectionId, c.req.valid('json').path);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/sftp/{connectionId}/touch',
      operationId: 'createRemoteFile',
      security,
      request: {
        params: connectionParamsSchema,
        body: { required: true, content: { 'application/json': { schema: pathInputSchema } } },
      },
      responses: { 204: { description: 'Created' }, ...errors },
    }),
    async (c) => {
      await sftp.touch(c.req.valid('param').connectionId, c.req.valid('json').path);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/sftp/{connectionId}/rename',
      operationId: 'renameRemotePath',
      security,
      request: {
        params: connectionParamsSchema,
        body: { required: true, content: { 'application/json': { schema: renamePathSchema } } },
      },
      responses: { 204: { description: 'Renamed' }, ...errors },
    }),
    async (c) => {
      const body = c.req.valid('json');
      await sftp.rename(c.req.valid('param').connectionId, body.from, body.to);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/sftp/{connectionId}/path',
      operationId: 'deleteRemotePath',
      security,
      request: { params: connectionParamsSchema, query: connectionPathQuerySchema },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await sftp.delete(c.req.valid('param').connectionId, c.req.valid('query').path);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/sftp/{connectionId}/operate',
      operationId: 'operateRemoteEntries',
      description: 'Copies or moves files and directories within one SFTP connection.',
      security,
      request: {
        params: connectionParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: remoteEntriesOperationRequestSchema } },
        },
      },
      responses: { 204: { description: 'Operation completed' }, ...errors },
    }),
    async (c) => {
      await sftp.operate(c.req.valid('param').connectionId, c.req.valid('json'));
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/sftp/{connectionId}/chmod',
      operationId: 'chmodRemotePath',
      security,
      request: {
        params: connectionParamsSchema,
        body: { required: true, content: { 'application/json': { schema: chmodPathSchema } } },
      },
      responses: { 204: { description: 'Permissions changed' }, ...errors },
    }),
    async (c) => {
      const body = c.req.valid('json');
      await sftp.chmod(c.req.valid('param').connectionId, body.path, body.mode);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/sftp/{connectionId}/text',
      operationId: 'readRemoteText',
      security,
      request: { params: connectionParamsSchema, query: connectionPathQuerySchema },
      responses: {
        200: {
          description: 'Remote text',
          content: { 'application/json': { schema: remoteTextSchema } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        await sftp.readText(c.req.valid('param').connectionId, c.req.valid('query').path),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/sftp/{connectionId}/text',
      operationId: 'writeRemoteText',
      security,
      request: {
        params: connectionParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: writeRemoteTextSchema } },
        },
      },
      responses: {
        200: {
          description: 'Saved remote text',
          content: { 'application/json': { schema: remoteTextSchema } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(await sftp.writeText(c.req.valid('param').connectionId, c.req.valid('json')), 200),
  );
  for (const direction of ['upload', 'download'] as const) {
    app.openapi(
      createRoute({
        method: 'post',
        path: `/api/v1/sftp/{connectionId}/${direction}`,
        operationId: direction === 'upload' ? 'uploadRemote' : 'downloadRemote',
        security,
        request: {
          params: connectionParamsSchema,
          body: {
            required: true,
            content: { 'application/json': { schema: transferRouteInputSchema } },
          },
        },
        responses: {
          202: {
            description: 'Transfer queued',
            content: { 'application/json': { schema: transferSchema } },
          },
          ...errors,
        },
      }),
      (c) =>
        c.json(
          transfers.create(
            {
              ...c.req.valid('json'),
              connectionId: c.req.valid('param').connectionId,
              direction,
              protocol: 'sftp',
            },
            c.req.header('Idempotency-Key'),
          ),
          202,
        ),
    );
  }
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/remote-transfers',
      operationId: 'copyRemoteToRemote',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: remoteCopyTransferRouteInputSchema } },
        },
      },
      responses: {
        202: {
          description: 'Remote-to-remote transfer queued',
          content: { 'application/json': { schema: transferSchema } },
        },
        ...errors,
      },
    }),
    (c) =>
      c.json(
        transfers.create(
          { ...c.req.valid('json'), direction: 'remote-copy' },
          c.req.header('Idempotency-Key'),
        ),
        202,
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/transfers',
      operationId: 'listTransfers',
      security,
      responses: {
        200: {
          description: 'Transfers',
          content: { 'application/json': { schema: z.array(transferSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(transfers.list(), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/transfers/{id}',
      operationId: 'getTransfer',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'Transfer',
          content: { 'application/json': { schema: transferSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(transfers.get(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/transfers/clear',
      operationId: 'clearCompletedTransfers',
      security,
      responses: {
        200: {
          description: 'Completed transfer history cleared',
          content: { 'application/json': { schema: clearTransfersResultSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json({ cleared: transfers.clearCompleted() }, 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/transfers/{id}/cancel',
      operationId: 'cancelTransfer',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Canceled' }, ...errors },
    }),
    (c) => {
      transfers.cancel(c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/transfers/{id}/retry',
      operationId: 'retryTransfer',
      security,
      request: { params: idParamsSchema },
      responses: {
        202: {
          description: 'Retried',
          content: { 'application/json': { schema: transferSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(transfers.retry(c.req.valid('param').id), 202),
  );
  for (const action of ['pause', 'resume'] as const) {
    app.openapi(
      createRoute({
        method: 'post',
        path: `/api/v1/transfers/{id}/${action}`,
        operationId: action === 'pause' ? 'pauseTransfer' : 'resumeTransfer',
        security,
        request: { params: idParamsSchema },
        responses: { 204: { description: `Transfer ${action} accepted` }, ...errors },
      }),
      (c) => {
        transfers[action](c.req.valid('param').id);
        return c.body(null, 204);
      },
    );
  }
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/transfers/{id}/conflict',
      operationId: 'resolveTransferConflict',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: transferConflictDecisionSchema } },
        },
      },
      responses: { 204: { description: 'Conflict decision accepted' }, ...errors },
    }),
    (c) => {
      transfers.decideConflict(c.req.valid('param').id, c.req.valid('json'));
      return c.body(null, 204);
    },
  );
}

function registerExternalEditorRoutes(
  app: OpenAPIHono<Env>,
  externalEditors: ExternalEditorService | undefined,
) {
  const service = () => {
    if (!externalEditors)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'External editing requires the Desktop Host',
        503,
      );
    return externalEditors;
  };
  const sessionParams = z.object({ id: idSchema }).strict();
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/sftp/{connectionId}/external-editors',
      operationId: 'createExternalEditor',
      security,
      request: {
        params: connectionParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: createExternalEditorSchema } },
        },
      },
      responses: {
        201: {
          description: 'External editor session created and opened',
          content: { 'application/json': { schema: externalEditorSessionSchema } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        await service().create(c.req.valid('param').connectionId, c.req.valid('json').path),
        201,
      ),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/external-editors/{id}',
      operationId: 'getExternalEditor',
      security,
      request: { params: sessionParams },
      responses: {
        200: {
          description: 'Current external editor state',
          content: { 'application/json': { schema: externalEditorSessionSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await service().get(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/external-editors/{id}/push',
      operationId: 'pushExternalEditorChanges',
      security,
      request: { params: sessionParams },
      responses: {
        200: {
          description: 'External editor changes uploaded',
          content: { 'application/json': { schema: externalEditorSessionSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await service().push(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/external-editors/{id}',
      operationId: 'closeExternalEditor',
      security,
      request: { params: sessionParams },
      responses: { 204: { description: 'Temporary editor copy removed' }, ...errors },
    }),
    async (c) => {
      await service().close(c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
}

const credentialParamsSchema = z.object({ ref: z.string().min(1).max(256) }).strict();
function registerCredentialRoutes(app: OpenAPIHono<Env>, host: HostCapabilityClient | undefined) {
  const requireHost = () => {
    if (!host)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Credential vault is unavailable', 503);
    return host;
  };
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/credentials',
      operationId: 'listCredentialMetadata',
      security,
      responses: {
        200: {
          description: 'Credential metadata',
          content: { 'application/json': { schema: z.array(credentialMetadataSchema) } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(credentialMetadataSchema.array().parse(await requireHost().listCredentials()), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/credentials',
      operationId: 'createCredentialReference',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: createCredentialSchema } },
        },
      },
      responses: {
        201: {
          description: 'Credential metadata',
          content: { 'application/json': { schema: credentialMetadataSchema } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        credentialMetadataSchema.parse(await requireHost().createCredential(c.req.valid('json'))),
        201,
      ),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/credentials/{ref}',
      operationId: 'replaceCredential',
      security,
      request: {
        params: credentialParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: replaceCredentialSchema } },
        },
      },
      responses: {
        200: {
          description: 'Credential metadata',
          content: { 'application/json': { schema: credentialMetadataSchema } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        credentialMetadataSchema.parse(
          await requireHost().replaceCredential(
            c.req.valid('param').ref,
            c.req.valid('json').secret,
          ),
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/credentials/{ref}',
      operationId: 'deleteCredential',
      security,
      request: { params: credentialParamsSchema },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await requireHost().deleteCredential(c.req.valid('param').ref);
      return c.body(null, 204);
    },
  );
}

function registerRdpRoutes(app: OpenAPIHono<Env>, sessions: RdpSessionService) {
  const rdpSessionParamsSchema = z.object({ id: idSchema }).strict();
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/rdp/sessions',
      operationId: 'listRdpSessions',
      security,
      responses: {
        200: {
          description: 'RDP sessions',
          content: { 'application/json': { schema: z.array(rdpSessionSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(sessions.list(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/rdp/sessions',
      operationId: 'createRdpSession',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: createRdpSessionSchema } },
        },
      },
      responses: {
        201: {
          description: 'Created RDP session',
          content: { 'application/json': { schema: rdpSessionSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await sessions.create(c.req.valid('json')), 201),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/rdp/sessions/{id}',
      operationId: 'getRdpSession',
      security,
      request: { params: rdpSessionParamsSchema },
      responses: {
        200: {
          description: 'RDP session',
          content: { 'application/json': { schema: rdpSessionSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(sessions.get(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/rdp/sessions/{id}/credentials/claim',
      operationId: 'claimRdpSessionCredentials',
      security,
      request: { params: rdpSessionParamsSchema },
      responses: {
        200: {
          description: 'Single-use RDP adapter bootstrap',
          content: { 'application/json': { schema: rdpCredentialBootstrapSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(sessions.claimCredentials(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/rdp/sessions/{id}',
      operationId: 'resizeRdpSession',
      security,
      request: {
        params: rdpSessionParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: resizeRdpSessionSchema } },
        },
      },
      responses: {
        200: {
          description: 'Resized RDP session',
          content: { 'application/json': { schema: rdpSessionSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const input = c.req.valid('json');
      return c.json(sessions.resize(c.req.valid('param').id, input.width, input.height), 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/rdp/sessions/{id}',
      operationId: 'closeRdpSession',
      security,
      request: { params: rdpSessionParamsSchema },
      responses: { 204: { description: 'Closed' }, ...errors },
    }),
    async (c) => {
      await sessions.close(c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
}

function registerVncRoutes(app: OpenAPIHono<Env>, sessions: VncSessionService) {
  const params = z.object({ id: idSchema }).strict();
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/vnc/sessions',
      operationId: 'listVncSessions',
      security,
      responses: {
        200: {
          description: 'VNC sessions',
          content: { 'application/json': { schema: z.array(vncSessionSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(sessions.list(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/vnc/sessions',
      operationId: 'createVncSession',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: createVncSessionSchema } },
        },
      },
      responses: {
        201: {
          description: 'Created VNC session',
          content: { 'application/json': { schema: vncSessionSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await sessions.create(c.req.valid('json')), 201),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/vnc/sessions/{id}',
      operationId: 'getVncSession',
      security,
      request: { params },
      responses: {
        200: {
          description: 'VNC session',
          content: { 'application/json': { schema: vncSessionSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(sessions.get(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/vnc/sessions/{id}/credentials/claim',
      operationId: 'claimVncSessionCredentials',
      security,
      request: { params },
      responses: {
        200: {
          description: 'Single-use VNC adapter bootstrap',
          content: { 'application/json': { schema: vncCredentialBootstrapSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(sessions.claimCredentials(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/vnc/sessions/{id}',
      operationId: 'closeVncSession',
      security,
      request: { params },
      responses: { 204: { description: 'Closed' }, ...errors },
    }),
    async (c) => {
      await sessions.close(c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
}

function registerSpiceRoutes(app: OpenAPIHono<Env>, sessions: SpiceSessionService) {
  const params = z.object({ id: idSchema }).strict();
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/spice/sessions',
      operationId: 'listSpiceSessions',
      security,
      responses: {
        200: {
          description: 'SPICE sessions',
          content: { 'application/json': { schema: z.array(spiceSessionSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(sessions.list(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/spice/sessions',
      operationId: 'createSpiceSession',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: createSpiceSessionSchema } },
        },
      },
      responses: {
        201: {
          description: 'Created SPICE session',
          content: { 'application/json': { schema: spiceSessionSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await sessions.create(c.req.valid('json')), 201),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/spice/sessions/{id}',
      operationId: 'getSpiceSession',
      security,
      request: { params },
      responses: {
        200: {
          description: 'SPICE session',
          content: { 'application/json': { schema: spiceSessionSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(sessions.get(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/spice/sessions/{id}/credentials/claim',
      operationId: 'claimSpiceSessionCredentials',
      security,
      request: { params },
      responses: {
        200: {
          description: 'Single-use SPICE adapter bootstrap',
          content: { 'application/json': { schema: spiceCredentialBootstrapSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(sessions.claimCredentials(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/spice/sessions/{id}',
      operationId: 'closeSpiceSession',
      security,
      request: { params },
      responses: { 204: { description: 'Closed' }, ...errors },
    }),
    async (c) => {
      await sessions.close(c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
}

function registerDeepLinkRoutes(
  app: OpenAPIHono<Env>,
  intents: DeepLinkIntentService,
  generation: string,
  ingressToken: string | undefined,
) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/desktop/v1/deep-links',
      operationId: 'enqueueDesktopDeepLink',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: enqueueDeepLinkSchema } },
        },
      },
      responses: {
        202: {
          description: 'Deep link accepted',
          content: { 'application/json': { schema: deepLinkReceiptSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      if (
        !ingressToken ||
        c.req.header('X-Runtime-Generation') !== generation ||
        !constantTimeBearer(c.req.header('Authorization'), ingressToken)
      )
        return problem(c, 401, 'UNAUTHORIZED', 'Desktop Runtime ingress authentication required');
      return c.json(intents.enqueue(c.req.valid('json').source), 202);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/desktop/deep-links/next',
      operationId: 'claimNextDesktopDeepLink',
      security,
      responses: {
        200: {
          description: 'Next pending deep link or null',
          content: { 'application/json': { schema: deepLinkIntentSchema.nullable() } },
        },
        ...errors,
      },
    }),
    (c) => c.json(intents.next(), 200),
  );
}

function constantTimeBearer(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function registerWebRoutes(app: OpenAPIHono<Env>, sessions: WebSessionService) {
  const params = z.object({ id: idSchema }).strict();
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/web/sessions',
      operationId: 'listWebSessions',
      security,
      responses: {
        200: {
          description: 'Web sessions',
          content: { 'application/json': { schema: z.array(webSessionSchema) } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await sessions.list(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/web/sessions',
      operationId: 'createWebSession',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: createWebSessionSchema } },
        },
      },
      responses: {
        201: {
          description: 'Created Web session',
          content: { 'application/json': { schema: webSessionSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await sessions.create(c.req.valid('json')), 201),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/web/sessions/{id}',
      operationId: 'getWebSession',
      security,
      request: { params },
      responses: {
        200: {
          description: 'Web session',
          content: { 'application/json': { schema: webSessionSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await sessions.get(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/web/sessions/{id}',
      operationId: 'presentWebSession',
      security,
      request: {
        params,
        body: {
          required: true,
          content: { 'application/json': { schema: webSessionPresentationSchema } },
        },
      },
      responses: {
        200: {
          description: 'Updated Web presentation',
          content: { 'application/json': { schema: webSessionSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await sessions.present(c.req.valid('param').id, c.req.valid('json')), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/web/sessions/{id}/actions',
      operationId: 'performWebSessionAction',
      security,
      request: {
        params,
        body: {
          required: true,
          content: { 'application/json': { schema: webSessionActionSchema } },
        },
      },
      responses: {
        200: {
          description: 'Updated Web session',
          content: { 'application/json': { schema: webSessionSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await sessions.perform(c.req.valid('param').id, c.req.valid('json')), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/web/sessions/{id}/auth',
      operationId: 'answerWebSessionAuthentication',
      security,
      request: {
        params,
        body: {
          required: true,
          content: { 'application/json': { schema: webSessionAuthResponseSchema } },
        },
      },
      responses: {
        200: {
          description: 'Answered Web authentication challenge',
          content: { 'application/json': { schema: webSessionSchema } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(await sessions.authenticate(c.req.valid('param').id, c.req.valid('json')), 200),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/web/sessions/{id}',
      operationId: 'closeWebSession',
      security,
      request: { params },
      responses: { 204: { description: 'Closed' }, ...errors },
    }),
    async (c) => {
      await sessions.close(c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
}

function registerTerminalRoutes(
  app: OpenAPIHono<Env>,
  terminals: TerminalService,
  terminalTransfers: TerminalTransferService,
  terminalInformation: TerminalInformationService,
  connections: ConnectionService,
  repository: ProductRepository,
  host: HostCapabilityClient | undefined,
  telnet: TelnetService,
  serial: SerialService,
) {
  const requireHost = () => {
    if (!host)
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'Desktop file capabilities are unavailable',
        503,
      );
    return host;
  };
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/serial/ports',
      operationId: 'listSerialPorts',
      security,
      responses: {
        200: {
          description: 'Serial ports',
          content: { 'application/json': { schema: z.array(serialPortInfoSchema) } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await serial.listPorts(), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/terminals',
      operationId: 'listTerminalSessions',
      security,
      responses: {
        200: {
          description: 'Terminal sessions',
          content: { 'application/json': { schema: z.array(terminalSessionSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(terminals.list(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/terminals',
      operationId: 'createTerminal',
      security,
      request: {
        body: { required: true, content: { 'application/json': { schema: createTerminalSchema } } },
      },
      responses: {
        201: {
          description: 'Created terminal',
          content: { 'application/json': { schema: terminalSessionSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const input = c.req.valid('json');
      const profile = input.profileId
        ? terminalProfileSchema.parse(
            repository.getJson<unknown>('terminal_profiles', input.profileId),
          )
        : undefined;
      const profileOptions = profile ? optionsForProfile(profile) : undefined;
      if (input.kind === 'ssh')
        return connections
          .openTerminal(input.connectionId!, {
            cols: input.cols,
            rows: input.rows,
            ...(input.bookmarkId ? { bookmarkId: input.bookmarkId } : {}),
            ...(input.profileId ? { profileId: input.profileId } : {}),
            ...(input.workingDirectory?.scope === 'remote'
              ? { directory: input.workingDirectory.path }
              : {}),
            ...(profileOptions
              ? {
                  term: profileOptions.term,
                  appearance: profileOptions.appearance,
                  behavior: profileOptions.behavior,
                }
              : {}),
            ...(profileOptions?.env || input.environment
              ? { env: { ...(profileOptions?.env ?? {}), ...(input.environment ?? {}) } }
              : {}),
          })
          .then((terminal) => c.json(terminal, 201));
      if (input.kind === 'telnet')
        return c.json(
          await telnet.open({
            bookmarkId: input.bookmarkId!,
            cols: input.cols,
            rows: input.rows,
            ...(input.profileId ? { profileId: input.profileId } : {}),
            ...(profileOptions
              ? {
                  appearance: profileOptions.appearance,
                  behavior: profileOptions.behavior,
                }
              : {}),
            signal: c.req.raw.signal,
          }),
          201,
        );
      if (input.kind === 'serial')
        return c.json(
          await serial.open({
            bookmarkId: input.bookmarkId!,
            ...(input.profileId ? { profileId: input.profileId } : {}),
            ...(profileOptions
              ? {
                  appearance: profileOptions.appearance,
                  behavior: profileOptions.behavior,
                }
              : {}),
            signal: c.req.raw.signal,
          }),
          201,
        );
      let localDirectory: string | undefined;
      if (input.workingDirectory?.scope === 'local') {
        const grant = await requireHost().resolveGrantTransferPath(
          input.workingDirectory.grantId,
          input.workingDirectory.path,
          'read',
        );
        if (grant.kind !== 'directory')
          throw new ApplicationError(
            'VALIDATION_ERROR',
            'The granted working directory is not a directory',
            400,
          );
        localDirectory = grant.path;
      }
      return c.json(
        terminals.createLocal({
          ...(input.profileId ? { profileId: input.profileId } : {}),
          ...profileOptions,
          ...(localDirectory ? { cwd: localDirectory } : {}),
          cols: input.cols,
          rows: input.rows,
        }),
        201,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/terminals/{id}',
      operationId: 'getTerminalSession',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'Terminal session',
          content: { 'application/json': { schema: terminalSessionSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(terminals.get(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/terminals/{id}/information',
      operationId: 'getTerminalInformation',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'Bounded system information for a live terminal',
          content: { 'application/json': { schema: terminalInformationSnapshotSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await terminalInformation.snapshot(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/terminals/{id}/transfer',
      operationId: 'getTerminalTransfer',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'Current terminal-native transfer state',
          content: { 'application/json': { schema: terminalTransferStateSchema.nullable() } },
        },
        ...errors,
      },
    }),
    (c) => c.json(terminalTransfers.get(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/terminals/{id}/transfer/actions',
      operationId: 'performTerminalTransferAction',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: terminalTransferActionSchema } },
        },
      },
      responses: {
        200: {
          description: 'Updated terminal-native transfer state',
          content: { 'application/json': { schema: terminalTransferStateSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const action = c.req.valid('json');
      const grant =
        action.action === 'cancel' ? undefined : await requireHost().resolveGrant(action.grantId);
      return c.json(
        terminalTransferStateSchema.parse(
          await terminalTransfers.perform(c.req.valid('param').id, action, grant),
        ),
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/terminals/{id}',
      operationId: 'closeTerminal',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Closed' }, ...errors },
    }),
    async (c) => {
      await terminals.close(c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/terminals/{id}/granted-paths',
      operationId: 'insertGrantedTerminalPaths',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: insertGrantedPathsSchema } },
        },
      },
      responses: {
        200: {
          description: 'Granted local paths inserted without execution',
          content: { 'application/json': { schema: insertGrantedPathsResultSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const paths: string[] = [];
      for (const grantId of c.req.valid('json').grantIds) {
        const grant = await requireHost().resolveGrant(grantId);
        if (grant.kind !== 'file' || !grant.permissions.includes('read'))
          throw new ApplicationError(
            'VALIDATION_ERROR',
            'A readable file grant is required for terminal insertion',
            400,
          );
        paths.push(grant.path);
      }
      terminals.insertText(
        c.req.valid('param').id,
        `${paths.map(quoteTerminalDroppedPath).join(' ')} `,
      );
      return c.json({ inserted: paths.length }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/terminals/{id}/recording',
      operationId: 'startTerminalRecording',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: startTerminalRecordingSchema } },
        },
      },
      responses: {
        201: {
          description: 'Started terminal recording',
          content: { 'application/json': { schema: terminalRecordingSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const input = c.req.valid('json');
      const grant = await requireHost().resolveGrant(input.grantId);
      if (grant.kind !== 'save-target' || !grant.permissions.includes('write'))
        throw new ApplicationError(
          'VALIDATION_ERROR',
          'The selected grant does not allow writing a log file',
          400,
        );
      return c.json(
        terminalRecordingSchema.parse(
          await terminals.startRecording(c.req.valid('param').id, {
            path: grant.path,
            fileName: grant.name,
            timestamps: input.timestamps,
            includeRecent: input.includeRecent,
          }),
        ),
        201,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/terminals/{id}/recording',
      operationId: 'stopTerminalRecording',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'Stopped terminal recording',
          content: { 'application/json': { schema: terminalRecordingSchema } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        terminalRecordingSchema.parse(await terminals.stopRecording(c.req.valid('param').id)),
        200,
      ),
  );
}

function optionsForProfile(profile: TerminalProfile) {
  return {
    ...(profile.shell ? { shell: profile.shell } : {}),
    shellArgs: profile.shellArgs,
    ...(profile.cwd ? { cwd: profile.cwd } : {}),
    env: { ...profile.env, ...(profile.lang ? { LANG: profile.lang } : {}) },
    term: profile.term,
    loginShell: profile.loginShell,
    appearance: {
      fontFamily: profile.fontFamily,
      fontSize: profile.fontSize,
      lineHeight: profile.lineHeight,
      cursorStyle: profile.cursorStyle,
      cursorBlink: profile.cursorBlink,
    },
    behavior: {
      scrollback: profile.scrollback,
      rendererPreference: profile.rendererPreference,
      unicodeVersion: profile.unicodeVersion,
      ligaturesEnabled: profile.ligaturesEnabled,
      imageSequencesEnabled: profile.imageSequencesEnabled,
      wordSeparator: profile.wordSeparator,
      backspaceMode: profile.backspaceMode,
      shiftEnterMode: profile.shiftEnterMode,
      encoding: profile.encoding,
      displayRaw: profile.displayRaw,
      logTimestamps: profile.logTimestamps,
      pasteProtection: profile.pasteProtection,
      osc52Enabled: profile.osc52Enabled,
      osc52ReadPolicy: profile.osc52ReadPolicy,
      osc52WritePolicy: profile.osc52WritePolicy,
    },
  };
}

function quoteTerminalDroppedPath(path: string): string {
  if (
    !path ||
    path.length > 8_192 ||
    [...path].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 0 || code === 10 || code === 13;
    })
  )
    throw new ApplicationError('VALIDATION_ERROR', 'Granted file path is invalid', 400);
  return `"${path.replace(/[\\"$`]/gu, '\\$&')}"`;
}

function decodeDroppedFileName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApplicationError('VALIDATION_ERROR', 'Dropped file name is invalid', 400);
  }
}

function registerWorkspaceRoutes(
  app: OpenAPIHono<Env>,
  repository: ProductRepository,
  importer: HostImportService,
) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/hosts/import/preview',
      operationId: 'previewSshConfigImport',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: previewSshConfigImportSchema } },
        },
      },
      responses: {
        200: {
          description: 'Editable, bounded SSH Config import preview',
          content: { 'application/json': { schema: sshConfigImportPreviewSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await importer.preview(c.req.valid('json')), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/hosts/import/commit',
      operationId: 'commitSshConfigImport',
      security,
      request: {
        headers: bookmarkTreeMutationHeadersSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: commitSshConfigImportSchema } },
        },
      },
      responses: {
        200: {
          description: 'Confirmed preview produced no new records',
          content: { 'application/json': { schema: sshConfigImportResultSchema } },
        },
        201: {
          description: 'Confirmed preview atomically created Hosts and Bookmarks',
          content: { 'application/json': { schema: sshConfigImportResultSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const result = importer.commitPreview(c.req.valid('json'), c.req.header('If-Match'));
      c.header('ETag', result.tree.etag);
      return c.json(
        result,
        result.createdHosts.length || result.createdBookmarks.length ? 201 : 200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/hosts/import',
      operationId: 'importHosts',
      security,
      request: {
        headers: bookmarkTreeMutationHeadersSchema,
        body: { required: true, content: { 'application/json': { schema: importHostsSchema } } },
      },
      responses: {
        200: {
          description: 'Repeat-safe SSH Config import report with no new records',
          content: { 'application/json': { schema: sshConfigImportResultSchema } },
        },
        201: {
          description:
            'Atomically imported SSH Hosts and Bookmarks; ETag identifies the returned tree',
          content: { 'application/json': { schema: sshConfigImportResultSchema } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const result = await importer.import(c.req.valid('json'), c.req.header('If-Match'));
      c.header('ETag', result.tree.etag);
      return c.json(
        result,
        result.createdHosts.length || result.createdBookmarks.length ? 201 : 200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/terminal-profiles',
      operationId: 'listTerminalProfiles',
      security,
      responses: {
        200: {
          description: 'Terminal profiles',
          content: { 'application/json': { schema: z.array(terminalProfileSchema) } },
        },
        ...errors,
      },
    }),
    (c) =>
      c.json(
        terminalProfileSchema.array().parse(repository.listJson<unknown>('terminal_profiles')),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/terminal-profiles',
      operationId: 'createTerminalProfile',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: terminalProfileInputSchema } },
        },
      },
      responses: {
        201: {
          description: 'Terminal profile',
          content: { 'application/json': { schema: terminalProfileSchema } },
        },
        ...errors,
      },
    }),
    (c) =>
      c.json(
        repository.createJson('terminal_profiles', c.req.valid('json'), 'terminal-profile'),
        201,
      ),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/terminal-profiles/{id}',
      operationId: 'updateTerminalProfile',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: terminalProfilePatchSchema } },
        },
      },
      responses: {
        200: {
          description: 'Terminal profile',
          content: { 'application/json': { schema: terminalProfileSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const profile = repository.updateJson<TerminalProfile>(
        'terminal_profiles',
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.header('If-Match'),
        'terminal-profile',
      );
      return c.json(terminalProfileSchema.parse(profile), 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/terminal-profiles/{id}',
      operationId: 'deleteTerminalProfile',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    (c) => {
      repository.deleteJson(
        'terminal_profiles',
        c.req.valid('param').id,
        c.req.header('If-Match'),
        'terminal-profile',
      );
      return c.body(null, 204);
    },
  );
}

function registerConnectionRoutes(
  app: OpenAPIHono<Env>,
  connections: ConnectionService,
  interactions: InteractionService,
) {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ssh/agent/probe',
      operationId: 'probeSshAgent',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: sshAgentProbeInputSchema } },
        },
      },
      responses: {
        200: {
          description: 'SSH Agent capability for the Runtime host platform',
          content: { 'application/json': { schema: sshAgentStatusSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await connections.agentStatus(c.req.valid('json').path ?? undefined), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/connections',
      operationId: 'listActiveConnections',
      security,
      responses: {
        200: {
          description: 'Connections',
          content: { 'application/json': { schema: z.array(connectionSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(connections.list(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/connections',
      operationId: 'createConnection',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: createConnectionSchema } },
        },
      },
      responses: {
        202: {
          description: 'Connection started',
          content: { 'application/json': { schema: connectionSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(connections.create(c.req.valid('json')), 202),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/connections/{id}',
      operationId: 'getConnection',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'Connection',
          content: { 'application/json': { schema: connectionSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(connections.get(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/connections/{id}',
      operationId: 'closeConnection',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Closed' }, ...errors },
    }),
    async (c) => {
      await connections.close(c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/connections/{id}/retry',
      operationId: 'retryConnection',
      security,
      request: { params: idParamsSchema },
      responses: {
        202: {
          description: 'Connection restarted',
          content: { 'application/json': { schema: connectionSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await connections.retry(c.req.valid('param').id), 202),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/connections/{id}/reconnect/cancel',
      operationId: 'cancelConnectionReconnect',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'Pending automatic reconnect canceled',
          content: { 'application/json': { schema: connectionSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(connections.cancelReconnect(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/interactions',
      operationId: 'listPendingInteractions',
      security,
      responses: {
        200: {
          description: 'Pending interactions',
          content: { 'application/json': { schema: z.array(interactionSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(interactions.list(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/interactions/{id}/respond',
      operationId: 'respondInteraction',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: interactionResponseSchema } },
        },
      },
      responses: { 204: { description: 'Responded' }, ...errors },
    }),
    (c) => {
      interactions.respond(c.req.valid('param').id, c.req.valid('json'));
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/interactions/{id}/cancel',
      operationId: 'cancelInteraction',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Canceled' }, ...errors },
    }),
    (c) => {
      interactions.cancel(c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
}

const commandHistoryRecordHeadersSchema = z.object({
  'Idempotency-Key': z
    .string()
    .min(1)
    .max(200)
    .optional()
    .openapi({
      param: { name: 'Idempotency-Key', in: 'header' },
      description: 'Required idempotency key for one shell-integration command event',
    }),
});
const commandHistoryMutationHeadersSchema = z.object({
  'If-Match': z
    .string()
    .optional()
    .openapi({
      param: { name: 'If-Match', in: 'header' },
      description: 'Current command-history item ETag',
      example: '"v1"',
    }),
  'Idempotency-Key': z
    .string()
    .min(1)
    .max(200)
    .optional()
    .openapi({
      param: { name: 'Idempotency-Key', in: 'header' },
      description: 'Required idempotency key for this command-history mutation',
    }),
});
const clearCommandHistoryHeadersSchema = commandHistoryMutationHeadersSchema.extend({
  'If-Match': z
    .string()
    .optional()
    .openapi({
      param: { name: 'If-Match', in: 'header' },
      description: 'Current command-history collection ETag',
      example: '"command-history-v1"',
    }),
});

function registerCommandHistoryRoutes(app: OpenAPIHono<Env>, history: CommandHistoryService) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/command-history',
      operationId: 'listCommandHistory',
      security,
      request: { query: commandHistoryPageQuerySchema },
      responses: {
        200: {
          description: 'Bounded, searchable command history page',
          content: { 'application/json': { schema: commandHistoryPageSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const page = history.list(c.req.valid('query'));
      c.header('ETag', page.etag);
      return c.json(page, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/command-history',
      operationId: 'recordCommandHistory',
      description:
        'Records one line confirmed by OSC 633 shell integration. Arbitrary terminal input and output are not accepted.',
      security,
      request: {
        headers: commandHistoryRecordHeadersSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: recordCommandHistorySchema } },
        },
      },
      responses: {
        200: {
          description: 'Recorded or safely declined by the privacy policy',
          content: { 'application/json': { schema: recordCommandHistoryResultSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const result = history.record(c.req.valid('json'), c.req.header('Idempotency-Key'));
      c.header('ETag', result.etag);
      return c.json(result, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/command-history',
      operationId: 'clearCommandHistory',
      security,
      request: { headers: clearCommandHistoryHeadersSchema },
      responses: {
        200: {
          description: 'Command history cleared',
          content: { 'application/json': { schema: clearCommandHistoryResultSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const result = history.clear(c.req.header('If-Match'), c.req.header('Idempotency-Key'));
      c.header('ETag', result.etag);
      return c.json(result, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/command-history/{id}',
      operationId: 'deleteCommandHistory',
      security,
      request: { params: idParamsSchema, headers: commandHistoryMutationHeadersSchema },
      responses: {
        200: {
          description: 'One command-history item deleted',
          content: { 'application/json': { schema: deleteCommandHistoryResultSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const result = history.delete(
        c.req.valid('param').id,
        c.req.header('If-Match'),
        c.req.header('Idempotency-Key'),
      );
      c.header('ETag', result.etag);
      return c.json(result, 200);
    },
  );
}

const connectionHistoryItemHeadersSchema = z.object({
  'If-Match': z
    .string()
    .optional()
    .openapi({
      param: { name: 'If-Match', in: 'header' },
      description: 'Current connection-history item ETag',
      example: '"v1"',
    }),
});
const connectionHistoryMutationHeadersSchema = connectionHistoryItemHeadersSchema.extend({
  'Idempotency-Key': z
    .string()
    .min(1)
    .max(200)
    .optional()
    .openapi({
      param: { name: 'Idempotency-Key', in: 'header' },
      description: 'Required idempotency key for this connection-history mutation',
    }),
});
const clearConnectionHistoryHeadersSchema = z.object({
  'If-Match': z
    .string()
    .optional()
    .openapi({
      param: { name: 'If-Match', in: 'header' },
      description: 'Current connection-history collection ETag',
      example: '"connection-history-v1"',
    }),
  'Idempotency-Key': z
    .string()
    .min(1)
    .max(200)
    .optional()
    .openapi({
      param: { name: 'Idempotency-Key', in: 'header' },
      description: 'Required idempotency key for clearing connection history',
    }),
});
const promoteConnectionHistoryHeadersSchema = connectionHistoryMutationHeadersSchema.extend({
  'X-Bookmark-Tree-If-Match': z
    .string()
    .optional()
    .openapi({
      param: { name: 'X-Bookmark-Tree-If-Match', in: 'header' },
      description: 'Current Bookmark tree ETag',
      example: '"bookmark-tree-v1"',
    }),
});

function registerConnectionHistoryRoutes(
  app: OpenAPIHono<Env>,
  history: ConnectionHistoryService,
  connections: ConnectionService,
) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/connection-history',
      operationId: 'listConnectionHistory',
      security,
      request: { query: connectionHistoryPageQuerySchema },
      responses: {
        200: {
          description: 'Bounded SSH connection history page',
          content: { 'application/json': { schema: connectionHistoryPageSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const page = history.list(c.req.valid('query'));
      c.header('ETag', page.etag);
      return c.json(page, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/connection-history',
      operationId: 'clearConnectionHistory',
      security,
      request: { headers: clearConnectionHistoryHeadersSchema },
      responses: {
        200: {
          description: 'Connection history cleared',
          content: { 'application/json': { schema: clearConnectionHistoryResultSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const result = history.clear(c.req.header('If-Match'), c.req.header('Idempotency-Key'));
      c.header('ETag', result.etag);
      return c.json(result, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/connection-history/{id}',
      operationId: 'deleteConnectionHistory',
      security,
      request: { params: idParamsSchema, headers: connectionHistoryMutationHeadersSchema },
      responses: {
        200: {
          description: 'One connection history item deleted',
          content: { 'application/json': { schema: deleteConnectionHistoryResultSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const result = history.delete(
        c.req.valid('param').id,
        c.req.header('If-Match'),
        c.req.header('Idempotency-Key'),
      );
      c.header('ETag', result.etag);
      return c.json(result, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/connection-history/{id}/reconnect',
      operationId: 'reconnectConnectionHistory',
      description:
        'Starts a Connection from a history item. Its bounded idempotency receipt is valid only for the current Runtime generation.',
      security,
      request: {
        params: idParamsSchema,
        headers: connectionHistoryMutationHeadersSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: reconnectConnectionHistorySchema } },
        },
      },
      responses: {
        202: {
          description: 'Connection started from a history item',
          content: { 'application/json': { schema: reconnectConnectionHistoryResultSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const result = history.reconnect(
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.header('If-Match'),
        c.req.header('Idempotency-Key'),
        connections,
      );
      c.header('ETag', `"v${result.historyItem.version}"`);
      return c.json(result, 202);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/connection-history/{id}/bookmark',
      operationId: 'promoteConnectionHistoryToBookmark',
      security,
      request: {
        params: idParamsSchema,
        headers: promoteConnectionHistoryHeadersSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: promoteConnectionHistorySchema } },
        },
      },
      responses: {
        201: {
          description: 'History item atomically promoted to an SSH Host and Bookmark',
          content: { 'application/json': { schema: promoteConnectionHistoryResultSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const result = history.promote(
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.header('If-Match'),
        c.req.header('X-Bookmark-Tree-If-Match'),
        c.req.header('Idempotency-Key'),
      );
      c.header('ETag', result.tree.etag);
      c.header('X-Host-ETag', etagFor(result.host.version));
      c.header('X-Connection-History-ETag', result.history.etag);
      return c.json(result, 201);
    },
  );
}

const idParamsSchema = z.object({ id: idSchema }).strict();
const quickCommandTreeMutationHeadersSchema = z.object({
  'If-Match': z
    .string()
    .optional()
    .openapi({
      param: { name: 'If-Match', in: 'header' },
      description: 'Current Quick Command tree ETag',
      example: '"quick-command-tree-v1"',
    }),
});
const bookmarkTreeMutationHeadersSchema = z.object({
  'If-Match': z
    .string()
    .optional()
    .openapi({
      param: { name: 'If-Match', in: 'header' },
      description: 'Current Bookmark tree ETag',
      example: '"bookmark-tree-v1"',
    }),
});

function registerQuickCommandRoutes(app: OpenAPIHono<Env>, quickCommands: QuickCommandService) {
  const treeResponse = {
    description: 'Ordered Quick Command tree',
    content: { 'application/json': { schema: quickCommandTreeSchema } },
  };
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/quick-command-tree',
      operationId: 'getQuickCommandTree',
      security,
      responses: { 200: treeResponse, ...errors },
    }),
    (c) => {
      const tree = quickCommands.snapshot();
      c.header('ETag', tree.etag);
      return c.json(tree, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/quick-commands',
      operationId: 'listQuickCommands',
      security,
      responses: {
        200: {
          description: 'Quick Commands in persisted tree order',
          content: { 'application/json': { schema: z.array(quickCommandSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(quickCommands.snapshot().commands, 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/quick-commands',
      operationId: 'createQuickCommand',
      security,
      request: {
        headers: quickCommandTreeMutationHeadersSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: quickCommandInputSchema } },
        },
      },
      responses: { 201: treeResponse, ...errors },
    }),
    (c) => {
      const tree = quickCommands.createCommand(c.req.valid('json'), c.req.header('If-Match'));
      c.header('ETag', tree.etag);
      return c.json(tree, 201);
    },
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/quick-commands/{id}',
      operationId: 'updateQuickCommand',
      security,
      request: {
        params: idParamsSchema,
        headers: quickCommandTreeMutationHeadersSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: quickCommandPatchSchema } },
        },
      },
      responses: { 200: treeResponse, ...errors },
    }),
    (c) => {
      const tree = quickCommands.updateCommand(
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.header('If-Match'),
      );
      c.header('ETag', tree.etag);
      return c.json(tree, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/quick-commands/{id}',
      operationId: 'deleteQuickCommand',
      security,
      request: { params: idParamsSchema, headers: quickCommandTreeMutationHeadersSchema },
      responses: { 200: treeResponse, ...errors },
    }),
    (c) => {
      const tree = quickCommands.deleteCommand(c.req.valid('param').id, c.req.header('If-Match'));
      c.header('ETag', tree.etag);
      return c.json(tree, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/quick-command-groups',
      operationId: 'createQuickCommandGroup',
      security,
      request: {
        headers: quickCommandTreeMutationHeadersSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: quickCommandGroupInputSchema } },
        },
      },
      responses: { 201: treeResponse, ...errors },
    }),
    (c) => {
      const tree = quickCommands.createGroup(c.req.valid('json'), c.req.header('If-Match'));
      c.header('ETag', tree.etag);
      return c.json(tree, 201);
    },
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/quick-command-groups/{id}',
      operationId: 'updateQuickCommandGroup',
      security,
      request: {
        params: idParamsSchema,
        headers: quickCommandTreeMutationHeadersSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: quickCommandGroupPatchSchema } },
        },
      },
      responses: { 200: treeResponse, ...errors },
    }),
    (c) => {
      const tree = quickCommands.updateGroup(
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.header('If-Match'),
      );
      c.header('ETag', tree.etag);
      return c.json(tree, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/quick-command-groups/{id}',
      operationId: 'deleteQuickCommandGroup',
      security,
      request: { params: idParamsSchema, headers: quickCommandTreeMutationHeadersSchema },
      responses: { 200: treeResponse, ...errors },
    }),
    (c) => {
      const tree = quickCommands.deleteGroup(c.req.valid('param').id, c.req.header('If-Match'));
      c.header('ETag', tree.etag);
      return c.json(tree, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/quick-command-tree/moves',
      operationId: 'moveQuickCommandTreeNode',
      security,
      request: {
        headers: quickCommandTreeMutationHeadersSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: moveQuickCommandTreeNodeSchema } },
        },
      },
      responses: { 200: treeResponse, ...errors },
    }),
    (c) => {
      const tree = quickCommands.move(c.req.valid('json'), c.req.header('If-Match'));
      c.header('ETag', tree.etag);
      return c.json(tree, 200);
    },
  );
}

function registerTerminalThemeRoutes(
  app: OpenAPIHono<Env>,
  terminalThemes: TerminalThemeService,
  terminalBackgroundAssets: TerminalBackgroundAssetService,
) {
  const themeResponse = {
    description: 'Terminal theme',
    content: { 'application/json': { schema: terminalThemeSchema } },
  };
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/terminal-themes',
      operationId: 'listTerminalThemes',
      security,
      responses: {
        200: {
          description: 'Built-in and custom terminal themes',
          content: { 'application/json': { schema: z.array(terminalThemeSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(terminalThemes.list(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/terminal-themes',
      operationId: 'createTerminalTheme',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: terminalThemeInputSchema } },
        },
      },
      responses: { 201: themeResponse, ...errors },
    }),
    (c) => c.json(terminalThemes.create(c.req.valid('json')), 201),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/terminal-themes/{id}/clone',
      operationId: 'cloneTerminalTheme',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: cloneTerminalThemeSchema } },
        },
      },
      responses: { 201: themeResponse, ...errors },
    }),
    (c) => {
      const input = c.req.valid('json');
      return c.json(terminalThemes.clone(c.req.valid('param').id, input.name), 201);
    },
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/terminal-themes/{id}',
      operationId: 'updateTerminalTheme',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: terminalThemePatchSchema } },
        },
      },
      responses: { 200: themeResponse, ...errors },
    }),
    (c) =>
      c.json(
        terminalThemes.update(
          c.req.valid('param').id,
          c.req.valid('json'),
          c.req.header('If-Match'),
        ),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/terminal-themes/{id}',
      operationId: 'deleteTerminalTheme',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    (c) => {
      terminalThemes.delete(c.req.valid('param').id, c.req.header('If-Match'));
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/terminal-themes/imports',
      operationId: 'importTerminalTheme',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: terminalThemeGrantRequestSchema } },
        },
      },
      responses: { 201: themeResponse, ...errors },
    }),
    async (c) => c.json(await terminalThemes.import(c.req.valid('json').grantId), 201),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/terminal-themes/{id}/exports',
      operationId: 'exportTerminalTheme',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: terminalThemeGrantRequestSchema } },
        },
      },
      responses: {
        201: {
          description: 'Terminal theme export result',
          content: { 'application/json': { schema: terminalThemeExportResultSchema } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        await terminalThemes.export(c.req.valid('param').id, c.req.valid('json').grantId),
        201,
      ),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/terminal-background-assets',
      operationId: 'importTerminalBackgroundAsset',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: terminalThemeGrantRequestSchema } },
        },
      },
      responses: {
        201: {
          description: 'Imported terminal background asset',
          content: { 'application/json': { schema: terminalBackgroundAssetSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await terminalBackgroundAssets.import(c.req.valid('json').grantId), 201),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/terminal-background-assets/{id}/content',
      operationId: 'getTerminalBackgroundAssetContent',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'Terminal background image bytes',
          content: { 'application/octet-stream': { schema: z.any() } },
        },
        ...errors,
      },
    }),
    async (c) => {
      const resolved = await terminalBackgroundAssets.resolve(c.req.valid('param').id);
      c.header('Content-Type', resolved.asset.mimeType);
      c.header('Content-Length', String(resolved.asset.bytes));
      c.header('Cache-Control', 'private, max-age=3600');
      return stream(c, async (output) => {
        const source = createReadStream(resolved.path);
        try {
          await output.pipe(Readable.toWeb(source) as ReadableStream<Uint8Array>);
        } finally {
          source.destroy();
        }
      });
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/terminal-background-assets/{id}',
      operationId: 'deleteTerminalBackgroundAsset',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    async (c) => {
      await terminalBackgroundAssets.delete(c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
}

function registerBatchOperationRoutes(
  app: OpenAPIHono<Env>,
  batchOperations: BatchOperationService,
) {
  const idempotencyHeaders = z.object({
    'Idempotency-Key': z
      .string()
      .min(1)
      .max(200)
      .optional()
      .openapi({
        param: { name: 'Idempotency-Key', in: 'header' },
        description: 'Required idempotency key for batch operation creation',
      }),
  });
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/batch-operations',
      operationId: 'listBatchOperations',
      security,
      responses: {
        200: {
          description: 'Batch operation history',
          content: { 'application/json': { schema: z.array(batchOperationSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(batchOperations.list(), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/batch-operations/{id}',
      operationId: 'getBatchOperation',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'Batch operation',
          content: { 'application/json': { schema: batchOperationSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(batchOperations.get(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/batch-operations',
      operationId: 'createBatchOperation',
      security,
      request: {
        headers: idempotencyHeaders,
        body: {
          required: true,
          content: { 'application/json': { schema: createBatchOperationSchema } },
        },
      },
      responses: {
        202: {
          description: 'Batch operation accepted',
          content: { 'application/json': { schema: batchOperationSchema } },
        },
        ...errors,
      },
    }),
    (c) =>
      c.json(batchOperations.create(c.req.valid('json'), c.req.header('Idempotency-Key')), 202),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/batch-operations/{id}/cancel',
      operationId: 'cancelBatchOperation',
      security,
      request: { params: idParamsSchema },
      responses: {
        202: {
          description: 'Batch operation cancellation accepted',
          content: { 'application/json': { schema: batchOperationSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(batchOperations.cancel(c.req.valid('param').id), 202),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/batch-operations/clear',
      operationId: 'clearBatchOperations',
      security,
      responses: {
        200: {
          description: 'Cleared completed batch operations',
          content: { 'application/json': { schema: clearBatchOperationsResultSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json({ cleared: batchOperations.clearCompleted() }, 200),
  );
}

function registerWidgetRoutes(app: OpenAPIHono<Env>, widgets: WidgetService) {
  const idempotencyHeaders = z.object({
    'Idempotency-Key': z
      .string()
      .min(1)
      .max(200)
      .optional()
      .openapi({
        param: { name: 'Idempotency-Key', in: 'header' },
        description: 'Required idempotency key for the reviewed file rename',
      }),
  });
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/widgets',
      operationId: 'listWidgets',
      security,
      responses: {
        200: {
          description: 'Built-in Widget catalog',
          content: { 'application/json': { schema: z.array(widgetDefinitionSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(widgets.listDefinitions(), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/widgets/instances',
      operationId: 'listWidgetInstances',
      security,
      responses: {
        200: {
          description: 'Running Widget instances owned by this Runtime generation',
          content: { 'application/json': { schema: z.array(widgetInstanceSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(widgets.listInstances(), 200),
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/widgets/instances/{id}',
      operationId: 'getWidgetInstance',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'Widget instance',
          content: { 'application/json': { schema: widgetInstanceSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(widgets.getInstance(c.req.valid('param').id), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/widgets/local-file-server/instances',
      operationId: 'startLocalFileServerWidget',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: startLocalFileServerSchema } },
        },
      },
      responses: {
        201: {
          description: 'Local file server Widget started',
          content: { 'application/json': { schema: widgetInstanceSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await widgets.startLocalFileServer(c.req.valid('json')), 201),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/widgets/file-renamer/previews',
      operationId: 'previewFileRenameWidget',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: previewFileRenameSchema } },
        },
      },
      responses: {
        201: {
          description: 'Bounded two-minute file rename preview',
          content: { 'application/json': { schema: fileRenamePreviewSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await widgets.previewFileRename(c.req.valid('json')), 201),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/widgets/local-ftp-server/instances',
      operationId: 'startLocalFtpServerWidget',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: startLocalFtpServerSchema } },
        },
      },
      responses: {
        201: {
          description: 'Local FTP Server Widget started',
          content: { 'application/json': { schema: widgetInstanceSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await widgets.startLocalFtpServer(c.req.valid('json')), 201),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/widgets/local-ssh-server/instances',
      operationId: 'startLocalSshServerWidget',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: startLocalSshServerSchema } },
        },
      },
      responses: {
        201: {
          description: 'Local SSH/SFTP Server Widget started',
          content: { 'application/json': { schema: widgetInstanceSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await widgets.startLocalSshServer(c.req.valid('json')), 201),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/widgets/mcp-server/instances',
      operationId: 'startMcpServerWidget',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: startMcpServerSchema } },
        },
      },
      responses: {
        201: {
          description: 'Authenticated loopback MCP Server Widget started',
          content: { 'application/json': { schema: widgetInstanceSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await widgets.startMcpServer(c.req.valid('json')), 201),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/widgets/file-renamer/runs',
      operationId: 'runFileRenameWidget',
      security,
      request: {
        headers: idempotencyHeaders,
        body: {
          required: true,
          content: { 'application/json': { schema: runFileRenameSchema } },
        },
      },
      responses: {
        200: {
          description: 'Reviewed file rename result',
          content: { 'application/json': { schema: fileRenameResultSchema } },
        },
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        await widgets.runFileRename(c.req.valid('json').previewId, c.req.header('Idempotency-Key')),
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/widgets/instances/{id}',
      operationId: 'renameWidgetInstance',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: renameWidgetInstanceSchema } },
        },
      },
      responses: {
        200: {
          description: 'Widget instance renamed',
          content: { 'application/json': { schema: widgetInstanceSchema } },
        },
        ...errors,
      },
    }),
    (c) => c.json(widgets.rename(c.req.valid('param').id, c.req.valid('json')), 200),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/widgets/instances/{id}',
      operationId: 'stopWidgetInstance',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: {
          description: 'Widget instance stopped and released',
          content: { 'application/json': { schema: widgetInstanceSchema } },
        },
        ...errors,
      },
    }),
    async (c) => c.json(await widgets.stop(c.req.valid('param').id), 200),
  );
}

function registerTriggerRoutes(app: OpenAPIHono<Env>, triggers: TriggerService) {
  const headers = z.object({
    'If-Match': z
      .string()
      .optional()
      .openapi({
        param: { name: 'If-Match', in: 'header' },
        description: 'Current Trigger collection ETag',
        example: '"trigger-list-v1"',
      }),
  });
  const response = {
    description: 'Revisioned Trigger collection',
    content: { 'application/json': { schema: triggerCollectionSchema } },
  };
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/triggers',
      operationId: 'getTriggers',
      security,
      responses: { 200: response, ...errors },
    }),
    (c) => {
      const collection = triggers.snapshot();
      c.header('ETag', collection.etag);
      return c.json(collection, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/triggers',
      operationId: 'createTrigger',
      security,
      request: {
        headers,
        body: {
          required: true,
          content: { 'application/json': { schema: triggerRuleInputSchema } },
        },
      },
      responses: { 201: response, ...errors },
    }),
    (c) => {
      const collection = triggers.create(c.req.valid('json'), c.req.header('If-Match'));
      c.header('ETag', collection.etag);
      return c.json(collection, 201);
    },
  );
  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/triggers',
      operationId: 'replaceTriggers',
      security,
      request: {
        headers,
        body: {
          required: true,
          content: { 'application/json': { schema: replaceTriggersSchema } },
        },
      },
      responses: { 200: response, ...errors },
    }),
    (c) => {
      const collection = triggers.replace(c.req.valid('json'), c.req.header('If-Match'));
      c.header('ETag', collection.etag);
      return c.json(collection, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/triggers/{id}',
      operationId: 'updateTrigger',
      security,
      request: {
        params: idParamsSchema,
        headers,
        body: {
          required: true,
          content: { 'application/json': { schema: triggerRulePatchSchema } },
        },
      },
      responses: { 200: response, ...errors },
    }),
    (c) => {
      const collection = triggers.update(
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.header('If-Match'),
      );
      c.header('ETag', collection.etag);
      return c.json(collection, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/triggers/{id}',
      operationId: 'deleteTrigger',
      security,
      request: { params: idParamsSchema, headers },
      responses: { 200: response, ...errors },
    }),
    (c) => {
      const collection = triggers.delete(c.req.valid('param').id, c.req.header('If-Match'));
      c.header('ETag', collection.etag);
      return c.json(collection, 200);
    },
  );
}

const sshBookmarkAggregateHeadersSchema = z.object({
  'If-Match': z
    .string()
    .optional()
    .openapi({
      param: { name: 'If-Match', in: 'header' },
      description: 'Current Host entity ETag',
      example: '"v1"',
    }),
  'X-Bookmark-Tree-If-Match': z
    .string()
    .optional()
    .openapi({
      param: { name: 'X-Bookmark-Tree-If-Match', in: 'header' },
      description: 'Current Bookmark tree ETag',
      example: '"bookmark-tree-v1"',
    }),
});

function registerBookmarkRoutes(
  app: OpenAPIHono<Env>,
  bookmarks: BookmarkTreeService,
  sshBookmarks: SshBookmarkService,
) {
  const treeResponse = {
    description: 'Ordered bookmark tree',
    content: { 'application/json': { schema: bookmarkTreeSchema } },
  };
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/bookmark-tree',
      operationId: 'getBookmarkTree',
      security,
      responses: { 200: treeResponse, ...errors },
    }),
    (c) => {
      const tree = bookmarks.snapshot();
      c.header('ETag', tree.etag);
      return c.json(tree, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/ssh-bookmarks',
      operationId: 'createSshBookmark',
      security,
      request: {
        headers: bookmarkTreeMutationHeadersSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: createSshBookmarkSchema } },
        },
      },
      responses: {
        201: {
          description:
            'Atomically created SSH Host and Bookmark; ETag identifies the returned tree',
          content: { 'application/json': { schema: sshBookmarkMutationResultSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const result = sshBookmarks.create(c.req.valid('json'), c.req.header('If-Match'));
      c.header('ETag', result.tree.etag);
      c.header('X-Host-ETag', etagFor(result.host.version));
      return c.json(result, 201);
    },
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/ssh-bookmarks/{id}',
      operationId: 'updateSshBookmark',
      security,
      request: {
        params: idParamsSchema,
        headers: sshBookmarkAggregateHeadersSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: updateSshBookmarkSchema } },
        },
      },
      responses: {
        200: {
          description:
            'Atomically updated the SSH Host facts, Bookmark presentation and tree placement after validating both ETags',
          content: { 'application/json': { schema: sshBookmarkMutationResultSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const result = sshBookmarks.updateBookmark(
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.header('If-Match'),
        c.req.header('X-Bookmark-Tree-If-Match'),
      );
      c.header('ETag', result.tree.etag);
      c.header('X-Host-ETag', etagFor(result.host.version));
      return c.json(result, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/ssh-bookmarks/{id}',
      operationId: 'deleteSshBookmark',
      security,
      request: { params: idParamsSchema, headers: sshBookmarkAggregateHeadersSchema },
      responses: {
        200: {
          description:
            'Deleted one SSH Bookmark and deleted its Host only when no Bookmark, jump chain, history or tunnel still references it',
          content: { 'application/json': { schema: deleteSshBookmarkEntryResultSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const result = sshBookmarks.deleteBookmark(
        c.req.valid('param').id,
        c.req.header('If-Match'),
        c.req.header('X-Bookmark-Tree-If-Match'),
      );
      c.header('ETag', result.tree.etag);
      return c.json(result, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/ssh-bookmark-hosts/{id}',
      operationId: 'deleteSshBookmarkHost',
      security,
      request: { params: idParamsSchema, headers: sshBookmarkAggregateHeadersSchema },
      responses: {
        200: {
          description:
            'Atomically deleted every Bookmark for the Host and the Host; If-Match is the Host ETag and X-Bookmark-Tree-If-Match is the tree ETag',
          content: { 'application/json': { schema: deleteSshBookmarkResultSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const result = sshBookmarks.delete(
        c.req.valid('param').id,
        c.req.header('If-Match'),
        c.req.header('X-Bookmark-Tree-If-Match'),
      );
      c.header('ETag', result.tree.etag);
      return c.json(result, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/bookmark-groups',
      operationId: 'createBookmarkGroup',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: createBookmarkGroupSchema } },
        },
      },
      responses: { 201: treeResponse, ...errors },
    }),
    (c) => {
      const tree = bookmarks.createGroup(c.req.valid('json'), c.req.header('If-Match'));
      c.header('ETag', tree.etag);
      return c.json(tree, 201);
    },
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/bookmark-groups/{id}',
      operationId: 'updateBookmarkGroup',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: updateBookmarkGroupSchema } },
        },
      },
      responses: { 200: treeResponse, ...errors },
    }),
    (c) => {
      const tree = bookmarks.updateGroup(
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.header('If-Match'),
      );
      c.header('ETag', tree.etag);
      return c.json(tree, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/bookmark-groups/{id}',
      operationId: 'deleteBookmarkGroup',
      security,
      request: { params: idParamsSchema },
      responses: { 200: treeResponse, ...errors },
    }),
    (c) => {
      const tree = bookmarks.deleteGroup(c.req.valid('param').id, c.req.header('If-Match'));
      c.header('ETag', tree.etag);
      return c.json(tree, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/bookmarks',
      operationId: 'createBookmark',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: createBookmarkSchema } },
        },
      },
      responses: { 201: treeResponse, ...errors },
    }),
    (c) => {
      const tree = bookmarks.createBookmark(c.req.valid('json'), c.req.header('If-Match'));
      c.header('ETag', tree.etag);
      return c.json(tree, 201);
    },
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/bookmarks/{id}',
      operationId: 'updateBookmark',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: updateBookmarkSchema } },
        },
      },
      responses: { 200: treeResponse, ...errors },
    }),
    (c) => {
      const tree = bookmarks.updateBookmark(
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.header('If-Match'),
      );
      c.header('ETag', tree.etag);
      return c.json(tree, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/bookmarks/{id}',
      operationId: 'deleteBookmark',
      security,
      request: { params: idParamsSchema },
      responses: { 200: treeResponse, ...errors },
    }),
    (c) => {
      const tree = bookmarks.deleteBookmark(c.req.valid('param').id, c.req.header('If-Match'));
      c.header('ETag', tree.etag);
      return c.json(tree, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/bookmark-tree/moves',
      operationId: 'moveBookmarkTreeNode',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: moveBookmarkTreeNodeSchema } },
        },
      },
      responses: { 200: treeResponse, ...errors },
    }),
    (c) => {
      const tree = bookmarks.move(c.req.valid('json'), c.req.header('If-Match'));
      c.header('ETag', tree.etag);
      return c.json(tree, 200);
    },
  );
}

function registerConnectionProfileRoutes(
  app: OpenAPIHono<Env>,
  profiles: ConnectionProfileService,
) {
  const profileResponse = {
    description: 'Connection Profile',
    content: { 'application/json': { schema: connectionProfileSchema } },
  };

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/connection-profiles',
      operationId: 'listConnectionProfiles',
      security,
      responses: {
        200: {
          description: 'Connection Profiles',
          content: { 'application/json': { schema: z.array(connectionProfileSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(profiles.list(), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/connection-profiles',
      operationId: 'createConnectionProfile',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: connectionProfileInputSchema } },
        },
      },
      responses: { 201: profileResponse, ...errors },
    }),
    (c) => {
      const profile = profiles.create(c.req.valid('json'));
      c.header('ETag', etagFor(profile.version));
      return c.json(profile, 201);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/connection-profiles/{id}',
      operationId: 'getConnectionProfile',
      security,
      request: { params: idParamsSchema },
      responses: { 200: profileResponse, ...errors },
    }),
    (c) => {
      const profile = profiles.get(c.req.valid('param').id);
      c.header('ETag', etagFor(profile.version));
      return c.json(profile, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/connection-profiles/{id}',
      operationId: 'updateConnectionProfile',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: connectionProfilePatchSchema } },
        },
      },
      responses: { 200: profileResponse, ...errors },
    }),
    (c) => {
      const profile = profiles.update(
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.header('If-Match'),
      );
      c.header('ETag', etagFor(profile.version));
      return c.json(profile, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/connection-profiles/{id}',
      operationId: 'deleteConnectionProfile',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Connection Profile deleted' }, ...errors },
    }),
    (c) => {
      profiles.delete(c.req.valid('param').id, c.req.header('If-Match'));
      return c.body(null, 204);
    },
  );
}

function registerHostRoutes(app: OpenAPIHono<Env>, repository: ProductRepository) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/host-groups',
      operationId: 'listHostGroups',
      security,
      responses: {
        200: {
          description: 'Host groups',
          content: { 'application/json': { schema: z.array(hostGroupSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(repository.listHostGroups(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/host-groups',
      operationId: 'createHostGroup',
      security,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: createHostGroupSchema } },
        },
      },
      responses: {
        201: {
          description: 'Created host group',
          content: { 'application/json': { schema: hostGroupSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const entity = repository.createHostGroup(c.req.valid('json'));
      c.header('ETag', etagFor(entity.version));
      return c.json(entity, 201);
    },
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/host-groups/{id}',
      operationId: 'updateHostGroup',
      security,
      request: {
        params: idParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: updateHostGroupSchema } },
        },
      },
      responses: {
        200: {
          description: 'Updated host group',
          content: { 'application/json': { schema: hostGroupSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const entity = repository.updateHostGroup(
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.header('If-Match'),
      );
      c.header('ETag', etagFor(entity.version));
      return c.json(entity, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/host-groups/{id}',
      operationId: 'deleteHostGroup',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    (c) => {
      repository.deleteHostGroup(c.req.valid('param').id, c.req.header('If-Match'));
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/hosts',
      operationId: 'listHosts',
      security,
      responses: {
        200: {
          description: 'Hosts',
          content: { 'application/json': { schema: z.array(hostSchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(repository.listHosts(), 200),
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/hosts',
      operationId: 'createHost',
      security,
      request: {
        body: { required: true, content: { 'application/json': { schema: createHostSchema } } },
      },
      responses: {
        201: {
          description: 'Created host',
          content: { 'application/json': { schema: hostSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const entity = repository.createHost(c.req.valid('json'));
      c.header('ETag', etagFor(entity.version));
      return c.json(entity, 201);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/hosts/{id}',
      operationId: 'getHost',
      security,
      request: { params: idParamsSchema },
      responses: {
        200: { description: 'Host', content: { 'application/json': { schema: hostSchema } } },
        ...errors,
      },
    }),
    (c) => {
      const entity = repository.getHost(c.req.valid('param').id);
      c.header('ETag', etagFor(entity.version));
      return c.json(entity, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/hosts/{id}',
      operationId: 'updateHost',
      security,
      request: {
        params: idParamsSchema,
        body: { required: true, content: { 'application/json': { schema: updateHostSchema } } },
      },
      responses: {
        200: {
          description: 'Updated host',
          content: { 'application/json': { schema: hostSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const entity = repository.updateHost(
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.header('If-Match'),
      );
      c.header('ETag', etagFor(entity.version));
      return c.json(entity, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/hosts/{id}',
      operationId: 'deleteHost',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Deleted' }, ...errors },
    }),
    (c) => {
      repository.deleteHost(c.req.valid('param').id, c.req.header('If-Match'));
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/known-host-keys',
      operationId: 'listKnownHostKeys',
      security,
      responses: {
        200: {
          description: 'Application-local trusted SSH Host Keys',
          content: { 'application/json': { schema: z.array(knownHostKeySchema) } },
        },
        ...errors,
      },
    }),
    (c) => c.json(repository.listKnownHostKeys(), 200),
  );
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/v1/known-host-keys/{id}',
      operationId: 'deleteKnownHostKey',
      security,
      request: { params: idParamsSchema },
      responses: { 204: { description: 'Trust revoked' }, ...errors },
    }),
    (c) => {
      repository.deleteKnownHostKey(c.req.valid('param').id, c.req.header('If-Match'));
      return c.body(null, 204);
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/settings',
      operationId: 'getSettings',
      security,
      responses: {
        200: {
          description: 'Settings',
          content: { 'application/json': { schema: settingsSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const entity = repository.getSettings();
      c.header('ETag', etagFor(entity.version));
      return c.json(entity, 200);
    },
  );
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/v1/settings',
      operationId: 'updateSettings',
      security,
      request: {
        body: { required: true, content: { 'application/json': { schema: updateSettingsSchema } } },
      },
      responses: {
        200: {
          description: 'Settings',
          content: { 'application/json': { schema: settingsSchema } },
        },
        ...errors,
      },
    }),
    (c) => {
      const command = c.req.valid('json');
      if (command.terminal?.defaultProfileId)
        repository.getJson<TerminalProfile>('terminal_profiles', command.terminal.defaultProfileId);
      const entity = repository.updateSettings(command, c.req.header('If-Match'));
      c.header('ETag', etagFor(entity.version));
      return c.json(entity, 200);
    },
  );
}
