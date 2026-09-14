import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { schema } from '@workspace/db-schema';

interface Migration {
  id: number;
  risky: boolean;
  sql: string;
}

export interface AppVersionTransition {
  currentVersion: string;
  previousVersion: string | null;
  upgraded: boolean;
  startedAt: string;
}

export const DEFAULT_DOMAIN_EVENT_RETENTION_LIMIT = 10_000;

const migrations: readonly Migration[] = [
  {
    id: 1,
    risky: false,
    sql: `
      PRAGMA foreign_keys = ON;
      CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE host_groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE hosts (
        id TEXT PRIMARY KEY, group_id TEXT REFERENCES host_groups(id) ON DELETE SET NULL,
        name TEXT NOT NULL UNIQUE, hostname TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 22,
        username TEXT NOT NULL, auth_type TEXT NOT NULL DEFAULT 'password', credential_ref TEXT,
        passphrase_credential_ref TEXT,
        jump_host_id TEXT, favorite INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        CHECK (port BETWEEN 1 AND 65535), CHECK (id != jump_host_id)
      );
      CREATE TABLE host_auth_refs (
        id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, credential_ref TEXT NOT NULL, label TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE terminal_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE quick_commands (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE tunnel_profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE known_host_keys (
        id TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL, algorithm TEXT NOT NULL,
        fingerprint TEXT NOT NULL, public_key TEXT NOT NULL, first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1, UNIQUE(host, port)
      );
      CREATE TABLE recent_connections (
        id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        connected_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE ai_providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE ai_models (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE ai_conversations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE ai_messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE ai_runs (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, use_case TEXT NOT NULL, request TEXT NOT NULL,
        result TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE ai_tool_calls (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL, risk TEXT NOT NULL, args_hash TEXT NOT NULL, args_json TEXT NOT NULL,
        state TEXT NOT NULL, result_metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE ai_approvals (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
        tool_call_id TEXT NOT NULL REFERENCES ai_tool_calls(id) ON DELETE CASCADE,
        args_hash TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL, expires_at TEXT NOT NULL,
        decided_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE app_settings (
        section TEXT PRIMARY KEY, payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE domain_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
        aggregate_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE transfer_history (
        id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, direction TEXT NOT NULL, state TEXT NOT NULL, source TEXT NOT NULL,
        destination TEXT NOT NULL, bytes_transferred INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER,
        error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE idempotency_records (
        key TEXT PRIMARY KEY, operation TEXT NOT NULL, request_hash TEXT NOT NULL,
        response TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX domain_events_cursor ON domain_events(id);
      CREATE INDEX recent_connections_host ON recent_connections(host_id, connected_at DESC);
      CREATE INDEX transfer_history_state ON transfer_history(state, updated_at DESC);
      INSERT INTO app_settings(section, payload, version, updated_at)
        VALUES ('appearance', '{"theme":"dark","language":"zh-CN"}', 1, CURRENT_TIMESTAMP);
    `,
  },
  {
    id: 2,
    risky: false,
    sql: `ALTER TABLE ai_tool_calls ADD COLUMN target TEXT NOT NULL DEFAULT '';`,
  },
  {
    id: 3,
    risky: false,
    sql: `
      CREATE TABLE bookmark_groups (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES bookmark_groups(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        color TEXT,
        description TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        CHECK (id != parent_id)
      );
      CREATE TABLE bookmarks (
        id TEXT PRIMARY KEY,
        group_id TEXT REFERENCES bookmark_groups(id) ON DELETE SET NULL,
        protocol TEXT NOT NULL CHECK (protocol IN ('ssh','local','telnet','serial','rdp','vnc','ftp','spice','web')),
        host_id TEXT REFERENCES hosts(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        color TEXT,
        description TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
        profile_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        CHECK (protocol != 'ssh' OR host_id IS NOT NULL)
      );
      CREATE INDEX bookmark_groups_parent_position
        ON bookmark_groups(parent_id, position, id);
      CREATE INDEX bookmarks_group_position
        ON bookmarks(group_id, position, id);
      CREATE INDEX bookmarks_host ON bookmarks(host_id);

      INSERT INTO bookmark_groups(
        id, parent_id, name, color, description, position,
        created_at, updated_at, version
      )
      SELECT
        id,
        NULL,
        name,
        NULL,
        '',
        ROW_NUMBER() OVER (ORDER BY sort_order, lower(name), id) - 1,
        created_at,
        updated_at,
        version
      FROM host_groups;

      INSERT INTO bookmarks(
        id, group_id, protocol, host_id, title, color, description, position,
        profile_id, created_at, updated_at, version
      )
      SELECT
        h.id,
        h.group_id,
        'ssh',
        h.id,
        h.name,
        NULL,
        '',
        (
          SELECT COUNT(*)
          FROM bookmark_groups g
          WHERE g.parent_id IS h.group_id
        ) + ROW_NUMBER() OVER (
          PARTITION BY h.group_id
          ORDER BY h.favorite DESC, lower(h.name), h.id
        ) - 1,
        NULL,
        h.created_at,
        h.updated_at,
        h.version
      FROM hosts h;

      CREATE TEMP TABLE bookmark_position_assertion (
        valid INTEGER NOT NULL CHECK (valid = 1)
      );
      INSERT INTO bookmark_position_assertion(valid)
      SELECT CASE WHEN NOT EXISTS (
        SELECT parent_key
        FROM (
          SELECT COALESCE(parent_id, '') AS parent_key, position FROM bookmark_groups
          UNION ALL
          SELECT COALESCE(group_id, '') AS parent_key, position FROM bookmarks
        ) nodes
        GROUP BY parent_key
        HAVING MIN(position) != 0
          OR MAX(position) != COUNT(*) - 1
          OR COUNT(DISTINCT position) != COUNT(*)
      ) THEN 1 ELSE 0 END;
      DROP TABLE bookmark_position_assertion;

      INSERT INTO app_meta(key, value) VALUES ('bookmark-tree:revision', '1');
    `,
  },
  {
    id: 4,
    risky: false,
    sql: `
      ALTER TABLE hosts ADD COLUMN connection_timeout_ms INTEGER NOT NULL DEFAULT 50000
        CHECK (connection_timeout_ms BETWEEN 1000 AND 300000);
      ALTER TABLE hosts ADD COLUMN keepalive_interval_ms INTEGER NOT NULL DEFAULT 10000
        CHECK (keepalive_interval_ms BETWEEN 0 AND 300000);
      ALTER TABLE hosts ADD COLUMN keepalive_count_max INTEGER NOT NULL DEFAULT 10
        CHECK (keepalive_count_max BETWEEN 1 AND 100);
      ALTER TABLE hosts ADD COLUMN compression INTEGER NOT NULL DEFAULT 1
        CHECK (compression IN (0, 1));
      ALTER TABLE hosts ADD COLUMN reconnect_mode TEXT NOT NULL DEFAULT 'manual'
        CHECK (reconnect_mode IN ('manual', 'automatic'));
      ALTER TABLE hosts ADD COLUMN reconnect_delay_ms INTEGER NOT NULL DEFAULT 3000
        CHECK (reconnect_delay_ms BETWEEN 250 AND 60000);
      ALTER TABLE hosts ADD COLUMN reconnect_max_attempts INTEGER NOT NULL DEFAULT 10
        CHECK (reconnect_max_attempts BETWEEN 1 AND 20);
    `,
  },
  {
    id: 5,
    risky: true,
    sql: `
      DROP INDEX recent_connections_host;
      ALTER TABLE recent_connections RENAME TO recent_connections_legacy;

      CREATE TABLE recent_connections (
        id TEXT PRIMARY KEY,
        target_key TEXT NOT NULL UNIQUE,
        host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        hostname TEXT NOT NULL,
        port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL CHECK (
          auth_type IN ('password', 'privateKey', 'keyboardInteractive', 'agent')
        ),
        jump_host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
        connection_timeout_ms INTEGER NOT NULL DEFAULT 50000
          CHECK (connection_timeout_ms BETWEEN 1000 AND 300000),
        keepalive_interval_ms INTEGER NOT NULL DEFAULT 10000
          CHECK (keepalive_interval_ms BETWEEN 0 AND 300000),
        keepalive_count_max INTEGER NOT NULL DEFAULT 10
          CHECK (keepalive_count_max BETWEEN 1 AND 100),
        compression INTEGER NOT NULL DEFAULT 1 CHECK (compression IN (0, 1)),
        reconnect_mode TEXT NOT NULL DEFAULT 'manual'
          CHECK (reconnect_mode IN ('manual', 'automatic')),
        reconnect_delay_ms INTEGER NOT NULL DEFAULT 3000
          CHECK (reconnect_delay_ms BETWEEN 250 AND 60000),
        reconnect_max_attempts INTEGER NOT NULL DEFAULT 10
          CHECK (reconnect_max_attempts BETWEEN 1 AND 20),
        connection_count INTEGER NOT NULL DEFAULT 1 CHECK (connection_count > 0),
        last_connected_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
      );

      INSERT INTO recent_connections(
        id, target_key, host_id, name, hostname, port, username, auth_type, jump_host_id,
        connection_timeout_ms, keepalive_interval_ms, keepalive_count_max, compression,
        reconnect_mode, reconnect_delay_ms, reconnect_max_attempts, connection_count,
        last_connected_at, created_at, updated_at, version
      )
      SELECT
        MIN(rc.id),
        json_array(
          lower(rtrim(h.hostname, '.')),
          h.port,
          h.username,
          CASE
            WHEN h.auth_type IN ('password', 'privateKey', 'keyboardInteractive', 'agent')
              THEN h.auth_type
            ELSE 'agent'
          END,
          h.jump_host_id,
          h.connection_timeout_ms,
          h.keepalive_interval_ms,
          h.keepalive_count_max,
          h.compression,
          h.reconnect_mode,
          h.reconnect_delay_ms,
          h.reconnect_max_attempts
        ),
        MIN(rc.host_id),
        MIN(h.name),
        h.hostname,
        h.port,
        h.username,
        CASE
          WHEN h.auth_type IN ('password', 'privateKey', 'keyboardInteractive', 'agent')
            THEN h.auth_type
          ELSE 'agent'
        END,
        h.jump_host_id,
        h.connection_timeout_ms,
        h.keepalive_interval_ms,
        h.keepalive_count_max,
        h.compression,
        h.reconnect_mode,
        h.reconnect_delay_ms,
        h.reconnect_max_attempts,
        COUNT(*),
        MAX(rc.connected_at),
        MIN(rc.created_at),
        MAX(rc.updated_at),
        MAX(rc.version)
      FROM recent_connections_legacy rc
      JOIN hosts h ON h.id = rc.host_id
      GROUP BY 2;

      DROP TABLE recent_connections_legacy;
      CREATE INDEX recent_connections_host ON recent_connections(host_id, last_connected_at DESC);
      CREATE INDEX recent_connections_recent ON recent_connections(last_connected_at DESC, id);
      CREATE INDEX recent_connections_frequency
        ON recent_connections(connection_count DESC, last_connected_at DESC, id);
      INSERT INTO app_meta(key, value) VALUES ('connection-history:revision', '1');
      INSERT OR IGNORE INTO app_settings(section, payload, version, updated_at)
        VALUES ('privacy', '{"connectionHistoryEnabled":true}', 1, CURRENT_TIMESTAMP);
    `,
  },
  {
    id: 6,
    risky: true,
    sql: `
      DROP INDEX recent_connections_host;
      DROP INDEX recent_connections_recent;
      DROP INDEX recent_connections_frequency;
      ALTER TABLE recent_connections RENAME TO recent_connections_pre_identity;

      CREATE TABLE recent_connections (
        id TEXT PRIMARY KEY,
        target_key TEXT NOT NULL UNIQUE,
        host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        hostname TEXT NOT NULL,
        port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL CHECK (
          auth_type IN ('password', 'privateKey', 'keyboardInteractive', 'agent')
        ),
        jump_host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
        connection_timeout_ms INTEGER NOT NULL DEFAULT 50000
          CHECK (connection_timeout_ms BETWEEN 1000 AND 300000),
        keepalive_interval_ms INTEGER NOT NULL DEFAULT 10000
          CHECK (keepalive_interval_ms BETWEEN 0 AND 300000),
        keepalive_count_max INTEGER NOT NULL DEFAULT 10
          CHECK (keepalive_count_max BETWEEN 1 AND 100),
        compression INTEGER NOT NULL DEFAULT 1 CHECK (compression IN (0, 1)),
        reconnect_mode TEXT NOT NULL DEFAULT 'manual'
          CHECK (reconnect_mode IN ('manual', 'automatic')),
        reconnect_delay_ms INTEGER NOT NULL DEFAULT 3000
          CHECK (reconnect_delay_ms BETWEEN 250 AND 60000),
        reconnect_max_attempts INTEGER NOT NULL DEFAULT 10
          CHECK (reconnect_max_attempts BETWEEN 1 AND 20),
        connection_count INTEGER NOT NULL DEFAULT 1 CHECK (connection_count > 0),
        last_connected_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
      );

      WITH ranked AS (
        SELECT
          rc.*,
          ROW_NUMBER() OVER (
            PARTITION BY lower(rtrim(hostname, '.')), port, username
            ORDER BY last_connected_at DESC, updated_at DESC, id
          ) AS target_rank,
          SUM(connection_count) OVER (
            PARTITION BY lower(rtrim(hostname, '.')), port, username
          ) AS aggregate_count,
          MIN(created_at) OVER (
            PARTITION BY lower(rtrim(hostname, '.')), port, username
          ) AS aggregate_created_at,
          MAX(updated_at) OVER (
            PARTITION BY lower(rtrim(hostname, '.')), port, username
          ) AS aggregate_updated_at,
          MAX(version) OVER (
            PARTITION BY lower(rtrim(hostname, '.')), port, username
          ) AS aggregate_version
        FROM recent_connections_pre_identity rc
      )
      INSERT INTO recent_connections(
        id, target_key, host_id, name, hostname, port, username, auth_type, jump_host_id,
        connection_timeout_ms, keepalive_interval_ms, keepalive_count_max, compression,
        reconnect_mode, reconnect_delay_ms, reconnect_max_attempts, connection_count,
        last_connected_at, created_at, updated_at, version
      )
      SELECT
        id,
        json_array(lower(rtrim(hostname, '.')), port, username),
        host_id,
        name,
        hostname,
        port,
        username,
        auth_type,
        jump_host_id,
        connection_timeout_ms,
        keepalive_interval_ms,
        keepalive_count_max,
        compression,
        reconnect_mode,
        reconnect_delay_ms,
        reconnect_max_attempts,
        aggregate_count,
        last_connected_at,
        aggregate_created_at,
        aggregate_updated_at,
        aggregate_version
      FROM ranked
      WHERE target_rank=1;

      DROP TABLE recent_connections_pre_identity;
      CREATE INDEX recent_connections_host ON recent_connections(host_id, last_connected_at DESC);
      CREATE INDEX recent_connections_recent ON recent_connections(last_connected_at DESC, id);
      CREATE INDEX recent_connections_frequency
        ON recent_connections(connection_count DESC, last_connected_at DESC, id);
      UPDATE app_meta SET value=CAST(CAST(value AS INTEGER) + 1 AS TEXT)
        WHERE key='connection-history:revision'
          AND EXISTS (SELECT 1 FROM recent_connections);
    `,
  },
  {
    id: 7,
    risky: false,
    sql: `
      ALTER TABLE hosts ADD COLUMN proxy_mode TEXT NOT NULL DEFAULT 'inherit'
        CHECK (proxy_mode IN ('inherit', 'direct', 'custom'));
      ALTER TABLE hosts ADD COLUMN proxy_url TEXT;
      ALTER TABLE hosts ADD COLUMN proxy_username TEXT;
      ALTER TABLE hosts ADD COLUMN proxy_credential_ref TEXT;
      INSERT OR IGNORE INTO app_settings(section, payload, version, updated_at)
        VALUES ('network', '{"proxy":{"mode":"direct"}}', 1, CURRENT_TIMESTAMP);
    `,
  },
  {
    id: 8,
    risky: false,
    sql: `
      CREATE TABLE command_history (
        id TEXT PRIMARY KEY,
        command_text TEXT NOT NULL UNIQUE,
        use_count INTEGER NOT NULL DEFAULT 1 CHECK (use_count > 0),
        last_used_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        CHECK (length(command_text) BETWEEN 1 AND 4096),
        CHECK (instr(command_text, char(0)) = 0),
        CHECK (instr(command_text, char(10)) = 0),
        CHECK (instr(command_text, char(13)) = 0)
      );
      CREATE INDEX command_history_recent
        ON command_history(last_used_at DESC, id);
      CREATE INDEX command_history_frequency
        ON command_history(use_count DESC, last_used_at DESC, id);
      INSERT INTO app_meta(key, value) VALUES ('command-history:revision', '1');
      UPDATE app_settings
        SET payload=json_set(payload, '$.commandHistoryEnabled', json('false'))
        WHERE section='privacy'
          AND json_type(payload, '$.commandHistoryEnabled') IS NULL;
    `,
  },
  {
    id: 9,
    risky: false,
    sql: `
      CREATE TABLE connection_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
      );
      CREATE UNIQUE INDEX connection_profiles_name_unique
        ON connection_profiles(lower(name));
      ALTER TABLE bookmarks ADD COLUMN connection_profile_id TEXT
        REFERENCES connection_profiles(id) ON DELETE RESTRICT;
      CREATE INDEX bookmarks_connection_profile
        ON bookmarks(connection_profile_id);
    `,
  },
  {
    id: 10,
    risky: false,
    sql: `
      CREATE TABLE electerm_import_entries (
        kind TEXT NOT NULL CHECK (kind IN ('group', 'profile', 'sshBookmark', 'quickCommand')),
        source_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        target_id TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        PRIMARY KEY (kind, source_id)
      );
      CREATE INDEX electerm_import_entries_target
        ON electerm_import_entries(kind, target_id);
    `,
  },
  {
    id: 11,
    risky: false,
    sql: `
      ALTER TABLE hosts ADD COLUMN proxy_command_executable TEXT;
      ALTER TABLE hosts ADD COLUMN proxy_command_arguments TEXT;
    `,
  },
  {
    id: 12,
    risky: false,
    sql: `
      ALTER TABLE hosts ADD COLUMN jump_host_ids TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(jump_host_ids) AND json_type(jump_host_ids) = 'array');
    `,
  },
  {
    id: 13,
    risky: false,
    sql: `
      ALTER TABLE hosts ADD COLUMN ssh_algorithms TEXT NOT NULL
        DEFAULT '{"kex":[],"cipher":[],"serverHostKey":[],"hmac":[]}'
        CHECK (json_valid(ssh_algorithms) AND json_type(ssh_algorithms) = 'object');
    `,
  },
  {
    id: 14,
    risky: false,
    sql: `
      ALTER TABLE hosts ADD COLUMN ssh_startup TEXT NOT NULL
        DEFAULT '{"directory":null,"environment":{},"loginScripts":[],"runScripts":[]}'
        CHECK (json_valid(ssh_startup) AND json_type(ssh_startup) = 'object');
    `,
  },
  {
    id: 15,
    risky: false,
    sql: `
      ALTER TABLE hosts ADD COLUMN ssh_x11 TEXT NOT NULL
        DEFAULT '{"enabled":false,"display":null}'
        CHECK (json_valid(ssh_x11) AND json_type(ssh_x11) = 'object');
    `,
  },
  {
    id: 16,
    risky: false,
    sql: `
      ALTER TABLE hosts ADD COLUMN certificate_credential_ref TEXT;
      ALTER TABLE hosts ADD COLUMN ssh_agent TEXT NOT NULL
        DEFAULT '{"enabled":true,"path":null}'
        CHECK (json_valid(ssh_agent) AND json_type(ssh_agent) = 'object');
    `,
  },
  {
    id: 17,
    risky: false,
    sql: `ALTER TABLE transfer_history ADD COLUMN bytes_per_second REAL;`,
  },
  {
    id: 18,
    risky: false,
    sql: `ALTER TABLE bookmarks ADD COLUMN ftp_payload TEXT NOT NULL DEFAULT 'null'
      CHECK (json_valid(ftp_payload));`,
  },
  {
    id: 19,
    risky: false,
    sql: `ALTER TABLE bookmarks ADD COLUMN telnet_payload TEXT NOT NULL DEFAULT 'null'
      CHECK (json_valid(telnet_payload));`,
  },
  {
    id: 20,
    risky: false,
    sql: `ALTER TABLE bookmarks ADD COLUMN serial_payload TEXT NOT NULL DEFAULT 'null'
      CHECK (json_valid(serial_payload));`,
  },
  {
    id: 21,
    risky: false,
    sql: `ALTER TABLE bookmarks ADD COLUMN rdp_payload TEXT NOT NULL DEFAULT 'null'
      CHECK (json_valid(rdp_payload));`,
  },
  {
    id: 22,
    risky: false,
    sql: `ALTER TABLE bookmarks ADD COLUMN vnc_payload TEXT NOT NULL DEFAULT 'null'
      CHECK (json_valid(vnc_payload));`,
  },
  {
    id: 23,
    risky: false,
    sql: `ALTER TABLE bookmarks ADD COLUMN spice_payload TEXT NOT NULL DEFAULT 'null'
      CHECK (json_valid(spice_payload));`,
  },
  {
    id: 24,
    risky: false,
    sql: `ALTER TABLE bookmarks ADD COLUMN web_payload TEXT NOT NULL DEFAULT 'null'
      CHECK (json_valid(web_payload));`,
  },
  {
    id: 25,
    risky: false,
    sql: `
      CREATE TABLE quick_command_groups (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES quick_command_groups(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        CHECK (id != parent_id)
      );
      ALTER TABLE quick_commands ADD COLUMN group_id TEXT
        REFERENCES quick_command_groups(id) ON DELETE SET NULL;
      ALTER TABLE quick_commands ADD COLUMN position INTEGER NOT NULL DEFAULT 0
        CHECK (position >= 0);
      UPDATE quick_commands AS current
      SET position = (
        SELECT COUNT(*) FROM quick_commands AS preceding
        WHERE lower(preceding.name) < lower(current.name)
           OR (lower(preceding.name) = lower(current.name) AND preceding.id < current.id)
      );
      CREATE INDEX quick_command_groups_parent_position
        ON quick_command_groups(parent_id, position, id);
      CREATE INDEX quick_commands_group_position
        ON quick_commands(group_id, position, id);
      INSERT INTO app_meta(key, value) VALUES ('quick-command-tree:revision', '1');
    `,
  },
  {
    id: 26,
    risky: false,
    sql: `ALTER TABLE bookmarks ADD COLUMN quick_commands_payload TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(quick_commands_payload) AND json_type(quick_commands_payload) = 'array');`,
  },
  {
    id: 27,
    risky: false,
    sql: `
      CREATE TABLE batch_operations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        state TEXT NOT NULL,
        target_count INTEGER NOT NULL CHECK (target_count > 0 AND target_count <= 64),
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX batch_operations_updated_at ON batch_operations(updated_at DESC, id DESC);
    `,
  },
  {
    id: 28,
    risky: false,
    sql: `
      CREATE TABLE automation_triggers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        position INTEGER NOT NULL CHECK (position >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX automation_triggers_position ON automation_triggers(position, id);
      INSERT INTO app_meta(key, value) VALUES ('trigger-list:revision', '1');
      ALTER TABLE bookmarks ADD COLUMN triggers_payload TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(triggers_payload) AND json_type(triggers_payload) = 'array');
    `,
  },
  {
    id: 29,
    risky: false,
    sql: `
      CREATE TABLE terminal_themes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX terminal_themes_name ON terminal_themes(lower(name), id);
    `,
  },
  {
    id: 30,
    risky: false,
    sql: `
      CREATE TABLE sync_profiles (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL UNIQUE
          CHECK (provider IN ('github','gitee','webdav','custom')),
        name TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        username TEXT,
        access_credential_ref TEXT,
        encryption_credential_ref TEXT,
        selected_categories TEXT NOT NULL CHECK (
          json_valid(selected_categories) AND json_type(selected_categories) = 'array'
        ),
        auto_sync_enabled INTEGER NOT NULL DEFAULT 0,
        auto_sync_interval_minutes INTEGER NOT NULL DEFAULT 5
          CHECK (auto_sync_interval_minutes BETWEEN 1 AND 1440),
        auto_sync_direction TEXT NOT NULL DEFAULT 'upload'
          CHECK (auto_sync_direction IN ('upload','download')),
        state TEXT NOT NULL DEFAULT 'idle'
          CHECK (state IN ('idle','checking','uploading','download-preview','failed')),
        remote_revision TEXT,
        last_sync_at TEXT,
        last_error_code TEXT,
        pending_preview_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX sync_profiles_auto ON sync_profiles(auto_sync_enabled, updated_at);
    `,
  },
  {
    id: 31,
    risky: false,
    sql: `
      ALTER TABLE ai_runs ADD COLUMN conversation_id TEXT;
      ALTER TABLE ai_messages ADD COLUMN run_id TEXT;
      ALTER TABLE ai_messages ADD COLUMN state TEXT NOT NULL DEFAULT 'complete'
        CHECK (state IN ('complete','failed','canceled'));
      ALTER TABLE ai_messages ADD COLUMN error_code TEXT;
      CREATE INDEX ai_runs_conversation ON ai_runs(conversation_id, created_at, id);
      CREATE UNIQUE INDEX ai_messages_run_role ON ai_messages(run_id, role)
        WHERE run_id IS NOT NULL;
      CREATE INDEX ai_messages_conversation ON ai_messages(conversation_id, created_at, id);
    `,
  },
  {
    id: 32,
    risky: false,
    sql: `
      ALTER TABLE ai_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(attachments_json) AND json_type(attachments_json) = 'array');
    `,
  },
  {
    id: 33,
    risky: true,
    sql: `
      UPDATE app_settings
      SET payload = json_set(
            payload,
            '$.restoreLayout', json('false'),
            '$.startupSessions', json('[]')
          ),
          version = version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE section = 'workspace' AND json_valid(payload);
    `,
  },
];

