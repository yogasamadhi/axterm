import { readFile, readdir, writeFile } from 'node:fs/promises';
import { remoteDeclarations } from './level3-operation-map.mjs';
const map = JSON.parse(
    await readFile('tests/fixtures/engineering/level3/operation-map.json', 'utf8'),
  ),
  actual = new Map();
async function walk(path) {
  for (const f of await readdir(path, { withFileTypes: true })) {
    const p = path + '/' + f.name;
    if (f.isDirectory()) {
      if (f.name !== 'client') await walk(p);
    } else if (f.name.endsWith('.ts') && !f.name.endsWith('.test.ts'))
      for (const [target] of remoteDeclarations(await readFile(p, 'utf8'))) actual.set(target, p);
  }
}
await walk('packages/plugins');
const tests = [
  ...(await readdir('tests/integration')).map((x) => 'tests/integration/' + x),
  ...(await readdir('tests/unit')).map((x) => 'tests/unit/' + x),
].filter((x) => x.endsWith('.test.ts'));
const alias = {};
const put = (id, ns, ...methods) => (alias[id] = { namespace: ns, methods });
for (const row of map.operations)
  if (row.namespace === 'ai') {
    let method = row.operationId.replace(/Ai/, '');
    if (row.operationId.startsWith('ai')) method = 'startRun';
    if (row.operationId.startsWith('listAi')) method = 'watchAi';
    if (['listAiApprovals', 'listAiToolCalls'].includes(row.operationId)) method = 'getTools';
    if (row.operationId === 'streamAiRun') method = 'watchRunLog';
    put(
      row.operationId,
      'ai',
      method,
      ...(row.operationId === 'listAiProviders'
        ? ['getProvider']
        : row.operationId === 'listAiRuns'
          ? ['getRun']
          : row.operationId === 'streamAiRun'
            ? ['getLog', 'getRun']
            : []),
    );
  }
for (const [id, method] of Object.entries({
  backupSyncRemote: 'runSync',
  cancelAxtermConfigurationPreview: 'cancelConfigurationPreview',
  cancelAxtermSyncDownload: 'cancelSyncDownload',
  cancelDataSyncRun: 'cancelSync',
  commitAxtermConfigurationImport: 'importConfiguration',
  commitAxtermSyncDownload: 'commitSyncDownload',
  compareSyncProfile: 'runSync',
  exportAxtermConfiguration: 'exportConfiguration',
  getAxtermSyncDownloadPreview: 'getSyncDownloadPreview',
  inspectAxtermConfiguration: 'inspectConfiguration',
  listSyncProfiles: 'watchSync',
  previewAxtermConfiguration: 'previewConfiguration',
  previewAxtermSyncDownload: 'runSync',
  runDataSync: 'runSync',
  testSyncProfile: 'runSync',
}))
  put(id, 'configuration', method);
for (const [id, method] of Object.entries({
  createCredentialReference: 'createCredential',
  replaceCredential: 'replaceCredential',
  deleteCredential: 'deleteCredential',
  listCredentialMetadata: 'listCredentials',
}))
  put(id, 'configuration', method);
for (const [id, method] of Object.entries({
  cancelInteraction: 'respondInteraction',
  listPendingInteractions: 'listInteractions',
  respondInteraction: 'respondInteraction',
  listActiveConnections: 'listConnections',
  probeSshAgent: 'sshAgentStatus',
}))
  put(id, 'connections', method);
for (const id of [
  'claimRdpSessionCredentials',
  'claimVncSessionCredentials',
  'claimSpiceSessionCredentials',
])
  put(id, 'remoteDesktop', 'getSession');
