import { readFile, writeFile } from 'node:fs/promises';
import { createRuntimeApp } from '../packages/runtime/src/http/app';
import { RuntimeAuth } from '../packages/runtime/src/bootstrap/auth';
import { generateClient } from '../packages/client/scripts/generate';
import { APP_VERSION } from '../packages/shared/src/index';
import { ProductDatabase } from '../packages/runtime/src/adapters/sqlite/database';
import { ProductRepository } from '../packages/runtime/src/adapters/sqlite/product-repository';
import { TerminalService } from '../packages/runtime/src/application/terminal-service';
import type { PtyPort } from '../packages/runtime/src/ports/terminal-channel';
import { RealtimeHub } from '../packages/runtime/src/application/realtime-hub';
import { InteractionService } from '../packages/runtime/src/application/interaction-service';
import { ConnectionService } from '../packages/runtime/src/application/connection-service';
import type { SshTransport } from '../packages/runtime/src/ports/ssh-transport';
import { SftpService } from '../packages/runtime/src/application/sftp-service';
import { TransferService } from '../packages/runtime/src/application/transfer-service';
import { HostImportService } from '../packages/runtime/src/application/host-import-service';
import { TunnelService } from '../packages/runtime/src/application/tunnel-service';
import { AiToolService } from '../packages/runtime/src/application/ai-tool-service';
import { AiService } from '../packages/runtime/src/application/ai-service';
import { RuntimeLogger } from '../packages/runtime/src/adapters/logging/runtime-logger';
import { DiagnosticService } from '../packages/runtime/src/application/diagnostic-service';
import { TerminalTransferService } from '../packages/runtime/src/application/terminal-transfer-service';
import { TerminalInformationService } from '../packages/runtime/src/application/terminal-information-service';
import { ElectermTerminalTransferAdapter } from '../packages/runtime/src/adapters/terminal-transfer/electerm-terminal-transfer-adapter';
import { BookmarkRepository } from '../packages/runtime/src/adapters/sqlite/bookmark-repository';
import { BookmarkTreeService } from '../packages/runtime/src/application/bookmark-tree-service';
import { QuickCommandRepository } from '../packages/runtime/src/adapters/sqlite/quick-command-repository';
import { QuickCommandService } from '../packages/runtime/src/application/quick-command-service';
import { BatchOperationRepository } from '../packages/runtime/src/adapters/sqlite/batch-operation-repository';
import { BatchOperationService } from '../packages/runtime/src/application/batch-operation-service';
import { TriggerRepository } from '../packages/runtime/src/adapters/sqlite/trigger-repository';
import { TriggerService } from '../packages/runtime/src/application/trigger-service';
import { SshBookmarkService } from '../packages/runtime/src/application/ssh-bookmark-service';
import { ConnectionHistoryRepository } from '../packages/runtime/src/adapters/sqlite/connection-history-repository';
import { ConnectionHistoryService } from '../packages/runtime/src/application/connection-history-service';
import { ProxyService } from '../packages/runtime/src/application/proxy-service';
import { TcpProxyConnector } from '../packages/runtime/src/adapters/proxy/tcp-proxy-connector';
import { CommandHistoryRepository } from '../packages/runtime/src/adapters/sqlite/command-history-repository';
import { CommandHistoryService } from '../packages/runtime/src/application/command-history-service';
import { ConnectionProfileRepository } from '../packages/runtime/src/adapters/sqlite/connection-profile-repository';
import { ConnectionProfileService } from '../packages/runtime/src/application/connection-profile-service';
import { ElectermDataService } from '../packages/runtime/src/application/electerm-data-service';
import { FtpConnectionService } from '../packages/runtime/src/application/ftp-connection-service';
import type { FtpTransport } from '../packages/runtime/src/ports/ftp-transport';
import { TelnetService } from '../packages/runtime/src/application/telnet-service';
import type { TelnetTransport } from '../packages/runtime/src/ports/telnet-transport';
import { SerialService } from '../packages/runtime/src/application/serial-service';
import type { SerialTransport } from '../packages/runtime/src/ports/serial-transport';
import { RdpSessionService } from '../packages/runtime/src/application/rdp-session-service';
import type { RdpRelay } from '../packages/runtime/src/ports/rdp-relay';
import { VncSessionService } from '../packages/runtime/src/application/vnc-session-service';
import type { VncRelay } from '../packages/runtime/src/ports/vnc-relay';
import { SpiceSessionService } from '../packages/runtime/src/application/spice-session-service';
import type { SpiceRelay } from '../packages/runtime/src/ports/spice-relay';
import { WebSessionService } from '../packages/runtime/src/application/web-session-service';
import { DeepLinkIntentService } from '../packages/runtime/src/application/deep-link-intent-service';
import { WidgetService } from '../packages/runtime/src/application/widget-service';
import { NodeLocalFileServer } from '../packages/runtime/src/adapters/widget/node-local-file-server';
import { ElectermLocalFtpServer } from '../packages/runtime/src/adapters/widget/electerm-local-ftp-server';
import { NodeLocalSshServer } from '../packages/runtime/src/adapters/widget/node-local-ssh-server';
import { TerminalThemeRepository } from '../packages/runtime/src/adapters/sqlite/terminal-theme-repository';
import { TerminalThemeService } from '../packages/runtime/src/application/terminal-theme-service';
import { TerminalBackgroundAssetService } from '../packages/runtime/src/application/terminal-background-asset-service';
import type { DataSyncService } from '../packages/runtime/src/application/data-sync-service';

