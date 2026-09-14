import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve, isAbsolute } from 'node:path';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { DesktopBootstrap } from '@workspace/contracts/desktop';
import {
  idSchema,
  RDP_FRAME_MAX_BYTES,
  VNC_FRAME_MAX_BYTES,
  SPICE_FRAME_MAX_BYTES,
  TERMINAL_CLIENT_PROTOCOL_PREFIX,
  TERMINAL_INPUT_FRAME_MAX_BYTES,
  type RuntimeMetadata,
} from '@workspace/contracts';
import { createRuntimeApp } from '../http/app';
import { RuntimeAuth } from './auth';
import { ProductDatabase } from '../adapters/sqlite/database';
import { ProductRepository } from '../adapters/sqlite/product-repository';
import { NodePtyAdapter } from '../adapters/pty/node-pty-adapter';
import { TerminalService, type TerminalSocket } from '../application/terminal-service';
import { WebSocketServer } from 'ws';
import { HostCapabilityClient } from '../adapters/host-capability/client';
import { Ssh2Transport } from '../adapters/ssh2/ssh2-transport';
import { RealtimeHub } from '../application/realtime-hub';
import { InteractionService } from '../application/interaction-service';
import { ConnectionService } from '../application/connection-service';
import { SftpService } from '../application/sftp-service';
import { TransferService } from '../application/transfer-service';
import { HostImportService } from '../application/host-import-service';
import { TunnelService } from '../application/tunnel-service';
import { AiToolService } from '../application/ai-tool-service';
import { AiService } from '../application/ai-service';
import { RuntimeLogger } from '../adapters/logging/runtime-logger';
import { DiagnosticService } from '../application/diagnostic-service';
import { BookmarkRepository } from '../adapters/sqlite/bookmark-repository';
import { BookmarkTreeService } from '../application/bookmark-tree-service';
import { QuickCommandRepository } from '../adapters/sqlite/quick-command-repository';
import { QuickCommandService } from '../application/quick-command-service';
import { BatchOperationRepository } from '../adapters/sqlite/batch-operation-repository';
import { BatchOperationService } from '../application/batch-operation-service';
import { TriggerRepository } from '../adapters/sqlite/trigger-repository';
import { TriggerService } from '../application/trigger-service';
import { SshBookmarkService } from '../application/ssh-bookmark-service';
import { ConnectionHistoryRepository } from '../adapters/sqlite/connection-history-repository';
import { ConnectionHistoryService } from '../application/connection-history-service';
import type { SshTransport } from '../ports/ssh-transport';
import { TcpProxyConnector } from '../adapters/proxy/tcp-proxy-connector';
import { ProxyService } from '../application/proxy-service';
import { StdioProxyCommandRunner } from '../adapters/proxy-command/stdio-proxy-command-runner';
import { CommandHistoryRepository } from '../adapters/sqlite/command-history-repository';
import { CommandHistoryService } from '../application/command-history-service';
import { ConnectionProfileRepository } from '../adapters/sqlite/connection-profile-repository';
import { ConnectionProfileService } from '../application/connection-profile-service';
import { ElectermDataService } from '../application/electerm-data-service';
import { ExternalEditorService } from '../application/external-editor-service';
import { FileComparisonService } from '../application/file-comparison-service';
import { BasicFtpAdapter } from '../adapters/ftp/basic-ftp-adapter';
import { FtpConnectionService } from '../application/ftp-connection-service';
import { NodeTelnetAdapter } from '../adapters/telnet/node-telnet-adapter';
import { TelnetService } from '../application/telnet-service';
import { NodeSerialAdapter } from '../adapters/serial/node-serial-adapter';
import { SerialService } from '../application/serial-service';
import { NodeRdpRelay } from '../adapters/rdp/node-rdp-relay';
import { RdpSessionService } from '../application/rdp-session-service';
import type { RdpRelaySocket } from '../ports/rdp-relay';
import { NodeVncRelay } from '../adapters/vnc/node-vnc-relay';
import { VncSessionService } from '../application/vnc-session-service';
import type { VncRelaySocket } from '../ports/vnc-relay';
import { NodeSpiceRelay } from '../adapters/spice/node-spice-relay';
import { SpiceSessionService } from '../application/spice-session-service';
import { WebSessionService } from '../application/web-session-service';
import { DeepLinkIntentService } from '../application/deep-link-intent-service';
import type { SpiceRelaySocket } from '../ports/spice-relay';
import { ElectermTerminalTransferAdapter } from '../adapters/terminal-transfer/electerm-terminal-transfer-adapter';
import { TerminalTransferService } from '../application/terminal-transfer-service';
import { TerminalInformationService } from '../application/terminal-information-service';
import { WidgetService } from '../application/widget-service';
import { NodeLocalFileServer } from '../adapters/widget/node-local-file-server';
import { ElectermLocalFtpServer } from '../adapters/widget/electerm-local-ftp-server';
import { NodeLocalSshServer } from '../adapters/widget/node-local-ssh-server';
import { NodeMcpServer } from '../adapters/widget/node-mcp-server';
import { TerminalThemeRepository } from '../adapters/sqlite/terminal-theme-repository';
import { TerminalThemeService } from '../application/terminal-theme-service';
import { TerminalBackgroundAssetService } from '../application/terminal-background-asset-service';
import { SyncProfileRepository } from '../adapters/sqlite/sync-profile-repository';
import { ElectermSyncDataSource } from '../adapters/data-sync/electerm-sync-data-source';
import {
  CustomSyncProvider,
  GistSyncProvider,
  WebDavSyncProvider,
} from '../adapters/data-sync/http-sync-providers';
import { DataSyncService } from '../application/data-sync-service';
import { DesktopLifecycleService } from '../application/desktop-lifecycle-service';

