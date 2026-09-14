import { createHash, randomUUID } from 'node:crypto';
import type {
  AiConversation,
  AiConversationInput,
  AiConversationPatch,
  AiAttachmentMetadata,
  AiMessage,
  AiRun,
  Host,
  KnownHostKey,
  HostProxyConfig,
  HostGroup,
  Settings,
  TerminalProfile,
  TunnelProfile,
  Transfer,
  AiApproval,
  AiToolCall,
  CreateHostInput,
  UpdateSettingsInput,
  UpdateHostInput,
} from '@workspace/contracts';
import {
  aiAttachmentMetadataSchema,
  createHostSchema,
  hostProxySchema,
  idSchema,
  settingsSchema,
  sshAgentSchema,
  sshAlgorithmsSchema,
  sshStartupSchema,
  sshX11Schema,
  updateHostSchema,
  updateSettingsSchema,
} from '@workspace/contracts';
import { ApplicationError } from '../../application/errors';
import type { ProductDatabase } from './database';

interface HostGroupRow {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  version: number;
}
interface HostRow {
  id: string;
  group_id: string | null;
  name: string;
  hostname: string;
  port: number;
  username: string;
  auth_type: Host['authType'];
  credential_ref: string | null;
  passphrase_credential_ref: string | null;
  certificate_credential_ref: string | null;
  jump_host_id: string | null;
  jump_host_ids: string;
  favorite: number;
  proxy_mode: HostProxyConfig['mode'];
  proxy_url: string | null;
  proxy_username: string | null;
  proxy_credential_ref: string | null;
  proxy_command_executable: string | null;
  proxy_command_arguments: string | null;
  connection_timeout_ms: number;
  keepalive_interval_ms: number;
  keepalive_count_max: number;
  compression: number;
  reconnect_mode: Host['connectionOptions']['reconnectPolicy']['mode'];
  reconnect_delay_ms: number;
  reconnect_max_attempts: number;
  ssh_algorithms: string;
  ssh_startup: string;
  ssh_x11: string;
  ssh_agent: string;
  created_at: string;
  updated_at: string;
  version: number;
}
interface KnownHostKeyRow {
  id: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  public_key: string;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  version: number;
}
interface JsonRow {
  id: string;
  name: string;
  payload: string;
  created_at: string;
  updated_at: string;
  version: number;
}
const groupFromRow = (row: HostGroupRow): HostGroup => ({
  id: row.id,
  name: row.name,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  version: row.version,
});
const hostFromRow = (row: HostRow): Host => ({
  id: row.id,
  groupId: row.group_id,
  name: row.name,
  hostname: row.hostname,
  port: row.port,
  username: row.username,
  authType: row.auth_type,
  credentialRef: row.credential_ref,
  passphraseCredentialRef: row.passphrase_credential_ref,
  certificateCredentialRef: row.certificate_credential_ref,
  jumpHostId: row.jump_host_id,
  jumpHostIds: idSchema.array().max(8).parse(JSON.parse(row.jump_host_ids)),
  favorite: row.favorite === 1,
  proxy: hostProxySchema.parse(
    row.proxy_command_executable && row.proxy_command_arguments
      ? {
          mode: 'command',
          command: {
            executable: row.proxy_command_executable,
            arguments: JSON.parse(row.proxy_command_arguments) as unknown,
          },
        }
      : row.proxy_mode === 'custom'
        ? {
            mode: 'custom',
            endpoint: {
              url: row.proxy_url,
              username: row.proxy_username,
              credentialRef: row.proxy_credential_ref,
            },
          }
        : { mode: row.proxy_mode },
  ),
  connectionOptions: {
    connectionTimeoutMs: row.connection_timeout_ms,
    keepaliveIntervalMs: row.keepalive_interval_ms,
    keepaliveCountMax: row.keepalive_count_max,
    compression: row.compression === 1,
    algorithms: sshAlgorithmsSchema.parse(JSON.parse(row.ssh_algorithms)),
    reconnectPolicy: {
      mode: row.reconnect_mode,
      delayMs: row.reconnect_delay_ms,
      maxAttempts: row.reconnect_max_attempts,
    },
  },
  startup: sshStartupSchema.parse(JSON.parse(row.ssh_startup)),
  x11: sshX11Schema.parse(JSON.parse(row.ssh_x11)),
  sshAgent: sshAgentSchema.parse(JSON.parse(row.ssh_agent)),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  version: row.version,
});
const knownHostKeyFromRow = (row: KnownHostKeyRow): KnownHostKey => ({
  id: row.id,
  host: row.host,
  port: row.port,
  algorithm: row.algorithm,
  fingerprint: row.fingerprint,
  publicKey: row.public_key,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  version: row.version,
});

export const etagFor = (version: number) => `"v${version}"`;
export const DEFAULT_IDEMPOTENCY_RECEIPT_LIMIT = 2_000;
const versionFromEtag = (value: string | undefined): number => {
  if (!value) throw new ApplicationError('PRECONDITION_REQUIRED', 'If-Match is required', 428);
  const match = /^"v(\d+)"$/.exec(value);
  if (!match) throw new ApplicationError('PRECONDITION_FAILED', 'Invalid entity version', 412);
  return Number(match[1]);
};

export class ProductRepository {
  constructor(private readonly database: ProductDatabase) {}

  listHostGroups(): HostGroup[] {
    return this.database
      .all<HostGroupRow>('SELECT * FROM host_groups ORDER BY sort_order, name')
      .map(groupFromRow);
  }

