import type { StorageBootstrapMigration } from '@axterm/plugin-api/host';

/** First-party additions after the immutable generation-2 migration prefix. */
export const forwardMigrations: readonly StorageBootstrapMigration[] = [
  {
    id: 43,
    risky: false,
    sql: `
    CREATE TABLE axterm_catalog_revisions (
      name TEXT PRIMARY KEY CHECK(name IN ('bookmarks','connections')),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991)
    );
    CREATE TABLE axterm_terminal_revisions (
      name TEXT PRIMARY KEY CHECK(name='commands'),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991)
    );
    INSERT INTO axterm_catalog_revisions VALUES ('bookmarks', COALESCE((
      SELECT CASE WHEN length(value) BETWEEN 1 AND 20
        AND value NOT GLOB '*[^0-9]*' THEN CAST(value AS INTEGER) ELSE 0 END
      FROM app_meta WHERE key='bookmark-tree:revision'
    ), 0));
    INSERT INTO axterm_catalog_revisions VALUES ('connections', COALESCE((
      SELECT CASE WHEN length(value) BETWEEN 1 AND 20
        AND value NOT GLOB '*[^0-9]*' THEN CAST(value AS INTEGER) ELSE 0 END
      FROM app_meta WHERE key='connection-history:revision'
    ), 0));
    INSERT INTO axterm_terminal_revisions VALUES ('commands', COALESCE((
      SELECT CASE WHEN length(value) BETWEEN 1 AND 20
        AND value NOT GLOB '*[^0-9]*' THEN CAST(value AS INTEGER) ELSE 0 END
      FROM app_meta WHERE key='command-history:revision'
    ), 0));
    CREATE TABLE axterm_catalog_command_receipts (
      command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      status TEXT NOT NULL CHECK(status IN ('completed','expired')),
      result_json TEXT NOT NULL CHECK(length(result_json)<=1048576 AND json_valid(result_json)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE axterm_configuration_command_receipts (
      command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      status TEXT NOT NULL CHECK(status IN ('completed','expired')),
      result_json TEXT NOT NULL CHECK(length(result_json)<=1048576 AND json_valid(result_json)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE axterm_terminal_command_receipts (
      command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      status TEXT NOT NULL CHECK(status IN ('completed','expired')),
      result_json TEXT NOT NULL CHECK(length(result_json)<=1048576 AND json_valid(result_json)),
      created_at TEXT NOT NULL
    );
  `,
  },
  {
    id: 44,
    risky: false,
    sql: `
    CREATE TABLE axterm_file_operation_receipts (
      command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      profile_name TEXT NOT NULL CHECK(length(profile_name) BETWEEN 1 AND 128),
      generation TEXT NOT NULL CHECK(length(generation)=36),
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted','expired')),
      result_json TEXT NOT NULL CHECK(length(result_json)<=65536 AND json_valid(result_json)),
      error_reason TEXT CHECK(error_reason IS NULL OR length(error_reason) BETWEEN 1 AND 64),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX axterm_file_operation_receipts_profile ON axterm_file_operation_receipts(profile_name,status);
    `,
  },
  {
    id: 45,
    risky: false,
    sql: `
    CREATE TABLE axterm_transfer_commands (
      command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
      transfer_id TEXT NOT NULL UNIQUE CHECK(length(transfer_id)=36),
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      profile_name TEXT NOT NULL CHECK(length(profile_name) BETWEEN 1 AND 128),
      generation TEXT NOT NULL CHECK(length(generation)=36),
      expired INTEGER NOT NULL DEFAULT 0 CHECK(expired IN (0,1)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE axterm_transfer_fact_commands (
      command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      status TEXT NOT NULL CHECK(status IN ('completed','expired')),
      result_json TEXT NOT NULL CHECK(length(result_json)<=1048576 AND json_valid(result_json)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX axterm_transfer_commands_profile ON axterm_transfer_commands(profile_name,generation);
    `,
  },
  {
    id: 46,
    risky: false,
    sql: `
    CREATE TABLE axterm_connection_command_receipts (
      command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      status TEXT NOT NULL CHECK(status IN ('completed','expired')),
      result_json TEXT NOT NULL CHECK(length(result_json)<=1048576 AND json_valid(result_json)),
      created_at TEXT NOT NULL
    );
  `,
  },
  {
    id: 47,
    risky: false,
    sql: `
    CREATE TABLE axterm_automation_revisions (
      name TEXT PRIMARY KEY CHECK(name IN ('quick-command-tree','trigger-list')),
      value INTEGER NOT NULL CHECK(typeof(value)='integer' AND value BETWEEN 1 AND 9007199254740991)
    );
    INSERT INTO axterm_automation_revisions(name,value) VALUES
      ('quick-command-tree',COALESCE((SELECT CAST(value AS INTEGER) FROM app_meta WHERE key='quick-command-tree:revision'),1)),
      ('trigger-list',COALESCE((SELECT CAST(value AS INTEGER) FROM app_meta WHERE key='trigger-list:revision'),1));
    CREATE TABLE axterm_automation_command_receipts (
      command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      status TEXT NOT NULL CHECK(status IN ('completed','expired')),
      result_json TEXT NOT NULL CHECK(length(result_json)<=1048576 AND json_valid(result_json)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE axterm_batch_ownership (
      batch_id TEXT PRIMARY KEY REFERENCES batch_operations(id) ON DELETE CASCADE,
      profile TEXT NOT NULL CHECK(length(profile) BETWEEN 1 AND 128),
      generation TEXT NOT NULL CHECK(length(generation)=36),
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','released'))
    );
    CREATE INDEX axterm_batch_ownership_profile ON axterm_batch_ownership(profile,generation);
  `,
  },

  {
    id: 48,
    risky: false,
    sql: `
    CREATE TABLE axterm_credential_command_intents (
      command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
      profile_name TEXT NOT NULL CHECK(length(profile_name) BETWEEN 1 AND 128),
      generation TEXT NOT NULL CHECK(length(generation)=36),
      operation TEXT NOT NULL CHECK(operation IN ('create','replace','delete')),
      credential_ref TEXT NOT NULL CHECK(length(credential_ref)=41 AND substr(credential_ref,1,5)='cred_'),
      metadata_json TEXT NOT NULL CHECK(length(metadata_json)<=16384 AND json_valid(metadata_json)),
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed','uncertain','interrupted','expired')),
      result_json TEXT NOT NULL CHECK(length(result_json)<=65536 AND json_valid(result_json)),
      error_reason TEXT CHECK(error_reason IS NULL OR length(error_reason) BETWEEN 1 AND 64),
      result_order INTEGER NOT NULL DEFAULT 0 CHECK(result_order BETWEEN 0 AND 9007199254740991),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX axterm_credential_commands_owner ON axterm_credential_command_intents(profile_name,generation,status);
    CREATE INDEX axterm_credential_commands_outcomes ON axterm_credential_command_intents(profile_name,result_order DESC);
    `,
  },
  {
    id: 49,
    risky: false,
    sql: `
    CREATE TABLE axterm_sync_run_intents (
      command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
      profile_name TEXT NOT NULL CHECK(length(profile_name) BETWEEN 1 AND 128),
      generation TEXT NOT NULL CHECK(length(generation)=36),
      sync_profile_id TEXT NOT NULL CHECK(length(sync_profile_id)=36),
      expected_profile_version INTEGER NOT NULL CHECK(expected_profile_version BETWEEN 1 AND 9007199254740991),
      owner_pid INTEGER NOT NULL CHECK(owner_pid BETWEEN 1 AND 2147483647),
      cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor BETWEEN 0 AND 9007199254740991),
      operation TEXT NOT NULL CHECK(operation IN ('test','backup','compare','upload','download-preview')),
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','uncertain','interrupted','expired')),
      result_json TEXT NOT NULL DEFAULT 'null' CHECK(length(result_json)<=524288 AND json_valid(result_json)),
      error_reason TEXT CHECK(error_reason IS NULL OR length(error_reason) BETWEEN 1 AND 64),
      result_order INTEGER NOT NULL DEFAULT 0 CHECK(result_order BETWEEN 0 AND 9007199254740991),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX axterm_sync_runs_active ON axterm_sync_run_intents(sync_profile_id) WHERE status='running';
    CREATE INDEX axterm_sync_runs_owner ON axterm_sync_run_intents(profile_name,generation,status);
    CREATE INDEX axterm_sync_runs_resource ON axterm_sync_run_intents(sync_profile_id,status);
    CREATE INDEX axterm_sync_runs_outcomes ON axterm_sync_run_intents(profile_name,result_order DESC);
    `,
  },
  {
    id: 50,
    risky: false,
    sql: `
    UPDATE ai_providers SET payload=json_set(payload,'$.engineId','pi') WHERE json_type(payload,'$.engineId') IS NULL;
    ALTER TABLE ai_runs ADD COLUMN engine_id TEXT NOT NULL DEFAULT 'pi';
    CREATE TABLE axterm_ai_command_receipts (
      command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      status TEXT NOT NULL CHECK(status IN ('completed','expired')),
      result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB))<=1048576 AND json_valid(result_json)),
      created_at TEXT NOT NULL
    );
    CREATE TABLE axterm_ai_run_intents (
      command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
      profile_name TEXT NOT NULL CHECK(length(profile_name) BETWEEN 1 AND 128),
      generation TEXT NOT NULL CHECK(length(generation)=36),
      owner_pid INTEGER NOT NULL CHECK(owner_pid BETWEEN 1 AND 2147483647),
      operation TEXT NOT NULL CHECK(operation IN ('run','provider-test','mcp-tool')),
      run_id TEXT REFERENCES ai_runs(id),
      state TEXT NOT NULL CHECK(state IN ('queued','running','waiting_approval','completed','failed','canceled','interrupted','uncertain')),
      result_json TEXT NOT NULL DEFAULT 'null' CHECK(length(CAST(result_json AS BLOB))<=262144 AND json_valid(result_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX axterm_ai_intents_owner ON axterm_ai_run_intents(profile_name,generation,state);
    CREATE UNIQUE INDEX axterm_ai_intents_run ON axterm_ai_run_intents(run_id) WHERE run_id IS NOT NULL;
    CREATE TABLE axterm_ai_run_log (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('input','output','tool','approval','audit','state','usage')),
      payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=262144 AND json_valid(payload)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX axterm_ai_log_run ON axterm_ai_run_log(run_id,cursor);
    `,
  },
  {
    id: 51,
    risky: false,
    sql: `
    CREATE TABLE axterm_catalog_import_reports (
      report_id TEXT PRIMARY KEY CHECK(length(report_id)=36),
      result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB))<=67108864 AND json_valid(result_json)),
      created_at TEXT NOT NULL
    );
    `,
  },
  {
    id: 52,
    risky: false,
    sql: `
    CREATE TABLE axterm_terminal_stage_keys (
      profile_name TEXT PRIMARY KEY CHECK(length(profile_name) BETWEEN 1 AND 128),
      key BLOB NOT NULL CHECK(length(key)=32)
    );
    CREATE TABLE axterm_terminal_stages (
      id TEXT PRIMARY KEY CHECK(length(id)=36),
      profile_name TEXT NOT NULL CHECK(length(profile_name) BETWEEN 1 AND 128),
      generation TEXT NOT NULL CHECK(length(generation)=36),
      destination_hash TEXT NOT NULL CHECK(length(destination_hash)=64),
      protocol TEXT NOT NULL CHECK(protocol IN ('xmodem','zmodem','trzsz')),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 255),
      device TEXT NOT NULL,
      inode TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('receiving','ready','publishing','failed','interrupted')),
      created_at INTEGER NOT NULL CHECK(created_at>=0)
    );
    CREATE INDEX axterm_terminal_stages_profile ON axterm_terminal_stages(profile_name,destination_hash,created_at);
    `,
  },
  {
    id: 53,
    risky: false,
    sql: `
    CREATE TABLE IF NOT EXISTS axterm_storage_owners (name TEXT PRIMARY KEY, domain TEXT NOT NULL, owner TEXT NOT NULL);
    UPDATE axterm_storage_owners SET domain='terminal_transfer_stages'
      WHERE name IN ('axterm_terminal_stage_keys','axterm_terminal_stages')
        AND domain='terminals' AND owner='@axterm/plugin-terminals';
    `,
  },
  {
    id: 54,
    risky: false,
    sql: `
    CREATE TABLE terminal_background_assets (
      id TEXT PRIMARY KEY CHECK(length(id)=36),
      mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/gif','image/webp')),
      bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 1 AND 16777216),
      sha256 TEXT NOT NULL CHECK(length(sha256)=64),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
      created_at TEXT NOT NULL
    );
    CREATE TABLE terminal_background_asset_chunks (
      asset_id TEXT NOT NULL REFERENCES terminal_background_assets(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL CHECK(typeof(chunk_index)='integer' AND chunk_index BETWEEN 0 AND 255),
      content BLOB NOT NULL CHECK(typeof(content)='blob' AND length(content) BETWEEN 1 AND 65536),
      PRIMARY KEY(asset_id,chunk_index)
    );
    CREATE TABLE axterm_terminal_asset_receipts (
      command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      status TEXT NOT NULL CHECK(status IN ('completed','expired')),
      result_json TEXT NOT NULL CHECK(length(result_json)<=1048576 AND json_valid(result_json)),
      created_at TEXT NOT NULL
    );
    `,
  },
  {
    id: 55,
    risky: false,
    sql: `
    CREATE TABLE axterm_desktop_preferences (
      id TEXT PRIMARY KEY CHECK(id='desktop'),
      version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
      document_json TEXT NOT NULL CHECK(length(document_json)<=16384 AND json_valid(document_json))
    );
    CREATE TABLE axterm_desktop_command_receipts (
      command_id TEXT PRIMARY KEY CHECK(length(command_id)=36),
      operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      status TEXT NOT NULL CHECK(status IN ('completed','expired')),
      result_json TEXT NOT NULL CHECK(length(result_json)<=1048576 AND json_valid(result_json)),
      created_at TEXT NOT NULL
    );
    `,
  },
];
export const PRODUCT_SCHEMA_VERSION = 55;

/** Tables created by the forward prefix, used by schema/ownership verification. */
export const forwardTableNames = Object.freeze([
  'axterm_catalog_revisions',
  'axterm_terminal_revisions',
  'axterm_catalog_command_receipts',
  'axterm_catalog_import_reports',
  'axterm_configuration_command_receipts',
  'axterm_terminal_command_receipts',
  'axterm_file_operation_receipts',
  'axterm_transfer_commands',
  'axterm_transfer_fact_commands',
  'axterm_connection_command_receipts',
  'axterm_automation_revisions',
  'axterm_automation_command_receipts',
  'axterm_batch_ownership',
  'axterm_credential_command_intents',
  'axterm_sync_run_intents',
  'axterm_ai_command_receipts',
  'axterm_ai_run_intents',
  'axterm_ai_run_log',
  'axterm_terminal_stage_keys',
  'axterm_terminal_stages',
  'terminal_background_assets',
  'terminal_background_asset_chunks',
  'axterm_terminal_asset_receipts',
  'axterm_desktop_preferences',
  'axterm_desktop_command_receipts',
]);