export interface RuntimeOptions {
  generation: string;
  appVersion: string;
  mode: 'desktop' | 'headless';
  devOrigin?: string;
  rendererDirectory?: string;
  dataDirectory?: string;
  hostCapabilityUrl?: string;
  hostCapabilityToken?: string;
  runtimeIngressToken?: string;
  sshTransport?: SshTransport;
  onReady?(bootstrap: DesktopBootstrap): void;
}

export async function startRuntime(options: RuntimeOptions) {
  if (options.rendererDirectory) {
    if (!isAbsolute(options.rendererDirectory))
      throw new Error('Renderer directory must be absolute');
    await access(resolve(options.rendererDirectory, 'index.html'));
  }
  const runtimeLogger = await RuntimeLogger.create(
    options.dataDirectory ? join(options.dataDirectory, 'logs') : undefined,
  );
  const auth = new RuntimeAuth();
  const database = await ProductDatabase.open(
    options.dataDirectory ? join(options.dataDirectory, 'axterm.sqlite') : ':memory:',
  );
  database.recordAppVersion(options.appVersion);
  const repository = new ProductRepository(database);
  const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
  const quickCommands = new QuickCommandService(new QuickCommandRepository(database));
  const sshBookmarks = new SshBookmarkService(database, repository, bookmarks);
  const connectionHistory = new ConnectionHistoryService(
    database,
    new ConnectionHistoryRepository(database),
    repository,
    bookmarks,
  );
  repository.recoverInterruptedWork();
  const terminals = new TerminalService(new NodePtyAdapter());
  const terminalTransfers = new TerminalTransferService(
    terminals,
    new ElectermTerminalTransferAdapter(),
  );
  const commandHistory = new CommandHistoryService(
    database,
    new CommandHistoryRepository(database),
    repository,
    terminals,
  );
  const connectionProfiles = new ConnectionProfileService(
    new ConnectionProfileRepository(database),
  );
  const hostCapabilities =
    options.hostCapabilityUrl && options.hostCapabilityToken
      ? new HostCapabilityClient(options.hostCapabilityUrl, options.hostCapabilityToken)
      : undefined;
  const terminalThemes = new TerminalThemeService(
    new TerminalThemeRepository(repository),
    hostCapabilities,
  );
  const terminalBackgroundAssets = new TerminalBackgroundAssetService(
    options.dataDirectory ? join(options.dataDirectory, 'terminal-backgrounds') : undefined,
    hostCapabilities,
  );
  if (hostCapabilities) terminals.setDataInterceptor(terminalTransfers);
  const electermData = new ElectermDataService(
    database,
    repository,
    bookmarks,
    sshBookmarks,
    connectionProfiles,
    quickCommands,
    hostCapabilities,
  );
  const realtime = new RealtimeHub();
  const desktopLifecycle = hostCapabilities
    ? new DesktopLifecycleService(hostCapabilities, realtime)
    : undefined;
  desktopLifecycle?.start();
  const deepLinks = new DeepLinkIntentService(realtime);
  const interactions = new InteractionService(realtime);
  const triggers = new TriggerService(
    new TriggerRepository(database),
    terminals,
    realtime,
    bookmarks,
  );
  const syncDataSource = new ElectermSyncDataSource(
    electermData,
    repository,
    terminalThemes,
    quickCommands,
    triggers,
    options.appVersion,
  );
  const dataSync = new DataSyncService(
    new SyncProfileRepository(database),
    [
      new GistSyncProvider('github'),
      new GistSyncProvider('gitee'),
      new WebDavSyncProvider(),
      new CustomSyncProvider(),
    ],
    syncDataSource,
    hostCapabilities
      ? {
          resolve: (ref) => hostCapabilities.resolveCredential(ref),
          delete: (ref) => hostCapabilities.deleteCredential(ref),
        }
      : undefined,
  );
  const proxies = new ProxyService(
    repository,
    new TcpProxyConnector(),
    hostCapabilities,
    new StdioProxyCommandRunner(),
  );
  const connections = new ConnectionService(
    repository,
    options.sshTransport ?? new Ssh2Transport(),
    hostCapabilities,
    interactions,
    realtime,
    terminals,
    connectionHistory,
    proxies,
    connectionProfiles,
  );
  const terminalInformation = new TerminalInformationService(terminals, connections);
  const widgets = new WidgetService(
    options.generation,
    hostCapabilities,
    new NodeLocalFileServer(),
    new ElectermLocalFtpServer(),
    new NodeLocalSshServer(),
    realtime,
    new NodeMcpServer(),
  );
  const batchOperations = new BatchOperationService(
    new BatchOperationRepository(database),
    repository,
    bookmarks,
    connections,
    realtime,
  );
  const sftp = new SftpService(connections);
  const ftpConnections = new FtpConnectionService(
    bookmarks,
    connectionProfiles,
    hostCapabilities,
    new BasicFtpAdapter(),
  );
  const ftpFiles = new SftpService({
    handle: (connectionId) => ({ openSftp: () => ftpConnections.openFiles(connectionId) }),
  });
  const telnet = new TelnetService(
    bookmarks,
    connectionProfiles,
    hostCapabilities,
    new NodeTelnetAdapter(),
    terminals,
  );
  const serial = new SerialService(bookmarks, new NodeSerialAdapter(), terminals);
  const rdp = new RdpSessionService(
    bookmarks,
    connectionProfiles,
    hostCapabilities,
    new NodeRdpRelay(),
    proxies,
    connections,
  );
  const vnc = new VncSessionService(
    bookmarks,
    connectionProfiles,
    hostCapabilities,
    new NodeVncRelay(),
    proxies,
    connections,
  );
  const spice = new SpiceSessionService(
    bookmarks,
    connectionProfiles,
    hostCapabilities,
    new NodeSpiceRelay(),
    proxies,
    connections,
  );
  const web = new WebSessionService(bookmarks, hostCapabilities);
  const externalEditors = new ExternalEditorService(sftp, hostCapabilities, repository);
  const fileComparisons = new FileComparisonService(sftp, hostCapabilities);
  const transfers = new TransferService(
    connections,
    hostCapabilities,
    repository,
    realtime,
    ftpConnections,
  );
  const hostImporter = new HostImportService(hostCapabilities, database, repository, bookmarks);
  const tunnels = new TunnelService(connections, repository, realtime);
  const aiTools = new AiToolService(repository, terminals, connections, sftp);
  const ai = new AiService(repository, hostCapabilities, realtime, aiTools);
  widgets.setMcpToolGateway({
    listTools: () => aiTools.mcpTools(),
    callTool: (name, args, idempotencyKey) =>
      ai.invokeRegisteredTool(aiTools.mcpProposal(name, args), idempotencyKey),
  });
  const diagnostics = new DiagnosticService(
    options.generation,
    Date.now(),
    () => ({
      terminals: terminals.resourceCount(),
      terminalStartupSequences: terminals.startupSequenceCount(),
      terminalInformationCaches: terminalInformation.cacheCount(),
      terminalInformationRequests: terminalInformation.inFlightCount(),
      widgetInstances: widgets.resourceCount(),
      terminalTransfers: terminalTransfers.resourceCount(),
      connections: connections.resourceCount(),
      batchOperations: batchOperations.resourceCount(),
      triggerSessions: triggers.resourceCount(),
      ftpConnections: ftpConnections.resourceCount(),
      transfers: transfers.resourceCount(),
      externalEditors: externalEditors.resourceCount(),
      tunnels: tunnels.resourceCount(),
      interactions: interactions.resourceCount(),
      rdpSessions: rdp.resourceCount(),
      vncSessions: vnc.resourceCount(),
      spiceSessions: spice.resourceCount(),
      webSessions: web.resourceCount(),
      realtimeSubscribers: realtime.count(),
      syncRuns: dataSync.resourceCount(),
      desktopLifecycle: desktopLifecycle?.resourceCount() ?? 0,
    }),
    hostCapabilities,
    runtimeLogger,
  );
  const metadata: RuntimeMetadata = {
    runtimeId: randomUUID(),
    generation: options.generation,
    state: 'ready',
    startedAt: new Date().toISOString(),
    pid: process.pid,
    mode: options.mode,
  };
  let baseUrl = 'http://127.0.0.1:1';
  const bootstrap = (): DesktopBootstrap => ({
    baseUrl,
    apiVersion: 'v1',
    appVersion: options.appVersion,
    runtimeId: metadata.runtimeId,
    generation: metadata.generation,
    bootstrapToken: auth.currentBootstrap(),
  });
  const publishReady = () => options.onReady?.(bootstrap());
  const app = createRuntimeApp({
    auth,
    metadata,
    appVersion: options.appVersion,
    getOrigin: () => baseUrl,
    ...(options.devOrigin ? { devOrigin: options.devOrigin } : {}),
    onBootstrapRotated: publishReady,
    repository,
    bookmarks,
    sshBookmarks,
    terminals,
    terminalTransfers,
    terminalInformation,
    widgets,
    ...(hostCapabilities ? { hostCapabilities } : {}),
    connections,
    proxies,
    connectionHistory,
    commandHistory,
    connectionProfiles,
    quickCommands,
    terminalThemes,
    terminalBackgroundAssets,
    batchOperations,
    triggers,
    electermData,
    dataSync,
    interactions,
    sftp,
    ftpConnections,
    ftpFiles,
    telnet,
    serial,
    rdp,
    vnc,
    spice,
    web,
    deepLinks,
    ...(options.runtimeIngressToken ? { runtimeIngressToken: options.runtimeIngressToken } : {}),
    externalEditors,
    fileComparisons,
    transfers,
    realtime,
    hostImporter,
    tunnels,
    ai,
    diagnostics,
    logger: runtimeLogger.logger,
  });
  if (options.rendererDirectory) {
    app.use('*', async (c, next) => {
      c.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      );
      await next();
    });
    // Only built assets and the entry document are served. No SPA fallback for API paths.
    const staticOptions = { root: options.rendererDirectory };
    app.get('/assets/*', serveStatic(staticOptions));
    app.get('/', serveStatic({ ...staticOptions, path: 'index.html' }));
    app.get('/index.html', serveStatic(staticOptions));
  }
  const server = createServer(getRequestListener(app.fetch));
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: TERMINAL_INPUT_FRAME_MAX_BYTES,
    handleProtocols(protocols) {
      return protocols.has('terminal.v1') ? 'terminal.v1' : false;
    },
  });
  const rdpWebSockets = new WebSocketServer({
    noServer: true,
    maxPayload: RDP_FRAME_MAX_BYTES,
    handleProtocols(protocols) {
      return protocols.has('rdp.v1') ? 'rdp.v1' : false;
    },
  });
  const vncWebSockets = new WebSocketServer({
    noServer: true,
    maxPayload: VNC_FRAME_MAX_BYTES,
    handleProtocols(protocols) {
      return protocols.has('vnc.v1') ? 'vnc.v1' : false;
    },
  });
  const spiceWebSockets = new WebSocketServer({
    noServer: true,
    maxPayload: SPICE_FRAME_MAX_BYTES,
    handleProtocols(protocols) {
      return protocols.has('spice.v1') ? 'spice.v1' : false;
    },
  });
  server.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(request.url ?? '/', baseUrl);
    const terminalMatch = /^\/api\/v1\/terminals\/([0-9a-f-]{36})\/stream$/.exec(
      requestUrl.pathname,
    );
    const rdpMatch = /^\/api\/v1\/rdp\/sessions\/([0-9a-f-]{36})\/stream$/.exec(
      requestUrl.pathname,
    );
    const vncMatch = /^\/api\/v1\/vnc\/sessions\/([0-9a-f-]{36})\/stream$/.exec(
      requestUrl.pathname,
    );
    const spiceMatch = /^\/api\/v1\/spice\/sessions\/([0-9a-f-]{36})\/stream$/.exec(
      requestUrl.pathname,
    );
    const protocols = (request.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((value) => value.trim());
    const authProtocol = protocols.find((value) => value.startsWith('auth.'));
    const clientProtocol = protocols.find((value) =>
      value.startsWith(TERMINAL_CLIENT_PROTOCOL_PREFIX),
    );
    const clientId = idSchema.safeParse(
      clientProtocol?.slice(TERMINAL_CLIENT_PROTOCOL_PREFIX.length),
    );
    const expectedOrigin = options.devOrigin ?? baseUrl;
    if (
      (!terminalMatch && !rdpMatch && !vncMatch && !spiceMatch) ||
      requestUrl.search ||
      request.headers.host !== new URL(baseUrl).host ||
      request.headers.origin !== expectedOrigin ||
      !auth.authorizeToken(authProtocol?.slice('auth.'.length))
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const terminalId = terminalMatch?.[1];
    const rdpId = rdpMatch?.[1];
    const vncId = vncMatch?.[1];
    const spiceId = spiceMatch?.[1];
    if (terminalId && protocols.includes('terminal.v1') && clientId.success) {
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSockets.emit('connection', webSocket, request);
        try {
          terminals.attach(terminalId, webSocket as unknown as TerminalSocket, clientId.data);
        } catch {
          webSocket.close(1008, 'terminal unavailable');
        }
      });
      return;
    }
    if (rdpId && protocols.includes('rdp.v1')) {
      rdpWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        rdpWebSockets.emit('connection', webSocket, request);
        void rdp.attach(rdpId, webSocket as unknown as RdpRelaySocket).catch(() => {
          webSocket.close(1008, 'rdp unavailable');
        });
      });
      return;
    }
    if (vncId && protocols.includes('vnc.v1')) {
      vncWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        vncWebSockets.emit('connection', webSocket, request);
        void vnc.attach(vncId, webSocket as unknown as VncRelaySocket).catch(() => {
          webSocket.close(1008, 'vnc unavailable');
        });
      });
      return;
    }
    if (spiceId && protocols.includes('spice.v1')) {
      spiceWebSockets.handleUpgrade(request, socket, head, (webSocket) => {
        spiceWebSockets.emit('connection', webSocket, request);
        void spice.attach(spiceId, webSocket as unknown as SpiceRelaySocket).catch(() => {
          webSocket.close(1008, 'spice unavailable');
        });
      });
      return;
    }
    if (!terminalId && !rdpId && !vncId && !spiceId) {
      socket.destroy();
      return;
    }
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 2_000;
  server.maxConnections = 64;
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Runtime did not bind TCP');
  baseUrl = `http://127.0.0.1:${address.port}`;
  // A ready refresh contains discovery data only; it is not a business RPC.
  const rotation = setInterval(() => {
    auth.rotateBootstrap();
    publishReady();
  }, 25_000);
  let closed: Promise<void> | undefined;
  const close = () => {
    closed ??= (async () => {
      clearInterval(rotation);
      desktopLifecycle?.close();
      auth.dispose();
      const serverClosed = new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
      server.closeAllConnections();
      webSockets.close();
      rdpWebSockets.close();
      vncWebSockets.close();
      spiceWebSockets.close();
      await spice.closeAll();
      await web.closeAll();
      deepLinks.clear();
      await vnc.closeAll();
      await rdp.closeAll();
      triggers.close();
      terminalInformation.dispose();
      await widgets.closeAll();
      await terminals.closeAll();
      terminalTransfers.closeAll();
      await externalEditors.closeAll();
      await batchOperations.closeAll();
      await transfers.closeAll();
      await tunnels.closeAll();
      await ftpConnections.closeAll();
      await connections.closeAll();
      interactions.close();
      await ai.close();
      await dataSync.close();
      syncDataSource.close();
      electermData.close();
      realtime.close();
      await serverClosed;
      database.close();
      runtimeLogger.close();
    })();
    return closed;
  };
  try {
    publishReady();
  } catch (error) {
    await close();
    throw error;
  }
  return { baseUrl, metadata, bootstrap, close };
}
