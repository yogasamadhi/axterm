import { randomUUID } from 'node:crypto';
import {
  createHostSchema,
  hostProxySchema,
  idSchema,
  sshAgentSchema,
  sshAlgorithmsSchema,
  sshStartupSchema,
  sshX11Schema,
  updateHostSchema,
  type Host,
  type HostGroup,
  type HostProxyConfig,
  type CreateHostInput,
  type UpdateHostInput,
} from '@axterm/plugin-api/catalog';
import { ApplicationError } from '../application/errors.ts';
import type { CatalogSql } from '../ports/catalog-sql.ts';
import { ConnectionHistoryRepository } from './connection-history-repository.ts';
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

export const etagFor = (version: number) => `"v${version}"`;

const versionFromEtag = (value: string | undefined): number => {
  if (!value) throw new ApplicationError('PRECONDITION_REQUIRED', 'If-Match is required', 428);
  const match = /^"v(\d+)"$/.exec(value);
  if (!match) throw new ApplicationError('PRECONDITION_FAILED', 'Invalid entity version', 412);
  return Number(match[1]);
};

function throwConstraint(
  error: unknown,
  message: string,
  nameConflictCode?: 'HOST_NAME_CONFLICT',
): never {
  if (
    nameConflictCode &&
    error instanceof Error &&
    /unique constraint failed: hosts\.name\b/iu.test(error.message)
  )
    throw new ApplicationError(nameConflictCode, message, 409);
  if (error instanceof Error && /constraint|unique/i.test(error.message))
    throw new ApplicationError('CONFLICT', message, 409);
  throw error;
}
export class HostRepository {
  constructor(
    private readonly database: CatalogSql,
    private readonly externalRetention: (id: string) => readonly 'tunnel'[],
  ) {}
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
      this.database
        .all<{ jump_host_ids: string }>('SELECT jump_host_ids FROM hosts')
        .some((row) => idSchema.array().max(8).parse(JSON.parse(row.jump_host_ids)).includes(id))
    )
      reasons.push('jumpHost');
    if (
      this.database.get(
        // A primary historical target has its own secret-free snapshot. Only an
        // actual historical jump dependency retains the saved Host (ADR-031).
        'SELECT id FROM recent_connections WHERE jump_host_id = ? LIMIT 1',
        id,
      )
    )
      reasons.push('history');
    reasons.push(...this.externalRetention(id));
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
      throwConstraint(error, 'A host with this name already exists', 'HOST_NAME_CONFLICT');
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
      throwConstraint(error, 'A host with this name already exists', 'HOST_NAME_CONFLICT');
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
      new ConnectionHistoryRepository(this.database).detachHost(id);
      this.database.run(
        'UPDATE hosts SET jump_host_id = NULL, version = version + 1 WHERE jump_host_id = ?',
        id,
      );
      for (const row of this.database.all<{ id: string; jump_host_ids: string }>(
        'SELECT id,jump_host_ids FROM hosts',
      )) {
        const jumps = idSchema.array().max(8).parse(JSON.parse(row.jump_host_ids));
        if (jumps.includes(id))
          this.database.run(
            'UPDATE hosts SET jump_host_ids=?,version=version+1 WHERE id=?',
            JSON.stringify(jumps.filter((jump) => jump !== id)),
            row.id,
          );
      }
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
}