export class MigrationError extends Error {
  readonly code = 'MIGRATION_FAILED';
}

export class ProductDatabase {
  readonly orm;
  private readonly connection: DatabaseSync;
  private transactionDepth = 0;

  private constructor(
    readonly path: string,
    connection: DatabaseSync,
  ) {
    this.connection = connection;
    this.orm = drizzle(
      async (sql, params, method) => {
        const statement = this.connection.prepare(sql);
        const values = params as SQLInputValue[];
        if (method === 'run') {
          statement.run(...values);
          return { rows: [] };
        }
        if (method === 'get') {
          const row = statement.get(...values);
          return { rows: row ? Object.values(row) : [] };
        }
        return { rows: statement.all(...values).map((row) => Object.values(row)) };
      },
      { schema },
    );
  }

  static async open(path = ':memory:'): Promise<ProductDatabase> {
    if (path !== ':memory:') await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const exists = path !== ':memory:' && (await fileExists(path));
    const connection = new DatabaseSync(path);
    connection.exec(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;',
    );
    const database = new ProductDatabase(path, connection);
    try {
      if (exists) database.verifyIntegrity();
      await database.migrate();
      return database;
    } catch (error) {
      connection.close();
      if (error instanceof MigrationError) throw error;
      throw new MigrationError('Database migration failed', { cause: error });
    }
  }