for (const [id, method] of Object.entries({
  getRemoteHomeDirectory: 'getRemoteHome',
  listRemoteFiles: 'listRemoteDirectory',
  listFtpFiles: 'listRemoteDirectory',
  statRemoteFile: 'statRemoteEntry',
  createRemoteDirectory: 'createRemoteEntry',
  createRemoteFile: 'createRemoteEntry',
  createFtpDirectory: 'createRemoteEntry',
  createFtpFile: 'createRemoteEntry',
  deleteFtpPath: 'deleteRemoteEntry',
  deleteRemotePath: 'deleteRemoteEntry',
  renameFtpPath: 'renameRemoteEntry',
  renameRemotePath: 'renameRemoteEntry',
  chmodRemotePath: 'chmodRemoteEntry',
  copyGrantedEntryPaths: 'listGrantedDirectory',
}))
  put(id, 'files', method);
for (const id of [
  'uploadFtp',
  'uploadRemote',
  'downloadFtp',
  'downloadRemote',
  'copyRemoteToRemote',
])
  put(id, 'transfers', 'createTransfer', 'getTransfer', 'watchTransfers');
put(
  'importHosts',
  'catalog',
  'previewSshConfigImport',
  'commitSshConfigImport',
  'getSshConfigImportReport',
);
put('openExternalUrl', 'desktop', 'openExternal');
put('claimNextDesktopDeepLink', 'desktop', 'watchDesktopLaunches');
put('enqueueDesktopDeepLink', 'desktop', 'watchDesktopLaunches');
const eventOwners = [
  ['catalog', 'watchCatalog'],
  ['configuration', 'watchSettings'],
  ['configuration', 'watchSync'],
  ['connections', 'watchConnections'],
  ['terminals', 'watchTerminalFacts'],
  ['transfers', 'watchTransfers'],
  ['automation', 'watchAutomation'],
  ['ai', 'watchAi'],
];
const special = {
  authBootstrap: {
    kind: 'service',
    module: '@axterm/infra-connection',
    source: 'packages/infra/connection/src/rpc-host.ts',
    namespace: 'connection',
    className: 'HostConnectionService',
    methods: ['authorizeConnect'],
  },
  authLogout: {
    kind: 'service',
    module: '@axterm/infra-connection',
    source: 'packages/infra/connection/src/rpc-host.ts',
    namespace: 'connection',
    className: 'HostConnectionService',
    methods: ['authorizeConnect'],
  },
  getCapabilities: {
    kind: 'service',
    module: '@axterm/infra-client-modules',
    source: 'packages/infra/client-modules/src/index.ts',
    namespace: 'clientModules',
    className: 'ClientModuleRegistry',
    methods: ['graph'],
  },
  getDesktopWindowState: {
    kind: 'client-service',
    module: '@axterm/plugin-desktop',
    source: 'packages/plugins/desktop/src/client/shortcuts.ts',
    namespace: 'desktopWindowUi',
    functionName: 'installDesktopShortcuts',
    methods: ['getState'],
  },
  performDesktopWindowAction: {
    kind: 'client-service',
    module: '@axterm/plugin-desktop',
    source: 'packages/plugins/desktop/src/client/shortcuts.ts',
    namespace: 'desktopWindowUi',
    functionName: 'installDesktopShortcuts',
    methods: ['act'],
  },
  importDroppedFileGrant: {
    kind: 'client-service',
    module: '@axterm/plugin-files',
    source: 'packages/plugins/files/src/client/index.ts',
    namespace: 'fileGrantActions',
    functionName: 'apply',
    methods: ['importFile'],
  },
};
const semantics = {
  ai: 'Application-owned Session/Run/provider/model facts and visible journal replace legacy AI calls. Complete metadata baseline plus explicit detail/paged reads; shortcut calls use startRun with the original use case, generation/idempotency key and unchanged approval/budget/no-silent-execution policy.',
  configuration:
    'Configuration owns versioned facts/credential references and immutable command outcomes; portable and sync inspect/preview/commit/cancel use their existing workflow owners. runSync operation selects test/compare/upload/download-preview/backup; no raw secrets or legacy REST.',
  catalog:
    'Catalog owns transactional bookmarks/hosts/profiles/history. SSH-config import is explicit preview, commit and report with the original reviewed input; no automatic credential discovery.',
  connections:
    'The Connections owner publishes live connection/tunnel/interaction facts. Explicit cancel/reject responses stop the original interaction; SSH-agent probing stays in its owning service.',
  files:
    'Files owns generation-bound authority and remote target/path validation. FTP/SFTP share typed target operations; clipboard path copying uses validated metadata then the existing browser clipboard action, with no command execution.',
  transfers:
    'Transfer creation selects upload/download/remote-copy and owns actual IO, progress, conflict, limits and cancellation. Browser uploads use the Files streaming import; authorized local-file HTTP streams carry bytes. No whole-file Base64 or automatic retry.',
  terminals:
    'Terminals owns profile/theme/history/session facts and bounded binary channels; original command keys and generation checks remain. Stdin/stdout bytes never become model state.',
  remoteDesktop:
    'Owning session admission, dedicated protocol assets/credential bridge and bounded binary transport replace per-protocol legacy calls. Credential claiming is guest-scoped, not a public credential-returning business RPC.',
  desktop:
    'Desktop owns runtime/window/OS launch behavior. External links use the narrow Shell owner; OS/CLI launch producer and generated launch stream replace the old enqueue/poll facade.',
};
function moduleFor(source) {
  return '@axterm/plugin-' + source.split('/')[2];
}
function binding(ns, method) {
  const source = actual.get(ns + '.' + method);
  return source
    ? { kind: 'remote', module: moduleFor(source), source, namespace: ns, methods: [method] }
    : undefined;
}
put('listAiModels', 'ai', 'watchAi', 'getModel');
put('listAiConversations', 'ai', 'watchAi', 'getConversation');
put('listAiApprovals', 'ai', 'watchAi', 'getTools');
put('listAiToolCalls', 'ai', 'watchAi', 'getTools', 'getToolCall');
put('getRuntimeDiagnostics', 'desktop', 'getDiagnostics');
put('getDesktopUpdaterStatus', 'desktop', 'getUpdaterStatus');
put('performDesktopUpdaterAction', 'desktop', 'performUpdaterAction');
const gaps = {};
const rows = [];
for (const old of map.operations) {
  let replacements,
    note = semantics[old.namespace] ?? 'Owner replacement retains the frozen capability.';
  if (gaps[old.operationId]) {
    rows.push({
      operationId: old.operationId,
      state: 'gap',
      reason: gaps[old.operationId],
      finalAcceptance:
        'Final source-free package and operation-map verification remain checklist 20.',
    });
    continue;
  }
  if (special[old.operationId]) {
    replacements = [special[old.operationId]];
    note = old.operationId.startsWith('auth')
      ? 'POST /connect exchanges the protected launch credential; authenticated DELETE /connect revokes prior Web/API cookie admission across Connection reload. Desktop Shell headers remain private and unaffected.'
      : old.operationId === 'getCapabilities'
        ? 'The DSH client-module graph and selected services/Slots describe actual composed availability; no static legacy feature facade.'
        : old.operationId === 'importDroppedFileGrant'
          ? 'The public selected FileGrantActions.importFile streams a browser File through the Files import owner, validates generation and returns only managed grant metadata.'
          : 'The selected DesktopWindowUi delegates only narrowed window presentation actions/state through the trusted per-window Shell bridge.';
  } else if (
    [
      'claimRdpSessionCredentials',
      'claimVncSessionCredentials',
      'claimSpiceSessionCredentials',
    ].includes(old.operationId)
  ) {
    replacements = [
      binding('remoteDesktop', 'getSession'),
      {
        kind: 'binary-route',
        module: '@axterm/plugin-remote-desktop',
        source: 'packages/plugins/remote-desktop/src/adapters/binary-stream.ts',
        className: 'RemoteDesktopBinaryStream',
        pathSymbol: 'REMOTE_DESKTOP_CREDENTIAL_PATH',
      },
    ];
    note =
      'The owning session metadata identifies the protocol; its authenticated, resource-scoped one-use binary credential route replaces the old claim. Do not create another session or put credentials in model state, ordinary Remote results or persistent browser storage.';
  } else if (old.operationId === 'insertGrantedTerminalPaths') {
    replacements = [
      binding('files', 'prepareInputPaths'),
      {
        kind: 'client-service',
        module: '@axterm/plugin-terminals',
        source: 'packages/plugins/terminals/src/client/ui.tsx',
        namespace: 'terminalInputUi',
        functionName: 'installTerminalUi',
        methods: ['sendInput'],
      },
    ];
    note =
      'Files verifies generation/readable authority and retains temporary file lifetime; only the captured private terminal binary producer inserts the frozen quoted paths without Enter. No Remote stdin.';
  } else if (old.operationId === 'streamDomainEvents') {
    replacements = eventOwners.map(([ns, m]) => binding(ns, m));
    note =
      'Per-owner full baseline and durable cursor observations replace the global domain SSE feed; reconnect replaces baseline, does not replay commands.';
  } else if (old.operationId === 'streamRealtimeEvents') {
    replacements = [
      ['terminals', 'watchTerminals'],
      ['transfers', 'watchTransferProgress'],
      ['remoteDesktop', 'watchSessions'],
      ['files', 'watchExternalEditors'],
    ].map(([ns, m]) => binding(ns, m));
    note =
      'Typed owner realtime observations and bounded dedicated binary channels replace the global realtime SSE; terminal/desktop bytes remain outside model state.';
  } else if (alias[old.operationId])
    replacements = alias[old.operationId].methods.map((m) =>
      binding(alias[old.operationId].namespace, m),
    );
  else replacements = [binding(old.namespace, old.target.slice(old.namespace.length + 1))];
  if (replacements.some((x) => !x) || !replacements.length) {
    rows.push({
      operationId: old.operationId,
      state: 'review',
      reason: 'Resolve the concrete replacement before source closure.',
      proposed: alias[old.operationId] ?? old.target,
    });
    continue;
  }
  const ns = replacements[0].namespace,
    prefix =
      ns === 'ai'
        ? 'ai'
        : ns === 'fileGrantActions'
          ? 'files'
          : ns === 'desktopWindowUi' || ns === 'clientModules'
            ? 'desktop'
            : ns === 'connection'
              ? 'connection'
              : ns === 'remoteDesktop'
                ? 'remote-desktop'
                : ns === 'terminals'
                  ? 'terminal'
                  : ns;
  const candidates = tests
    .filter((p) => p.includes('/level3-' + prefix) && !p.includes('package'))
    .slice(0, 8);
  rows.push({
    operationId: old.operationId,
    state: 'bound',
    target: replacements[0].namespace + '.' + replacements[0].methods[0],
    replacements,
    semantics: note,
    testCandidates: candidates,
    finalAcceptance:
      'Source binding only; execute relevant behavior/package verification and retain the existing final operation-map acceptance gate.',
  });
}
for (const row of rows) {
  const old = map.operations.find((item) => item.operationId === row.operationId);
  row.original = { method: old.method, path: old.path };
}
const result = {
  schemaVersion: 1,
  sourceCommit: map.sourceCommit,
  sourceClientSha256: map.sourceClientSha256,
  scope: 'Source review only; not operation acceptance or an effort percentage.',
  operations: rows,
};
await writeFile(
  'tests/fixtures/engineering/level3/operation-source-review.json',
  JSON.stringify(result, null, 2) + '\n',
);
const stats = Object.fromEntries(
  ['bound', 'gap', 'review'].map((state) => [state, rows.filter((x) => x.state === state).length]),
);
console.log(stats);
for (const row of rows) if (row.state !== 'bound') console.log(JSON.stringify(row));