const auth = new RuntimeAuth();
const database = await ProductDatabase.open();
const unavailablePty: PtyPort = {
  open() {
    throw new Error('Unavailable during contract generation');
  },
};
const terminalService = new TerminalService(unavailablePty);
const realtime = new RealtimeHub();
const deepLinks = new DeepLinkIntentService(realtime);
const interactions = new InteractionService(realtime);
const triggers = new TriggerService(new TriggerRepository(database), terminalService, realtime);
const unavailableSsh: SshTransport = {
  async connect() {
    throw new Error('Unavailable during contract generation');
  },
};
const repository = new ProductRepository(database);
const bookmarks = new BookmarkTreeService(new BookmarkRepository(database));
const quickCommands = new QuickCommandService(new QuickCommandRepository(database));
const terminalThemes = new TerminalThemeService(new TerminalThemeRepository(repository), undefined);
const terminalBackgroundAssets = new TerminalBackgroundAssetService(undefined, undefined);
const sshBookmarks = new SshBookmarkService(database, repository, bookmarks);
const connectionHistory = new ConnectionHistoryService(
  database,
  new ConnectionHistoryRepository(database),
  repository,
  bookmarks,
);
const commandHistory = new CommandHistoryService(
  database,
  new CommandHistoryRepository(database),
  repository,
  terminalService,
);
const connectionProfiles = new ConnectionProfileService(new ConnectionProfileRepository(database));
const electermData = new ElectermDataService(
  database,
  repository,
  bookmarks,
  sshBookmarks,
  connectionProfiles,
  quickCommands,
);
const connections = new ConnectionService(
  repository,
  unavailableSsh,
  undefined,
  interactions,
  realtime,
  terminalService,
  connectionHistory,
  undefined,
  connectionProfiles,
);
const terminalInformation = new TerminalInformationService(terminalService, connections);
const widgets = new WidgetService(
  '00000000-0000-4000-8000-000000000002',
  undefined,
  new NodeLocalFileServer(),
  new ElectermLocalFtpServer(),
  new NodeLocalSshServer(),
  realtime,
);
const batchOperations = new BatchOperationService(
  new BatchOperationRepository(database),
  repository,
  bookmarks,
  connections,
  realtime,
);
const proxies = new ProxyService(repository, new TcpProxyConnector());
const sftp = new SftpService(connections);
const unavailableFtp: FtpTransport = {
  async connect() {
    throw new Error('Unavailable during contract generation');
  },
};
const ftpConnections = new FtpConnectionService(
  bookmarks,
  connectionProfiles,
  undefined,
  unavailableFtp,
);
const ftpFiles = new SftpService({
  handle: (connectionId) => ({ openSftp: () => ftpConnections.openFiles(connectionId) }),
});
const unavailableTelnet: TelnetTransport = {
  async connect() {
    throw new Error('Unavailable during contract generation');
  },
};
const telnet = new TelnetService(
  bookmarks,
  connectionProfiles,
  undefined,
  unavailableTelnet,
  terminalService,
);
const unavailableSerial: SerialTransport = {
  async list() {
    return [];
  },
  async open() {
    throw new Error('Unavailable during contract generation');
  },
};
const serial = new SerialService(bookmarks, unavailableSerial, terminalService);
const terminalTransfers = new TerminalTransferService(
  terminalService,
  new ElectermTerminalTransferAdapter(),
);
const unavailableRdp: RdpRelay = {
  async attach() {
    throw new Error('Unavailable during contract generation');
  },
};
const rdp = new RdpSessionService(
  bookmarks,
  connectionProfiles,
  undefined,
  unavailableRdp,
  proxies,
  connections,
);
const unavailableVnc: VncRelay = {
  async attach() {
    throw new Error('Unavailable during contract generation');
  },
};
const vnc = new VncSessionService(
  bookmarks,
  connectionProfiles,
  undefined,
  unavailableVnc,
  proxies,
  connections,
);
const unavailableSpice: SpiceRelay = {
  async attach() {
    throw new Error('Unavailable during contract generation');
  },
};
const spice = new SpiceSessionService(
  bookmarks,
  connectionProfiles,
  undefined,
  unavailableSpice,
  proxies,
  connections,
);
const web = new WebSessionService(bookmarks, undefined);
const transfers = new TransferService(connections, undefined, repository, realtime, ftpConnections);
const hostImporter = new HostImportService(undefined, database, repository, bookmarks);
const tunnels = new TunnelService(connections, repository, realtime);
const aiTools = new AiToolService(repository, terminalService, connections, sftp);
const ai = new AiService(repository, undefined, realtime, aiTools);
const runtimeLogger = await RuntimeLogger.create();
const diagnostics = new DiagnosticService(
  '00000000-0000-4000-8000-000000000002',
  Date.now(),
  () => ({}),
  undefined,
  runtimeLogger,
);
const app = createRuntimeApp({
  auth,
  appVersion: APP_VERSION,
  metadata: {
    runtimeId: '00000000-0000-4000-8000-000000000001',
    generation: '00000000-0000-4000-8000-000000000002',
    state: 'ready',
    startedAt: '2026-09-10T00:00:00.000Z',
    pid: 1,
    mode: 'headless',
  },
  getOrigin: () => 'http://127.0.0.1:1',
  onBootstrapRotated() {},
  repository,
  bookmarks,
  sshBookmarks,
  terminals: terminalService,
  terminalTransfers,
  terminalInformation,
  widgets,
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
  dataSync: {} as DataSyncService,
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
  transfers,
  realtime,
  hostImporter,
  tunnels,
  ai,
  diagnostics,
  logger: runtimeLogger.logger,
});
const document = app.getOpenAPI31Document({
  openapi: '3.1.0',
  info: { title: 'Axterm Runtime API', version: APP_VERSION },
});
const ids = new Set<string>();
for (const route of Object.values(document.paths ?? {})) {
  for (const operation of Object.values(route ?? {})) {
    if (typeof operation !== 'object' || !operation || !('operationId' in operation)) continue;
    const id = operation.operationId;
    if (typeof id !== 'string' || ids.has(id))
      throw new Error('Missing or duplicate OpenAPI operationId');
    ids.add(id);
  }
}
const json = JSON.stringify(document, null, 2) + '\n';
const schemaPath = 'docs/api/openapi.json';
const clientPath = 'packages/client/src/generated/api.ts';
const mode = process.argv[2];
if (mode === 'openapi') await writeFile(schemaPath, json);
else if (mode === 'client')
  await writeFile(clientPath, await generateClient(await readFile(schemaPath, 'utf8')));
else if (mode === 'check') {
  const client = await generateClient(json);
  for (const [path, expected] of [
    [schemaPath, json],
    [clientPath, client],
  ] as const) {
    if ((await readFile(path, 'utf8')) !== expected)
      throw new Error(`${path} drifted; regenerate OpenAPI and client`);
  }
  console.info(`Contract drift check passed (${ids.size} operations).`);
} else throw new Error('Expected openapi, client or check');
auth.dispose();
database.close();
runtimeLogger.close();