  private verifyIntegrity(): void {
    const result = this.connection.prepare('PRAGMA quick_check').get() as
      Record<string, unknown> | undefined;
    if (!result || Object.values(result)[0] !== 'ok')
      throw new MigrationError('Database integrity check failed');
  }

  private async migrate(): Promise<void> {
    const hasMeta = this.connection
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='app_meta'")
      .get();
    const applied = new Map<number, string>();
    if (hasMeta) {
      for (const row of this.connection
        .prepare("SELECT key, value FROM app_meta WHERE key LIKE 'migration:%'")
        .all() as Array<{ key: string; value: string }>) {
        applied.set(Number(row.key.slice('migration:'.length)), row.value);
      }
    }
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
      const previous = applied.get(migration.id);
      if (previous && previous !== checksum)
        throw new MigrationError(`Migration ${migration.id} checksum mismatch`);
      if (previous) continue;
      if (migration.risky && this.path !== ':memory:')
        await copyFile(this.path, `${this.path}.pre-migration-${migration.id}.bak`);
      try {
        this.connection.exec('BEGIN IMMEDIATE');
        this.connection.exec(migration.sql);
        this.connection
          .prepare('INSERT INTO app_meta(key, value) VALUES (?, ?)')
          .run(`migration:${migration.id}`, checksum);
        this.connection.exec('COMMIT');
      } catch (error) {
        try {
          this.connection.exec('ROLLBACK');
        } catch {
          // The original migration error is more useful than a redundant rollback error.
        }
        throw new MigrationError(`Migration ${migration.id} failed`, { cause: error });
      }
    }
  }

  recordAppVersion(appVersion: string, startedAt = new Date().toISOString()): AppVersionTransition {
    const currentVersion = appVersion.trim();
    if (
      !currentVersion ||
      currentVersion.length > 80 ||
      [...currentVersion].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 32 || codePoint === 127;
      })
    )
      throw new Error('Application version is invalid');
    const current = this.get<{ value: string }>(
      "SELECT value FROM app_meta WHERE key='app:current-version'",
    )?.value;
    const priorPrevious = this.get<{ value: string }>(
      "SELECT value FROM app_meta WHERE key='app:previous-version'",
    )?.value;
    const upgraded = current !== undefined && current !== currentVersion;
    const previousVersion = upgraded ? current : (priorPrevious ?? null);
    this.transaction(() => {
      if (upgraded)
        this.run(
          `INSERT INTO app_meta(key, value) VALUES ('app:previous-version', ?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
          current,
        );
      this.run(
        `INSERT INTO app_meta(key, value) VALUES ('app:current-version', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        currentVersion,
      );
      this.run(
        `INSERT INTO app_meta(key, value) VALUES ('app:last-started-at', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        startedAt,
      );
    });
    return { currentVersion, previousVersion, upgraded, startedAt };
  }

  all<T extends object>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.connection.prepare(sql).all(...params) as unknown as T[];
  }

  get<T extends object>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.connection.prepare(sql).get(...params) as unknown as T | undefined;
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.connection.prepare(sql).run(...params);
  }

  transaction<T>(operation: () => T): T {
    const depth = this.transactionDepth;
    const savepoint = `axterm_nested_${depth}`;
    if (depth === 0) this.connection.exec('BEGIN IMMEDIATE');
    else this.connection.exec(`SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = operation();
      if (depth === 0) this.connection.exec('COMMIT');
      else this.connection.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      if (depth === 0) this.connection.exec('ROLLBACK');
      else {
        this.connection.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.connection.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  appendEvent(type: string, aggregateId: string, payload: unknown): number {
    const result = this.run(
      'INSERT INTO domain_events(event_id, type, aggregate_id, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      randomUUID(),
      type,
      aggregateId,
      JSON.stringify(payload),
      new Date().toISOString(),
    );
    const cursor = Number(result.lastInsertRowid);
    this.run(
      'DELETE FROM domain_events WHERE id <= ?',
      cursor - DEFAULT_DOMAIN_EVENT_RETENTION_LIMIT,
    );
    return cursor;
  }

  async backup(destination: string): Promise<void> {
    if (this.path === ':memory:') throw new Error('In-memory databases cannot be backed up');
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    this.connection.exec('PRAGMA wal_checkpoint(FULL)');
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await copyFile(this.path, temporary);
      verifyDatabaseFile(temporary);
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  static async restore(source: string, destination: string): Promise<string> {
    if (source === destination) throw new Error('Backup and product database paths must differ');
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.restore`;
    const previous = `${destination}.pre-restore-${Date.now()}.bak`;
    try {
      await copyFile(source, temporary);
      verifyDatabaseFile(temporary);
      if (await fileExists(destination)) await copyFile(destination, previous);
      await rename(temporary, destination);
      return previous;
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function verifyDatabaseFile(path: string): void {
  const connection = new DatabaseSync(path, { readOnly: true });
  try {
    const result = connection.prepare('PRAGMA quick_check').get() as
      Record<string, unknown> | undefined;
    const meta = connection
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='app_meta'")
      .get();
    if (!result || Object.values(result)[0] !== 'ok' || !meta)
      throw new MigrationError('Backup validation failed');
  } finally {
    connection.close();
  }
}
