import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

const identity = {
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  version: integer('version').notNull().default(1),
};

export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const hostGroups = sqliteTable(
  'host_groups',
  {
    ...identity,
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (table) => [uniqueIndex('host_groups_name_unique').on(table.name)],
);

export const hosts = sqliteTable(
  'hosts',
  {
    ...identity,
    groupId: text('group_id').references(() => hostGroups.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    hostname: text('hostname').notNull(),
    port: integer('port').notNull().default(22),
    username: text('username').notNull(),
    authType: text('auth_type').notNull().default('password'),
    credentialRef: text('credential_ref'),
    passphraseCredentialRef: text('passphrase_credential_ref'),
    jumpHostId: text('jump_host_id'),
    jumpHostIds: text('jump_host_ids').notNull().default('[]'),
    favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
    proxyMode: text('proxy_mode').notNull().default('inherit'),
    proxyUrl: text('proxy_url'),
    proxyUsername: text('proxy_username'),
    proxyCredentialRef: text('proxy_credential_ref'),
    proxyCommandExecutable: text('proxy_command_executable'),
    proxyCommandArguments: text('proxy_command_arguments'),
    connectionTimeoutMs: integer('connection_timeout_ms').notNull().default(50_000),
    keepaliveIntervalMs: integer('keepalive_interval_ms').notNull().default(10_000),
    keepaliveCountMax: integer('keepalive_count_max').notNull().default(10),
    compression: integer('compression', { mode: 'boolean' }).notNull().default(true),
    reconnectMode: text('reconnect_mode').notNull().default('manual'),
    reconnectDelayMs: integer('reconnect_delay_ms').notNull().default(3_000),
    reconnectMaxAttempts: integer('reconnect_max_attempts').notNull().default(10),
    sshAlgorithms: text('ssh_algorithms')
      .notNull()
      .default('{"kex":[],"cipher":[],"serverHostKey":[],"hmac":[]}'),
    sshStartup: text('ssh_startup')
      .notNull()
      .default('{"directory":null,"environment":{},"loginScripts":[],"runScripts":[]}'),
  },
  (table) => [uniqueIndex('hosts_name_unique').on(table.name)],
);

export const bookmarkGroups = sqliteTable(
  'bookmark_groups',
  {
    ...identity,
    parentId: text('parent_id').references((): AnySQLiteColumn => bookmarkGroups.id, {
      onDelete: 'restrict',
    }),
    name: text('name').notNull(),
    color: text('color'),
    description: text('description').notNull().default(''),
    position: integer('position').notNull().default(0),
  },
  (table) => [index('bookmark_groups_parent_position').on(table.parentId, table.position)],
);

export const connectionProfiles = sqliteTable('connection_profiles', {
  ...identity,
  name: text('name').notNull(),
  payload: text('payload').notNull(),
});

export const electermImportEntries = sqliteTable(
  'electerm_import_entries',
  {
    kind: text('kind').notNull(),
    sourceId: text('source_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    targetId: text('target_id').notNull(),
    importedAt: text('imported_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.sourceId] }),
    index('electerm_import_entries_target').on(table.kind, table.targetId),
  ],
);

export const syncProfiles = sqliteTable(
  'sync_profiles',
  {
    ...identity,
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    endpointUrl: text('endpoint_url').notNull(),
    remoteId: text('remote_id').notNull(),
    username: text('username'),
    accessCredentialRef: text('access_credential_ref'),
    encryptionCredentialRef: text('encryption_credential_ref'),
    selectedCategories: text('selected_categories').notNull(),
    autoSyncEnabled: integer('auto_sync_enabled', { mode: 'boolean' }).notNull().default(false),
    autoSyncIntervalMinutes: integer('auto_sync_interval_minutes').notNull().default(5),
    autoSyncDirection: text('auto_sync_direction').notNull().default('upload'),
    state: text('state').notNull().default('idle'),
    remoteRevision: text('remote_revision'),
    lastSyncAt: text('last_sync_at'),
    lastErrorCode: text('last_error_code'),
    pendingPreviewId: text('pending_preview_id'),
  },
  (table) => [
    uniqueIndex('sync_profiles_provider_unique').on(table.provider),
    index('sync_profiles_auto').on(table.autoSyncEnabled, table.updatedAt),
  ],
);

export const bookmarks = sqliteTable(
  'bookmarks',
  {
    ...identity,
    groupId: text('group_id').references(() => bookmarkGroups.id, { onDelete: 'set null' }),
    protocol: text('protocol').notNull(),
    hostId: text('host_id').references(() => hosts.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    color: text('color'),
    description: text('description').notNull().default(''),
    position: integer('position').notNull().default(0),
    profileId: text('profile_id'),
    connectionProfileId: text('connection_profile_id').references(() => connectionProfiles.id, {
      onDelete: 'restrict',
    }),
    quickCommandsPayload: text('quick_commands_payload').notNull().default('[]'),
    triggersPayload: text('triggers_payload').notNull().default('[]'),
    ftpPayload: text('ftp_payload').notNull().default('null'),
    telnetPayload: text('telnet_payload').notNull().default('null'),
    serialPayload: text('serial_payload').notNull().default('null'),
    rdpPayload: text('rdp_payload').notNull().default('null'),
    vncPayload: text('vnc_payload').notNull().default('null'),
    spicePayload: text('spice_payload').notNull().default('null'),
    webPayload: text('web_payload').notNull().default('null'),
  },
  (table) => [
    index('bookmarks_group_position').on(table.groupId, table.position),
    index('bookmarks_host').on(table.hostId),
    index('bookmarks_connection_profile').on(table.connectionProfileId),
  ],
);

export const hostAuthRefs = sqliteTable('host_auth_refs', {
  ...identity,
  hostId: text('host_id')
    .notNull()
    .references(() => hosts.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  credentialRef: text('credential_ref').notNull(),
  label: text('label').notNull(),
});

const jsonEntity = (name: string) =>
  sqliteTable(name, {
    ...identity,
    name: text('name').notNull(),
    payload: text('payload').notNull(),
  });

export const terminalProfiles = jsonEntity('terminal_profiles');
export const terminalThemes = jsonEntity('terminal_themes');
export const quickCommandGroups = sqliteTable(
  'quick_command_groups',
  {
    ...identity,
    parentId: text('parent_id'),
    name: text('name').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [index('quick_command_groups_parent_position').on(table.parentId, table.position)],
);
export const quickCommands = sqliteTable(
  'quick_commands',
  {
    ...identity,
    groupId: text('group_id'),
    name: text('name').notNull(),
    payload: text('payload').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [index('quick_commands_group_position').on(table.groupId, table.position)],
);
export const tunnelProfiles = jsonEntity('tunnel_profiles');
export const aiProviders = jsonEntity('ai_providers');
export const aiModels = jsonEntity('ai_models');
export const aiConversations = jsonEntity('ai_conversations');

export const knownHostKeys = sqliteTable('known_host_keys', {
  ...identity,
  host: text('host').notNull(),
  port: integer('port').notNull(),
  algorithm: text('algorithm').notNull(),
  fingerprint: text('fingerprint').notNull(),
  publicKey: text('public_key').notNull(),
  firstSeenAt: text('first_seen_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
});

export const recentConnections = sqliteTable(
  'recent_connections',
  {
    ...identity,
    targetKey: text('target_key').notNull(),
    hostId: text('host_id').references(() => hosts.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    hostname: text('hostname').notNull(),
    port: integer('port').notNull(),
    username: text('username').notNull(),
    authType: text('auth_type').notNull(),
    jumpHostId: text('jump_host_id').references(() => hosts.id, { onDelete: 'set null' }),
    connectionTimeoutMs: integer('connection_timeout_ms').notNull().default(50_000),
    keepaliveIntervalMs: integer('keepalive_interval_ms').notNull().default(10_000),
    keepaliveCountMax: integer('keepalive_count_max').notNull().default(10),
    compression: integer('compression', { mode: 'boolean' }).notNull().default(true),
    reconnectMode: text('reconnect_mode').notNull().default('manual'),
    reconnectDelayMs: integer('reconnect_delay_ms').notNull().default(3_000),
    reconnectMaxAttempts: integer('reconnect_max_attempts').notNull().default(10),
    connectionCount: integer('connection_count').notNull().default(1),
    lastConnectedAt: text('last_connected_at').notNull(),
  },
  (table) => [
    uniqueIndex('recent_connections_target_unique').on(table.targetKey),
    index('recent_connections_host').on(table.hostId, table.lastConnectedAt),
    index('recent_connections_recent').on(table.lastConnectedAt, table.id),
    index('recent_connections_frequency').on(
      table.connectionCount,
      table.lastConnectedAt,
      table.id,
    ),
  ],
);

export const commandHistory = sqliteTable(
  'command_history',
  {
    ...identity,
    command: text('command_text').notNull(),
    useCount: integer('use_count').notNull().default(1),
    lastUsedAt: text('last_used_at').notNull(),
  },
  (table) => [
    uniqueIndex('command_history_command_unique').on(table.command),
    index('command_history_recent').on(table.lastUsedAt, table.id),
    index('command_history_frequency').on(table.useCount, table.lastUsedAt, table.id),
  ],
);

export const aiMessages = sqliteTable('ai_messages', {
  ...identity,
  conversationId: text('conversation_id').notNull(),
  runId: text('run_id'),
  role: text('role').notNull(),
  content: text('content').notNull(),
  state: text('state').notNull().default('complete'),
  errorCode: text('error_code'),
});

export const aiRuns = sqliteTable('ai_runs', {
  ...identity,
  conversationId: text('conversation_id'),
  state: text('state').notNull(),
  useCase: text('use_case').notNull(),
  request: text('request').notNull(),
  result: text('result'),
  errorCode: text('error_code'),
});

export const aiToolCalls = sqliteTable('ai_tool_calls', {
  ...identity,
  runId: text('run_id')
    .notNull()
    .references(() => aiRuns.id, { onDelete: 'cascade' }),
  toolName: text('tool_name').notNull(),
  risk: text('risk').notNull(),
  argsHash: text('args_hash').notNull(),
  argsJson: text('args_json').notNull(),
  target: text('target').notNull(),
  state: text('state').notNull(),
  resultMetadata: text('result_metadata'),
});

export const aiApprovals = sqliteTable('ai_approvals', {
  ...identity,
  runId: text('run_id')
    .notNull()
    .references(() => aiRuns.id, { onDelete: 'cascade' }),
  toolCallId: text('tool_call_id')
    .notNull()
    .references(() => aiToolCalls.id, { onDelete: 'cascade' }),
  argsHash: text('args_hash').notNull(),
  target: text('target').notNull(),
  state: text('state').notNull(),
  expiresAt: text('expires_at').notNull(),
  decidedAt: text('decided_at'),
});

export const appSettings = sqliteTable('app_settings', {
  section: text('section').primaryKey(),
  payload: text('payload').notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: text('updated_at').notNull(),
});

export const domainEvents = sqliteTable('domain_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventId: text('event_id').notNull(),
  type: text('type').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  payload: text('payload').notNull(),
  createdAt: text('created_at').notNull(),
});

export const transferHistory = sqliteTable('transfer_history', {
  ...identity,
  connectionId: text('connection_id').notNull(),
  direction: text('direction').notNull(),
  state: text('state').notNull(),
  source: text('source').notNull(),
  destination: text('destination').notNull(),
  bytesTransferred: integer('bytes_transferred').notNull().default(0),
  totalBytes: integer('total_bytes'),
  bytesPerSecond: real('bytes_per_second'),
  errorCode: text('error_code'),
});

export const idempotencyRecords = sqliteTable('idempotency_records', {
  key: text('key').primaryKey(),
  operation: text('operation').notNull(),
  requestHash: text('request_hash').notNull(),
  response: text('response').notNull(),
  createdAt: text('created_at').notNull(),
});

export const batchOperations = sqliteTable(
  'batch_operations',
  {
    ...identity,
    name: text('name').notNull(),
    state: text('state').notNull(),
    targetCount: integer('target_count').notNull(),
    payload: text('payload').notNull(),
  },
  (table) => [index('batch_operations_updated_at').on(table.updatedAt, table.id)],
);

export const automationTriggers = sqliteTable(
  'automation_triggers',
  {
    ...identity,
    name: text('name').notNull(),
    payload: text('payload').notNull(),
    position: integer('position').notNull(),
  },
  (table) => [index('automation_triggers_position').on(table.position, table.id)],
);

export const schema = {
  appMeta,
  hostGroups,
  hosts,
  bookmarkGroups,
  connectionProfiles,
  electermImportEntries,
  bookmarks,
  hostAuthRefs,
  terminalProfiles,
  quickCommands,
  tunnelProfiles,
  knownHostKeys,
  recentConnections,
  commandHistory,
  aiProviders,
  aiModels,
  aiConversations,
  aiMessages,
  aiRuns,
  aiToolCalls,
  aiApprovals,
  appSettings,
  domainEvents,
  transferHistory,
  idempotencyRecords,
  batchOperations,
  automationTriggers,
};