  createHostGroup(input: { name: string; sortOrder: number }): HostGroup {
    const now = new Date().toISOString();
    const entity: HostGroup = {
      id: randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    try {
      this.database.transaction(() => {
        this.database.run(
          'INSERT INTO host_groups(id, name, sort_order, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)',
          entity.id,
          entity.name,
          entity.sortOrder,
          now,
          now,
        );
        this.database.appendEvent('host-group.created', entity.id, entity);
      });
    } catch (error) {
      throwConstraint(error, 'A host group with this name already exists');
    }
    return entity;
  }

  updateHostGroup(
    id: string,
    input: { name?: string | undefined; sortOrder?: number | undefined },
    ifMatch: string | undefined,
  ): HostGroup {
    const current = this.requireHostGroup(id);
    const version = versionFromEtag(ifMatch);
    if (current.version !== version)
      throw new ApplicationError('PRECONDITION_FAILED', 'Host group changed', 412);
    const next: HostGroup = {
      ...current,
      name: input.name ?? current.name,
      sortOrder: input.sortOrder ?? current.sortOrder,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    try {
      this.database.transaction(() => {
        const result = this.database.run(
          'UPDATE host_groups SET name = ?, sort_order = ?, updated_at = ?, version = ? WHERE id = ? AND version = ?',
          next.name,
          next.sortOrder,
          next.updatedAt,
          next.version,
          id,
          current.version,
        );
        if (!result.changes)
          throw new ApplicationError('PRECONDITION_FAILED', 'Host group changed', 412);
        this.database.appendEvent('host-group.updated', id, next);
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throwConstraint(error, 'A host group with this name already exists');
    }
    return next;
  }

  deleteHostGroup(id: string, ifMatch: string | undefined): void {
    const current = this.requireHostGroup(id);
    if (current.version !== versionFromEtag(ifMatch))
      throw new ApplicationError('PRECONDITION_FAILED', 'Host group changed', 412);
    this.database.transaction(() => {
      const result = this.database.run(
        'DELETE FROM host_groups WHERE id = ? AND version = ?',
        id,
        current.version,
      );
      if (!result.changes)
        throw new ApplicationError('PRECONDITION_FAILED', 'Host group changed', 412);
      this.database.appendEvent('host-group.deleted', id, { id });
    });
  }

  private requireHostGroup(id: string): HostGroup {
    const row = this.database.get<HostGroupRow>('SELECT * FROM host_groups WHERE id = ?', id);
    if (!row) throw new ApplicationError('NOT_FOUND', 'Host group not found', 404);
    return groupFromRow(row);
  }

  listHosts(): Host[] {
    return this.database
      .all<HostRow>('SELECT * FROM hosts ORDER BY favorite DESC, name')
      .map(hostFromRow);
  }

  getHost(id: string): Host {
    const row = this.database.get<HostRow>('SELECT * FROM hosts WHERE id = ?', id);
    if (!row) throw new ApplicationError('NOT_FOUND', 'Host not found', 404);
    return hostFromRow(row);
  }

  assertHostVersion(id: string, ifMatch: string | undefined): Host {
    const current = this.getHost(id);
    if (current.version !== versionFromEtag(ifMatch))
      throw new ApplicationError('PRECONDITION_FAILED', 'Host changed', 412);
    return current;
  }

  hostRetentionReasons(id: string): Array<'bookmark' | 'jumpHost' | 'history' | 'tunnel'> {
    this.getHost(id);
    const reasons: Array<'bookmark' | 'jumpHost' | 'history' | 'tunnel'> = [];
    if (this.database.get('SELECT id FROM bookmarks WHERE host_id = ? LIMIT 1', id))
      reasons.push('bookmark');
    if (
      this.database.get('SELECT id FROM hosts WHERE jump_host_id = ? LIMIT 1', id) ||
      this.database.get(
        `SELECT hosts.id FROM hosts, json_each(hosts.jump_host_ids)
         WHERE json_each.value = ? LIMIT 1`,
        id,
      )
    )
      reasons.push('jumpHost');
    if (
      this.database.get(
        'SELECT id FROM recent_connections WHERE host_id = ? OR jump_host_id = ? LIMIT 1',
        id,
        id,
      )
    )
      reasons.push('history');
    if (
      this.database.get(
        `SELECT id FROM tunnel_profiles
         WHERE json_valid(payload) AND json_extract(payload, '$.hostId') = ? LIMIT 1`,
        id,
      )
    )
      reasons.push('tunnel');
    return reasons;
  }

  createHost(input: CreateHostInput): Host {
    const command = createHostSchema.parse(input);
    if (command.groupId) this.requireHostGroup(command.groupId);
    const now = new Date().toISOString();
    const entity: Host = {
      id: randomUUID(),
      ...command,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.assertJumpConfiguration(entity.id, entity.jumpHostId, entity.jumpHostIds);
    try {
      this.database.transaction(() => {
        this.database.run(
          `INSERT INTO hosts(id, group_id, name, hostname, port, username, auth_type,
            credential_ref, passphrase_credential_ref, certificate_credential_ref,
            jump_host_id, jump_host_ids, favorite,
            proxy_mode, proxy_url, proxy_username, proxy_credential_ref,
            proxy_command_executable, proxy_command_arguments,
            connection_timeout_ms, keepalive_interval_ms, keepalive_count_max, compression,
            reconnect_mode, reconnect_delay_ms, reconnect_max_attempts,
            ssh_algorithms, ssh_startup, ssh_x11, ssh_agent, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          entity.id,
          entity.groupId,
          entity.name,
          entity.hostname,
          entity.port,
          entity.username,
          entity.authType,
          entity.credentialRef,
          entity.passphraseCredentialRef,
          entity.certificateCredentialRef,
          entity.jumpHostId,
          JSON.stringify(entity.jumpHostIds),
          entity.favorite ? 1 : 0,
          entity.proxy.mode === 'command' ? 'direct' : entity.proxy.mode,
          entity.proxy.mode === 'custom' ? entity.proxy.endpoint.url : null,
          entity.proxy.mode === 'custom' ? entity.proxy.endpoint.username : null,
          entity.proxy.mode === 'custom' ? entity.proxy.endpoint.credentialRef : null,
          entity.proxy.mode === 'command' ? entity.proxy.command.executable : null,
          entity.proxy.mode === 'command' ? JSON.stringify(entity.proxy.command.arguments) : null,
          entity.connectionOptions.connectionTimeoutMs,
          entity.connectionOptions.keepaliveIntervalMs,
          entity.connectionOptions.keepaliveCountMax,
          entity.connectionOptions.compression ? 1 : 0,
          entity.connectionOptions.reconnectPolicy.mode,
          entity.connectionOptions.reconnectPolicy.delayMs,
          entity.connectionOptions.reconnectPolicy.maxAttempts,
          JSON.stringify(entity.connectionOptions.algorithms),
          JSON.stringify(entity.startup),
          JSON.stringify(entity.x11),
          JSON.stringify(entity.sshAgent),
          now,
          now,
        );
        this.database.appendEvent('host.created', entity.id, entity);
      });
    } catch (error) {
      throwConstraint(error, 'A host with this name already exists');
    }
    return entity;
  }

  updateHost(id: string, input: UpdateHostInput, ifMatch: string | undefined): Host {
    const command = updateHostSchema.parse(input);
    const current = this.getHost(id);
    if (current.version !== versionFromEtag(ifMatch))
      throw new ApplicationError('PRECONDITION_FAILED', 'Host changed', 412);
    const next: Host = {
      ...current,
      groupId: command.groupId === undefined ? current.groupId : command.groupId,
      name: command.name ?? current.name,
      hostname: command.hostname ?? current.hostname,
      port: command.port ?? current.port,
      username: command.username ?? current.username,
      authType: command.authType ?? current.authType,
      credentialRef:
        command.credentialRef === undefined ? current.credentialRef : command.credentialRef,
      passphraseCredentialRef:
        command.passphraseCredentialRef === undefined
          ? current.passphraseCredentialRef
          : command.passphraseCredentialRef,
      certificateCredentialRef:
        command.certificateCredentialRef === undefined
          ? current.certificateCredentialRef
          : command.certificateCredentialRef,
      jumpHostId: command.jumpHostId === undefined ? current.jumpHostId : command.jumpHostId,
      jumpHostIds: command.jumpHostIds === undefined ? current.jumpHostIds : command.jumpHostIds,
      favorite: command.favorite ?? current.favorite,
      proxy: command.proxy ?? current.proxy,
      connectionOptions: {
        connectionTimeoutMs:
          command.connectionOptions?.connectionTimeoutMs ??
          current.connectionOptions.connectionTimeoutMs,
        keepaliveIntervalMs:
          command.connectionOptions?.keepaliveIntervalMs ??
          current.connectionOptions.keepaliveIntervalMs,
        keepaliveCountMax:
          command.connectionOptions?.keepaliveCountMax ??
          current.connectionOptions.keepaliveCountMax,
        compression:
          command.connectionOptions?.compression ?? current.connectionOptions.compression,
        algorithms: {
          kex:
            command.connectionOptions?.algorithms?.kex ?? current.connectionOptions.algorithms.kex,
          cipher:
            command.connectionOptions?.algorithms?.cipher ??
            current.connectionOptions.algorithms.cipher,
          serverHostKey:
            command.connectionOptions?.algorithms?.serverHostKey ??
            current.connectionOptions.algorithms.serverHostKey,
          hmac:
            command.connectionOptions?.algorithms?.hmac ??
            current.connectionOptions.algorithms.hmac,
        },
        reconnectPolicy: {
          mode:
            command.connectionOptions?.reconnectPolicy?.mode ??
            current.connectionOptions.reconnectPolicy.mode,
          delayMs:
            command.connectionOptions?.reconnectPolicy?.delayMs ??
            current.connectionOptions.reconnectPolicy.delayMs,
          maxAttempts:
            command.connectionOptions?.reconnectPolicy?.maxAttempts ??
            current.connectionOptions.reconnectPolicy.maxAttempts,
        },
      },
      startup: {
        directory:
          command.startup?.directory === undefined
            ? current.startup.directory
            : command.startup.directory,
        environment: command.startup?.environment ?? current.startup.environment,
        loginScripts: command.startup?.loginScripts ?? current.startup.loginScripts,
        runScripts: command.startup?.runScripts ?? current.startup.runScripts,
      },
      x11: {
        enabled: command.x11?.enabled ?? current.x11.enabled,
        display: command.x11?.display === undefined ? current.x11.display : command.x11.display,
      },
      sshAgent: {
        enabled: command.sshAgent?.enabled ?? current.sshAgent.enabled,
        path: command.sshAgent?.path === undefined ? current.sshAgent.path : command.sshAgent.path,
      },
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    if (next.groupId) this.requireHostGroup(next.groupId);
    this.assertJumpConfiguration(id, next.jumpHostId, next.jumpHostIds);
    try {
      this.database.transaction(() => {
        const result = this.database.run(
          `UPDATE hosts SET group_id=?, name=?, hostname=?, port=?, username=?, auth_type=?,
            credential_ref=?, passphrase_credential_ref=?, certificate_credential_ref=?,
            jump_host_id=?, jump_host_ids=?, favorite=?,
            proxy_mode=?, proxy_url=?, proxy_username=?, proxy_credential_ref=?,
            proxy_command_executable=?, proxy_command_arguments=?,
            connection_timeout_ms=?, keepalive_interval_ms=?, keepalive_count_max=?, compression=?,
            reconnect_mode=?, reconnect_delay_ms=?, reconnect_max_attempts=?,
            ssh_algorithms=?, ssh_startup=?, ssh_x11=?, ssh_agent=?, updated_at=?, version=? WHERE id=? AND version=?`,
          next.groupId,
          next.name,
          next.hostname,
          next.port,
          next.username,
          next.authType,
          next.credentialRef,
          next.passphraseCredentialRef,
          next.certificateCredentialRef,
          next.jumpHostId,
          JSON.stringify(next.jumpHostIds),
          next.favorite ? 1 : 0,
          next.proxy.mode === 'command' ? 'direct' : next.proxy.mode,
          next.proxy.mode === 'custom' ? next.proxy.endpoint.url : null,
          next.proxy.mode === 'custom' ? next.proxy.endpoint.username : null,
          next.proxy.mode === 'custom' ? next.proxy.endpoint.credentialRef : null,
          next.proxy.mode === 'command' ? next.proxy.command.executable : null,
          next.proxy.mode === 'command' ? JSON.stringify(next.proxy.command.arguments) : null,
          next.connectionOptions.connectionTimeoutMs,
          next.connectionOptions.keepaliveIntervalMs,
          next.connectionOptions.keepaliveCountMax,
          next.connectionOptions.compression ? 1 : 0,
          next.connectionOptions.reconnectPolicy.mode,
          next.connectionOptions.reconnectPolicy.delayMs,
          next.connectionOptions.reconnectPolicy.maxAttempts,
          JSON.stringify(next.connectionOptions.algorithms),
          JSON.stringify(next.startup),
          JSON.stringify(next.x11),
          JSON.stringify(next.sshAgent),
          next.updatedAt,
          next.version,
          id,
          current.version,
        );
        if (!result.changes) throw new ApplicationError('PRECONDITION_FAILED', 'Host changed', 412);
        this.database.appendEvent('host.updated', id, next);
      });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throwConstraint(error, 'A host with this name already exists');
    }
    return next;
  }

  deleteHost(id: string, ifMatch: string | undefined): void {
    const current = this.assertHostVersion(id, ifMatch);
    this.database.transaction(() => {
      if (this.database.get('SELECT id FROM bookmarks WHERE host_id = ? LIMIT 1', id))
        throw new ApplicationError(
          'CONFLICT',
          'Host is referenced by a Bookmark; use the saved SSH destination delete workflow',
          409,
        );
      this.database.run(
        'UPDATE hosts SET jump_host_id = NULL, version = version + 1 WHERE jump_host_id = ?',
        id,
      );
      this.database.run(
        `UPDATE hosts
         SET jump_host_ids=(
           SELECT json_group_array(value) FROM json_each(hosts.jump_host_ids) WHERE value != ?
         ), version=version+1
         WHERE EXISTS (SELECT 1 FROM json_each(hosts.jump_host_ids) WHERE value = ?)`,
        id,
        id,
      );
      const result = this.database.run(
        'DELETE FROM hosts WHERE id = ? AND version = ?',
        id,
        current.version,
      );
      if (!result.changes) throw new ApplicationError('PRECONDITION_FAILED', 'Host changed', 412);
      this.database.appendEvent('host.deleted', id, { id });
    });
  }

  private assertJumpConfiguration(
    hostId: string,
    jumpHostId: string | null,
    jumpHostIds: string[],
  ): void {
    if (jumpHostId && jumpHostIds.length)
      throw new ApplicationError(
        'CONFLICT',
        'Legacy and ordered jump-host settings cannot be combined',
        409,
      );
    const explicit = new Set([hostId]);
    for (const id of jumpHostIds) {
      if (explicit.has(id)) throw new ApplicationError('CONFLICT', 'Jump host cycle detected', 409);
      explicit.add(id);
      this.getHost(id);
    }
    const visited = new Set([hostId]);
    let cursor = jumpHostId;
    while (cursor) {
      if (visited.has(cursor))
        throw new ApplicationError('CONFLICT', 'Jump host cycle detected', 409);
      visited.add(cursor);
      cursor = this.getHost(cursor).jumpHostId;
    }
  }

  getSettings(): Settings {
    const rows = this.database.all<{ section: string; payload: string; version: number }>(
      'SELECT section, payload, version FROM app_settings',
    );
    const appearance = rows.find((row) => row.section === 'appearance');
    const workspace = rows.find((row) => row.section === 'workspace');
    const privacy = rows.find((row) => row.section === 'privacy');
    const network = rows.find((row) => row.section === 'network');
    const shortcuts = rows.find((row) => row.section === 'shortcuts');
    const terminal = rows.find((row) => row.section === 'terminal');
    const fileManager = rows.find((row) => row.section === 'fileManager');
    const monitor = rows.find((row) => row.section === 'monitor');
    return settingsSchema.parse({
      appearance: appearance
        ? JSON.parse(appearance.payload)
        : { theme: 'dark', language: 'zh-CN' },
      workspace: workspace
        ? JSON.parse(workspace.payload)
        : {
            restoreLayout: false,
            aiInspectorOpen: false,
            namedWorkspaces: [],
            activeWorkspaceId: null,
            startupSessions: [],
            showTabNumber: true,
            switchTabOnHover: false,
            activityRailItems: [
              'newBookmark',
              'quickConnect',
              'bookmarks',
              'terminalThemes',
              'setting',
              'settingSync',
              'widgets',
            ],
          },
      privacy: privacy
        ? JSON.parse(privacy.payload)
        : {
            connectionHistoryEnabled: true,
            commandHistoryEnabled: false,
            hideAddresses: false,
          },
      network: network ? JSON.parse(network.payload) : { proxy: { mode: 'direct' } },
      shortcuts: shortcuts ? JSON.parse(shortcuts.payload) : { bindings: {} },
      terminal: terminal
        ? JSON.parse(terminal.payload)
        : {
            defaultProfileId: null,
            screenReaderMode: false,
            autoReconnectTerminal: false,
            restoreTerminalSessionOnReload: false,
            commandSuggestionsEnabled: false,
            dragDropBehavior: 'ask',
          },
      fileManager: fileManager
        ? JSON.parse(fileManager.payload)
        : {
            showHiddenFiles: true,
            externalEditor: '',
            refreshOnFocus: false,
            followTerminalCwd: false,
            sshSplitView: false,
            remoteAddressBookmarks: [],
            columns: ['name', 'size', 'modifiedAt'],
            localSort: { property: 'modifiedAt', direction: 'desc' },
            remoteSort: { property: 'modifiedAt', direction: 'desc' },
          },
      monitor: monitor
        ? JSON.parse(monitor.payload)
        : {
            terminalInformationItems: [
              'sysinfo',
              'uptime',
              'cpu',
              'memory',
              'activities',
              'network',
              'disks',
            ],
            remoteMonitorBarEnabled: false,
            remoteMonitorBarItems: [
              'hostname',
              'cpu',
              'cpuHistory',
              'memory',
              'upload',
              'download',
              'uptime',
              'users',
              'disks',
            ],
          },
      version: Math.max(
        appearance?.version ?? 1,
        workspace?.version ?? 1,
        privacy?.version ?? 1,
        network?.version ?? 1,
        shortcuts?.version ?? 1,
        terminal?.version ?? 1,
        fileManager?.version ?? 1,
        monitor?.version ?? 1,
      ),
    });
  }

  updateSettings(input: UpdateSettingsInput, ifMatch: string | undefined): Settings {
    const command = updateSettingsSchema.parse(input);
    const current = this.getSettings();
    if (current.version !== versionFromEtag(ifMatch))
      throw new ApplicationError('PRECONDITION_FAILED', 'Settings changed', 412);
    const next: Settings = {
      appearance: {
        theme: command.appearance?.theme ?? current.appearance.theme,
        language: command.appearance?.language ?? current.appearance.language,
      },
      workspace: {
        restoreLayout: command.workspace?.restoreLayout ?? current.workspace.restoreLayout,
        aiInspectorOpen: command.workspace?.aiInspectorOpen ?? current.workspace.aiInspectorOpen,
        namedWorkspaces: command.workspace?.namedWorkspaces ?? current.workspace.namedWorkspaces,
        activeWorkspaceId:
          command.workspace?.activeWorkspaceId === undefined
            ? current.workspace.activeWorkspaceId
            : command.workspace.activeWorkspaceId,
        startupSessions: command.workspace?.startupSessions ?? current.workspace.startupSessions,
        showTabNumber: command.workspace?.showTabNumber ?? current.workspace.showTabNumber,
        switchTabOnHover: command.workspace?.switchTabOnHover ?? current.workspace.switchTabOnHover,
        activityRailItems:
          command.workspace?.activityRailItems ?? current.workspace.activityRailItems,
        ...(command.workspace?.layout === undefined && current.workspace.layout === undefined
          ? {}
          : { layout: command.workspace?.layout ?? current.workspace.layout! }),
      },
      privacy: {
        connectionHistoryEnabled:
          command.privacy?.connectionHistoryEnabled ?? current.privacy.connectionHistoryEnabled,
        commandHistoryEnabled:
          command.privacy?.commandHistoryEnabled ?? current.privacy.commandHistoryEnabled,
        hideAddresses: command.privacy?.hideAddresses ?? current.privacy.hideAddresses,
      },
      network: {
        proxy: command.network?.proxy ?? current.network.proxy,
      },
      shortcuts: {
        bindings: command.shortcuts?.bindings ?? current.shortcuts.bindings,
      },
      terminal: {
        defaultProfileId:
          command.terminal?.defaultProfileId === undefined
            ? current.terminal.defaultProfileId
            : command.terminal.defaultProfileId,
        screenReaderMode: command.terminal?.screenReaderMode ?? current.terminal.screenReaderMode,
        autoReconnectTerminal:
          command.terminal?.autoReconnectTerminal ?? current.terminal.autoReconnectTerminal,
        restoreTerminalSessionOnReload:
          command.terminal?.restoreTerminalSessionOnReload ??
          current.terminal.restoreTerminalSessionOnReload,
        commandSuggestionsEnabled:
          command.terminal?.commandSuggestionsEnabled ?? current.terminal.commandSuggestionsEnabled,
        dragDropBehavior: command.terminal?.dragDropBehavior ?? current.terminal.dragDropBehavior,
        shortcutBarEnabled:
          command.terminal?.shortcutBarEnabled ?? current.terminal.shortcutBarEnabled,
        shortcutBarButtons:
          command.terminal?.shortcutBarButtons ?? current.terminal.shortcutBarButtons,
        visual: command.terminal?.visual ?? current.terminal.visual,
      },
      fileManager: {
        showHiddenFiles:
          command.fileManager?.showHiddenFiles ?? current.fileManager.showHiddenFiles,
        externalEditor: command.fileManager?.externalEditor ?? current.fileManager.externalEditor,
        refreshOnFocus: command.fileManager?.refreshOnFocus ?? current.fileManager.refreshOnFocus,
        followTerminalCwd:
          command.fileManager?.followTerminalCwd ?? current.fileManager.followTerminalCwd,
        sshSplitView: command.fileManager?.sshSplitView ?? current.fileManager.sshSplitView,
        remoteAddressBookmarks:
          command.fileManager?.remoteAddressBookmarks ?? current.fileManager.remoteAddressBookmarks,
        columns: command.fileManager?.columns ?? current.fileManager.columns,
        localSort: command.fileManager?.localSort ?? current.fileManager.localSort,
        remoteSort: command.fileManager?.remoteSort ?? current.fileManager.remoteSort,
      },
      monitor: {
        terminalInformationItems:
          command.monitor?.terminalInformationItems ?? current.monitor.terminalInformationItems,
        remoteMonitorBarEnabled:
          command.monitor?.remoteMonitorBarEnabled ?? current.monitor.remoteMonitorBarEnabled,
        remoteMonitorBarItems:
          command.monitor?.remoteMonitorBarItems ?? current.monitor.remoteMonitorBarItems,
      },
      version: current.version + 1,
    };
    const now = new Date().toISOString();
    this.database.transaction(() => {
      for (const section of [
        'appearance',
        'workspace',
        'privacy',
        'network',
        'shortcuts',
        'terminal',
        'fileManager',
        'monitor',
      ] as const)
        this.database.run(
          `INSERT INTO app_settings(section, payload, version, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(section) DO UPDATE SET payload=excluded.payload, version=excluded.version, updated_at=excluded.updated_at`,
          section,
          JSON.stringify(next[section]),
          next.version,
          now,
        );
      if (command.privacy?.connectionHistoryEnabled === false) {
        const deletedCount = Number(this.database.run('DELETE FROM recent_connections').changes);
        if (deletedCount) {
          const advanced = this.database.run(
            `UPDATE app_meta SET value=CAST(CAST(value AS INTEGER) + 1 AS TEXT)
             WHERE key='connection-history:revision'`,
          );
          if (!advanced.changes)
            throw new ApplicationError(
              'INVALID_STATE',
              'Connection history revision is unavailable',
            );
          const revision = Number(
            this.database.get<{ value: string }>(
              "SELECT value FROM app_meta WHERE key='connection-history:revision'",
            )?.value,
          );
          this.database.appendEvent('connection-history.cleared', 'connection-history', {
            deletedCount,
            historyRevision: revision,
            reason: 'disabled-by-setting',
          });
        }
      }
      if (command.privacy?.commandHistoryEnabled === false) {
        const deletedCount = Number(this.database.run('DELETE FROM command_history').changes);
        this.deleteIdempotencyByOperationPrefix('command-history.');
        if (deletedCount) {
          const advanced = this.database.run(
            `UPDATE app_meta SET value=CAST(CAST(value AS INTEGER) + 1 AS TEXT)
             WHERE key='command-history:revision'`,
          );
          if (!advanced.changes)
            throw new ApplicationError('INVALID_STATE', 'Command history revision is unavailable');
          const revision = Number(
            this.database.get<{ value: string }>(
              "SELECT value FROM app_meta WHERE key='command-history:revision'",
            )?.value,
          );
          this.database.appendEvent('command-history.cleared', 'command-history', {
            deletedCount,
            historyRevision: revision,
            reason: 'disabled-by-setting',
          });
        }
      }
      this.database.appendEvent('settings.updated', 'settings', next);
    });
    return next;
  }

  listEvents(after = 0, limit = 200) {
    return this.database
      .all<{
        id: number;
        event_id: string;
        type: string;
        aggregate_id: string;
        payload: string;
        created_at: string;
      }>('SELECT * FROM domain_events WHERE id > ? ORDER BY id LIMIT ?', after, limit)
      .map((row) => ({
        cursor: row.id,
        eventId: row.event_id,
        type: row.type,
        aggregateId: row.aggregate_id,
        payload: JSON.parse(row.payload),
        createdAt: row.created_at,
      }));
  }

  eventBounds(): { earliest: number; latest: number } {
    const row = this.database.get<{ earliest: number | null; latest: number | null }>(
      'SELECT MIN(id) AS earliest, MAX(id) AS latest FROM domain_events',
    );
    return { earliest: row?.earliest ?? 0, latest: row?.latest ?? 0 };
  }

  saveTransfer(input: Transfer & { source: string; destination: string }): void {
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO transfer_history(id, connection_id, direction, state, source, destination,
          bytes_transferred, total_bytes, bytes_per_second, error_code, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET state=excluded.state,
          bytes_transferred=excluded.bytes_transferred, total_bytes=excluded.total_bytes,
          bytes_per_second=excluded.bytes_per_second, error_code=excluded.error_code,
          updated_at=excluded.updated_at,
          version=transfer_history.version+1`,
        input.id,
        input.connectionId,
        input.direction,
        input.state,
        input.source,
        input.destination,
        input.bytesTransferred,
        input.totalBytes ?? null,
        input.bytesPerSecond ?? null,
        input.errorCode ?? null,
        input.createdAt,
        input.updatedAt,
      );
      this.database.appendEvent('transfer.updated', input.id, input);
    });
  }

  listTransfers(): Transfer[] {
    return this.database
      .all<{
        id: string;
        connection_id: string;
        direction: Transfer['direction'];
        state: Transfer['state'];
        bytes_transferred: number;
        total_bytes: number | null;
        bytes_per_second: number | null;
        error_code: string | null;
        source: string;
        destination: string;
        created_at: string;
        updated_at: string;
      }>(
        'SELECT id, connection_id, direction, state, source, destination, bytes_transferred, total_bytes, bytes_per_second, error_code, created_at, updated_at FROM transfer_history ORDER BY updated_at DESC LIMIT 500',
      )
      .map((row) => ({
        id: row.id,
        connectionId: row.connection_id,
        direction: row.direction,
        state: row.state,
        bytesTransferred: row.bytes_transferred,
        ...(row.total_bytes === null ? {} : { totalBytes: row.total_bytes }),
        ...(row.bytes_per_second === null ? {} : { bytesPerSecond: row.bytes_per_second }),
        ...(row.error_code === null ? {} : { errorCode: row.error_code }),
        source: row.source,
        destination: row.destination,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  getTransfer(id: string): Transfer {
    const transfer = this.listTransfers().find((item) => item.id === id);
    if (!transfer) throw new ApplicationError('NOT_FOUND', 'Transfer not found', 404);
    return transfer;
  }

  clearCompletedTransfers(): number {
    return this.database.transaction(() => {
      const result = this.database.run(
        "DELETE FROM transfer_history WHERE state IN ('succeeded','failed','canceled')",
      );
      const cleared = Number(result.changes);
      this.database.appendEvent('transfer.history-cleared', 'transfers', { cleared });
      return cleared;
    });
  }

  listAiConversations(): AiConversation[] {
    return this.listJson<Omit<AiConversation, 'messageCount' | 'lastMessageAt'>>('ai_conversations')
      .map((conversation) => this.withConversationStats(conversation))
      .sort((left, right) =>
        (right.lastMessageAt ?? right.updatedAt).localeCompare(
          left.lastMessageAt ?? left.updatedAt,
        ),
      );
  }

  getAiConversation(id: string): AiConversation {
    return this.withConversationStats(
      this.getJson<Omit<AiConversation, 'messageCount' | 'lastMessageAt'>>('ai_conversations', id),
    );
  }

  createAiConversation(input: AiConversationInput): AiConversation {
    const created = this.createJson('ai_conversations', input, 'ai-conversation');
    return this.getAiConversation(created.id);
  }

  updateAiConversation(
    id: string,
    input: AiConversationPatch,
    ifMatch: string | undefined,
  ): AiConversation {
    this.updateJson('ai_conversations', id, input, ifMatch, 'ai-conversation');
    return this.getAiConversation(id);
  }

  deleteAiConversation(id: string, ifMatch: string | undefined): void {
    const current = this.getAiConversation(id);
    if (current.version !== versionFromEtag(ifMatch))
      throw new ApplicationError('PRECONDITION_FAILED', 'Resource changed', 412);
    this.database.transaction(() => {
      this.database.run('DELETE FROM ai_messages WHERE conversation_id=?', id);
      this.database.run('UPDATE ai_runs SET conversation_id=NULL WHERE conversation_id=?', id);
      const result = this.database.run(
        'DELETE FROM ai_conversations WHERE id=? AND version=?',
        id,
        current.version,
      );
      if (!result.changes)
        throw new ApplicationError('PRECONDITION_FAILED', 'Resource changed', 412);
      this.database.appendEvent('ai-conversation.deleted', id, { id });
    });
  }

  listAiMessages(conversationId: string): AiMessage[] {
    this.getJson('ai_conversations', conversationId);
    return this.database
      .all<{
        id: string;
        conversation_id: string;
        run_id: string;
        role: AiMessage['role'];
        content: string;
        state: AiMessage['state'];
        error_code: string | null;
        attachments_json: string;
        created_at: string;
        updated_at: string;
        version: number;
      }>(
        `SELECT id, conversation_id, run_id, role, content, state, error_code, attachments_json,
                created_at, updated_at, version
           FROM ai_messages
          WHERE conversation_id=? AND run_id IS NOT NULL
          ORDER BY created_at, CASE role WHEN 'user' THEN 0 ELSE 1 END, id
          LIMIT 1000`,
        conversationId,
      )
      .map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        runId: row.run_id,
        role: row.role,
        content: row.content,
        attachments: aiAttachmentMetadataSchema
          .array()
          .max(8)
          .parse(JSON.parse(row.attachments_json)),
        state: row.state,
        ...(row.error_code ? { errorCode: row.error_code } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: row.version,
      }));
  }

  createAiRun(input: {
    useCase: AiRun['useCase'];
    request: unknown;
    conversation?:
      { id: string; prompt: string; attachments?: AiAttachmentMetadata[] | undefined } | undefined;
  }): AiRun {
    const now = new Date().toISOString();
    const run: AiRun = {
      id: randomUUID(),
      ...(input.conversation ? { conversationId: input.conversation.id } : {}),
      state: 'queued',
      useCase: input.useCase,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    if (input.conversation) this.getAiConversation(input.conversation.id);
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO ai_runs(
           id, conversation_id, state, use_case, request, created_at, updated_at, version
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        run.id,
        run.conversationId ?? null,
        run.state,
        run.useCase,
        JSON.stringify(input.request),
        now,
        now,
      );
      if (input.conversation) {
        this.database.run(
          `INSERT INTO ai_messages(
             id, conversation_id, run_id, role, content, attachments_json, state,
             created_at, updated_at, version
           ) VALUES (?, ?, ?, 'user', ?, ?, 'complete', ?, ?, 1)`,
          randomUUID(),
          input.conversation.id,
          run.id,
          input.conversation.prompt,
          JSON.stringify(input.conversation.attachments ?? []),
          now,
          now,
        );
        this.database.run(
          'UPDATE ai_conversations SET updated_at=?, version=version+1 WHERE id=?',
          now,
          input.conversation.id,
        );
      }
      this.database.appendEvent('ai-run.created', run.id, run);
    });
    return run;
  }

  updateAiRun(id: string, state: AiRun['state'], result?: string, errorCode?: string): AiRun {
    const current = this.getAiRun(id);
    const updatedAt = new Date().toISOString();
    const next: AiRun = {
      ...current,
      state,
      updatedAt,
      version: current.version + 1,
      ...(result === undefined ? {} : { result }),
      ...(errorCode ? { errorCode } : {}),
    };
    this.database.transaction(() => {
      this.database.run(
        'UPDATE ai_runs SET state=?, result=?, error_code=?, updated_at=?, version=? WHERE id=?',
        state,
        result ?? null,
        errorCode ?? null,
        updatedAt,
        next.version,
        id,
      );
      if (current.conversationId && ['succeeded', 'failed', 'canceled'].includes(state)) {
        const messageState: AiMessage['state'] =
          state === 'succeeded' ? 'complete' : state === 'failed' ? 'failed' : 'canceled';
        const previous = this.database.get<{ id: string; version: number }>(
          "SELECT id, version FROM ai_messages WHERE run_id=? AND role='assistant'",
          id,
        );
        if (previous)
          this.database.run(
            `UPDATE ai_messages
                SET content=?, state=?, error_code=?, updated_at=?, version=?
              WHERE id=? AND version=?`,
            result ?? '',
            messageState,
            errorCode ?? null,
            updatedAt,
            previous.version + 1,
            previous.id,
            previous.version,
          );
        else
          this.database.run(
            `INSERT INTO ai_messages(
               id, conversation_id, run_id, role, content, state, error_code,
               created_at, updated_at, version
             ) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, 1)`,
            randomUUID(),
            current.conversationId,
            id,
            result ?? '',
            messageState,
            errorCode ?? null,
            updatedAt,
            updatedAt,
          );
        this.database.run(
          'UPDATE ai_conversations SET updated_at=?, version=version+1 WHERE id=?',
          updatedAt,
          current.conversationId,
        );
      }
      this.database.appendEvent('ai-run.updated', id, next);
    });
    return next;
  }

  listAiRuns(): AiRun[] {
    return this.database
      .all<{
        id: string;
        conversation_id: string | null;
        state: AiRun['state'];
        use_case: AiRun['useCase'];
        result: string | null;
        error_code: string | null;
        created_at: string;
        updated_at: string;
        version: number;
      }>(
        `SELECT id, conversation_id, state, use_case, result, error_code,
                created_at, updated_at, version
           FROM ai_runs ORDER BY created_at DESC LIMIT 200`,
      )
      .map((row) => ({
        id: row.id,
        ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
        state: row.state,
        useCase: row.use_case,
        ...(row.result === null ? {} : { result: row.result }),
        ...(row.error_code === null ? {} : { errorCode: row.error_code }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: row.version,
      }));
  }
  getAiRun(id: string): AiRun {
    const row = this.database.get<{
      id: string;
      conversation_id: string | null;
      state: AiRun['state'];
      use_case: AiRun['useCase'];
      result: string | null;
      error_code: string | null;
      created_at: string;
      updated_at: string;
      version: number;
    }>(
      `SELECT id, conversation_id, state, use_case, result, error_code,
              created_at, updated_at, version
         FROM ai_runs WHERE id=?`,
      id,
    );
    if (!row) throw new ApplicationError('NOT_FOUND', 'AI run not found', 404);
    return {
      id: row.id,
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
      state: row.state,
      useCase: row.use_case,
      ...(row.result === null ? {} : { result: row.result }),
      ...(row.error_code === null ? {} : { errorCode: row.error_code }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
    };
  }

  createToolCall(input: {
    runId: string;
    toolName: string;
    risk: AiToolCall['risk'];
    argsHash: string;
    args: Record<string, unknown>;
    target: string;
    state: AiToolCall['state'];
  }): AiToolCall {
    const now = new Date().toISOString();
    const call: AiToolCall = {
      id: randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.database.run(
      'INSERT INTO ai_tool_calls(id, run_id, tool_name, risk, args_hash, args_json, target, state, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
      call.id,
      call.runId,
      call.toolName,
      call.risk,
      call.argsHash,
      JSON.stringify(call.args),
      call.target,
      call.state,
      now,
      now,
    );
    return call;
  }
  updateToolCall(
    id: string,
    state: AiToolCall['state'],
    resultMetadata?: Record<string, unknown>,
  ): AiToolCall {
    const current = this.getToolCall(id);
    const next = {
      ...current,
      state,
      updatedAt: new Date().toISOString(),
      version: current.version + 1,
      ...(resultMetadata ? { resultMetadata } : {}),
    };
    this.database.run(
      'UPDATE ai_tool_calls SET state=?, result_metadata=?, updated_at=?, version=? WHERE id=?',
      state,
      resultMetadata ? JSON.stringify(resultMetadata) : null,
      next.updatedAt,
      next.version,
      id,
    );
    return next;
  }
  listToolCalls(runId?: string): AiToolCall[] {
    const rows = this.database.all<{
      id: string;
      run_id: string;
      tool_name: string;
      risk: AiToolCall['risk'];
      args_hash: string;
      args_json: string;
      target: string;
      state: AiToolCall['state'];
      result_metadata: string | null;
      created_at: string;
      updated_at: string;
      version: number;
    }>(
      `SELECT * FROM ai_tool_calls ${runId ? 'WHERE run_id=?' : ''} ORDER BY created_at`,
      ...(runId ? [runId] : []),
    );
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      toolName: row.tool_name,
      risk: row.risk,
      argsHash: row.args_hash,
      args: JSON.parse(row.args_json),
      target: row.target,
      state: row.state,
      ...(row.result_metadata ? { resultMetadata: JSON.parse(row.result_metadata) } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
    }));
  }
  getToolCall(id: string): AiToolCall {
    const call = this.listToolCalls().find((item) => item.id === id);
    if (!call) throw new ApplicationError('NOT_FOUND', 'AI tool call not found', 404);
    return call;
  }
  createApproval(input: {
    runId: string;
    toolCallId: string;
    argsHash: string;
    target: string;
    expiresAt: string;
  }): AiApproval {
    const now = new Date().toISOString();
    const approval: AiApproval = {
      id: randomUUID(),
      ...input,
      state: 'pending',
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.database.run(
      'INSERT INTO ai_approvals(id, run_id, tool_call_id, args_hash, target, state, expires_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
      approval.id,
      approval.runId,
      approval.toolCallId,
      approval.argsHash,
      approval.target,
      approval.state,
      approval.expiresAt,
      now,
      now,
    );
    return approval;
  }
  listApprovals(): AiApproval[] {
    return this.database
      .all<{
        id: string;
        run_id: string;
        tool_call_id: string;
        args_hash: string;
        target: string;
        state: AiApproval['state'];
        expires_at: string;
        decided_at: string | null;
        created_at: string;
        updated_at: string;
        version: number;
      }>('SELECT * FROM ai_approvals ORDER BY created_at DESC LIMIT 200')
      .map((row) => ({
        id: row.id,
        runId: row.run_id,
        toolCallId: row.tool_call_id,
        argsHash: row.args_hash,
        target: row.target,
        state: row.state,
        expiresAt: row.expires_at,
        ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        version: row.version,
      }));
  }
  getApproval(id: string): AiApproval {
    const approval = this.listApprovals().find((item) => item.id === id);
    if (!approval) throw new ApplicationError('NOT_FOUND', 'AI approval not found', 404);
    return approval;
  }

  recoverInterruptedWork(): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.run(
        "UPDATE transfer_history SET state='failed', error_code='RUNTIME_INTERRUPTED', updated_at=?, version=version+1 WHERE state IN ('queued','preparing','running')",
        now,
      );
      this.database.run(
        "UPDATE ai_runs SET state='failed', error_code='RUNTIME_INTERRUPTED', updated_at=?, version=version+1 WHERE state IN ('queued','running','waiting_approval')",
        now,
      );
      this.database.run(
        "UPDATE ai_approvals SET state='expired', decided_at=?, updated_at=?, version=version+1 WHERE state='pending'",
        now,
        now,
      );
      this.database.run(
        `UPDATE ai_tool_calls
            SET state='failed', result_metadata='{"code":"RUNTIME_INTERRUPTED"}', updated_at=?, version=version+1
          WHERE state IN ('proposed','waiting_approval','running')`,
        now,
      );
    });
  }
  decideApproval(id: string, state: 'approved' | 'rejected' | 'expired'): AiApproval {
    const current = this.getApproval(id);
    const now = new Date().toISOString();
    const next = {
      ...current,
      state,
      decidedAt: now,
      updatedAt: now,
      version: current.version + 1,
    };
    this.database.run(
      'UPDATE ai_approvals SET state=?, decided_at=?, updated_at=?, version=? WHERE id=?',
      state,
      now,
      now,
      next.version,
      id,
    );
    return next;
  }

  getKnownHostKey(host: string, port: number): KnownHostKey | undefined {
    const row = this.database.get<KnownHostKeyRow>(
      `SELECT id, host, port, algorithm, fingerprint, public_key, first_seen_at, last_seen_at,
        created_at, updated_at, version FROM known_host_keys WHERE host=? AND port=?`,
      host,
      port,
    );
    return row ? knownHostKeyFromRow(row) : undefined;
  }

  listKnownHostKeys(): KnownHostKey[] {
    return this.database
      .all<KnownHostKeyRow>(
        `SELECT id, host, port, algorithm, fingerprint, public_key, first_seen_at, last_seen_at,
          created_at, updated_at, version FROM known_host_keys ORDER BY host COLLATE NOCASE, port`,
      )
      .map(knownHostKeyFromRow);
  }

  saveKnownHostKey(
    input: Omit<
      KnownHostKey,
      'id' | 'firstSeenAt' | 'lastSeenAt' | 'createdAt' | 'updatedAt' | 'version'
    >,
  ): KnownHostKey {
    const existing = this.getKnownHostKey(input.host, input.port);
    const now = new Date().toISOString();
    const entity: KnownHostKey = {
      id: existing?.id ?? randomUUID(),
      ...input,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
    };
    this.database.transaction(() => {
      this.database.run(
        `INSERT INTO known_host_keys(id, host, port, algorithm, fingerprint, public_key,
          first_seen_at, last_seen_at, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(host, port) DO UPDATE SET algorithm=excluded.algorithm,
          fingerprint=excluded.fingerprint, public_key=excluded.public_key,
          last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at,
          version=known_host_keys.version+1`,
        entity.id,
        entity.host,
        entity.port,
        entity.algorithm,
        entity.fingerprint,
        entity.publicKey,
        entity.firstSeenAt,
        entity.lastSeenAt,
        now,
        now,
      );
      this.database.appendEvent(
        existing ? 'known-host-key.changed' : 'known-host-key.accepted',
        entity.id,
        {
          host: entity.host,
          port: entity.port,
          algorithm: entity.algorithm,
          fingerprint: entity.fingerprint,
        },
      );
    });
    return entity;
  }

  deleteKnownHostKey(id: string, ifMatch: string | undefined): void {
    const version = versionFromEtag(ifMatch);
    this.database.transaction(() => {
      const row = this.database.get<KnownHostKeyRow>(
        `SELECT id, host, port, algorithm, fingerprint, public_key, first_seen_at, last_seen_at,
          created_at, updated_at, version FROM known_host_keys WHERE id=?`,
        id,
      );
      if (!row) throw new ApplicationError('NOT_FOUND', 'Known Host Key not found', 404);
      if (row.version !== version)
        throw new ApplicationError('PRECONDITION_FAILED', 'Known Host Key changed', 412);
      const result = this.database.run(
        'DELETE FROM known_host_keys WHERE id=? AND version=?',
        id,
        version,
      );
      if (!result.changes)
        throw new ApplicationError('PRECONDITION_FAILED', 'Known Host Key changed', 412);
      this.database.appendEvent('known-host-key.revoked', id, {
        host: row.host,
        port: row.port,
        algorithm: row.algorithm,
        fingerprint: row.fingerprint,
      });
    });
  }

  listJson<T>(table: JsonTable): T[] {
    return this.database
      .all<JsonRow>(`SELECT * FROM ${table} ORDER BY name`)
      .map((row) => this.jsonFromRow<T>(row));
  }

  getJson<T>(table: JsonTable, id: string): T {
    const row = this.database.get<JsonRow>(`SELECT * FROM ${table} WHERE id = ?`, id);
    if (!row) throw new ApplicationError('NOT_FOUND', 'Resource not found', 404);
    return this.jsonFromRow<T>(row);
  }

  createJson<T extends { name: string }>(
    table: JsonTable,
    input: T,
    eventType: string,
  ): T & { id: string; createdAt: string; updatedAt: string; version: number } {
    const now = new Date().toISOString();
    const entity = { id: randomUUID(), ...input, createdAt: now, updatedAt: now, version: 1 };
    this.database.transaction(() => {
      this.database.run(
        'INSERT INTO ' +
          table +
          '(id, name, payload, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)',
        entity.id,
        input.name,
        JSON.stringify(input),
        now,
        now,
      );
      this.database.appendEvent(`${eventType}.created`, entity.id, entity);
    });
    return entity;
  }

  updateJson<T extends { name: string }>(
    table: JsonTable,
    id: string,
    input: { [K in keyof T]?: T[K] | undefined },
    ifMatch: string | undefined,
    eventType: string,
  ): T & { id: string; createdAt: string; updatedAt: string; version: number } {
    const current = this.getJson<
      T & { id: string; createdAt: string; updatedAt: string; version: number }
    >(table, id);
    if (current.version !== versionFromEtag(ifMatch))
      throw new ApplicationError('PRECONDITION_FAILED', 'Resource changed', 412);
    const next = {
      ...current,
      ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
      id,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    } as T & { id: string; createdAt: string; updatedAt: string; version: number };
    const payload = { ...next };
    delete (payload as Partial<typeof next>).id;
    delete (payload as Partial<typeof next>).createdAt;
    delete (payload as Partial<typeof next>).updatedAt;
    delete (payload as Partial<typeof next>).version;
    this.database.transaction(() => {
      const result = this.database.run(
        `UPDATE ${table} SET name=?, payload=?, updated_at=?, version=? WHERE id=? AND version=?`,
        next.name,
        JSON.stringify(payload),
        next.updatedAt,
        next.version,
        id,
        current.version,
      );
      if (!result.changes)
        throw new ApplicationError('PRECONDITION_FAILED', 'Resource changed', 412);
      this.database.appendEvent(`${eventType}.updated`, id, next);
    });
    return next;
  }

  deleteJson(table: JsonTable, id: string, ifMatch: string | undefined, eventType: string): void {
    const current = this.getJson<{ id: string; version: number }>(table, id);
    if (current.version !== versionFromEtag(ifMatch))
      throw new ApplicationError('PRECONDITION_FAILED', 'Resource changed', 412);
    this.database.transaction(() => {
      this.database.run(`DELETE FROM ${table} WHERE id=? AND version=?`, id, current.version);
      this.database.appendEvent(`${eventType}.deleted`, id, { id });
    });
  }

  replaceJsonCollection<
    T extends {
      id: string;
      name: string;
      createdAt: string;
      updatedAt: string;
      version: number;
    },
  >(table: JsonTable, values: readonly T[], eventType: string): void {
    this.database.transaction(() => {
      this.database.run(`DELETE FROM ${table}`);
      for (const value of values) {
        const payload = { ...value } as Record<string, unknown>;
        delete payload.id;
        delete payload.createdAt;
        delete payload.updatedAt;
        delete payload.version;
        this.database.run(
          `INSERT INTO ${table}(id, name, payload, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, ?)`,
          value.id,
          value.name,
          JSON.stringify(payload),
          value.createdAt,
          value.updatedAt,
          value.version,
        );
      }
      this.database.appendEvent(`${eventType}.replaced`, eventType, { count: values.length });
    });
  }

  recordIdempotency(
    key: string,
    operation: string,
    request: unknown,
    response: unknown,
    retentionLimit = DEFAULT_IDEMPOTENCY_RECEIPT_LIMIT,
  ): void {
    if (!Number.isSafeInteger(retentionLimit) || retentionLimit < 1)
      throw new Error('Idempotency retention limit must be a positive integer');
    this.database.run(
      'INSERT INTO idempotency_records(key, operation, request_hash, response, created_at) VALUES (?, ?, ?, ?, ?)',
      key,
      operation,
      stableHash(request),
      JSON.stringify(response),
      new Date().toISOString(),
    );
    this.database.run(
      `DELETE FROM idempotency_records
        WHERE key IN (
          SELECT key FROM idempotency_records
           WHERE operation=?
           ORDER BY created_at DESC, key DESC
           LIMIT -1 OFFSET ?
        )`,
      operation,
      retentionLimit,
    );
  }

  deleteIdempotencyByOperationPrefix(prefix: string): void {
    this.database.run(
      "DELETE FROM idempotency_records WHERE operation LIKE ? ESCAPE '\\'",
      `${escapeLike(prefix)}%`,
    );
  }

  resolveIdempotency<T>(key: string, operation: string, request: unknown): T | undefined {
    const row = this.database.get<{ operation: string; request_hash: string; response: string }>(
      'SELECT operation, request_hash, response FROM idempotency_records WHERE key=?',
      key,
    );
    if (!row) return undefined;
    if (row.operation !== operation || row.request_hash !== stableHash(request))
      throw new ApplicationError(
        'CONFLICT',
        'Idempotency key was reused with different input',
        409,
      );
    return JSON.parse(row.response) as T;
  }

  private withConversationStats(
    conversation: Omit<AiConversation, 'messageCount' | 'lastMessageAt'>,
  ): AiConversation {
    const stats = this.database.get<{ message_count: number; last_message_at: string | null }>(
      `SELECT COUNT(*) AS message_count, MAX(created_at) AS last_message_at
         FROM ai_messages WHERE conversation_id=?`,
      conversation.id,
    );
    return {
      ...conversation,
      messageCount: Number(stats?.message_count ?? 0),
      lastMessageAt: stats?.last_message_at ?? null,
    };
  }

  private jsonFromRow<T>(row: JsonRow): T {
    return {
      id: row.id,
      ...JSON.parse(row.payload),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      version: row.version,
    } as T;
  }
}

export type JsonTable =
  | 'terminal_profiles'
  | 'terminal_themes'
  | 'quick_commands'
  | 'tunnel_profiles'
  | 'ai_providers'
  | 'ai_models'
  | 'ai_conversations';
export const stableHash = (value: unknown) =>
  createHash('sha256').update(stableJson(value)).digest('hex');
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function throwConstraint(error: unknown, message: string): never {
  if (error instanceof Error && /constraint|unique/i.test(error.message))
    throw new ApplicationError('CONFLICT', message, 409);
  throw error;
}

export type { AiRun, TerminalProfile, TunnelProfile };
