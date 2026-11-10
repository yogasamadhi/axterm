import { randomUUID } from 'node:crypto';
import { DomainCommands } from '@axterm/infra-storage-domain';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import {
  tunnelProfileSchema,
  tunnelProfileInputSchema,
  type TunnelProfile,
  type TunnelProfileInput,
  type TunnelProfilePatch,
  type ConnectionFactReceipt,
} from '@axterm/plugin-api/connections';
import { ApplicationError } from '../application/errors.ts';
import type { TunnelProfiles } from '../ports/tunnels.ts';
interface Row {
  id: string;
  name: string;
  payload: string;
  created_at: string;
  updated_at: string;
  version: number;
}
/** Owns the existing relational rows; facts, optimistic writes and receipts commit together. */
export class OwnedTunnelProfiles implements TunnelProfiles {
  private readonly commands: DomainCommands;
  constructor(
    private readonly domain: RelationalDomain,
    private readonly requireHost: (id: string) => unknown,
    private readonly together: <T>(operation: () => T) => T = (operation) => operation(),
  ) {
    this.commands = new DomainCommands(domain, 'axterm_connection_command_receipts');
  }
  list(): TunnelProfile[] {
    const budget = this.domain.get<{ count: number; bytes: number; recordBytes: number }>(
      'SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(payload AS BLOB))+length(CAST(name AS BLOB))),0) AS bytes, COALESCE(MAX(length(CAST(payload AS BLOB))+length(CAST(name AS BLOB))),0) AS recordBytes FROM tunnel_profiles',
    )!;
    if (budget.count > 10000 || budget.bytes > 32 * 1024 * 1024 || budget.recordBytes > 256 * 1024)
      throw new ApplicationError(
        'CAPACITY_EXCEEDED',
        'Tunnel profile snapshot capacity exceeded',
        503,
      );
    const rows = this.domain.all<Row>('SELECT * FROM tunnel_profiles ORDER BY name,id LIMIT 10001');
    if (rows.length > 10000)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'Tunnel profile capacity exceeded', 503);
    return rows.map(decode);
  }
  get(id: string): TunnelProfile {
    const size = this.domain.get<{ bytes: number }>(
      'SELECT length(CAST(payload AS BLOB))+length(CAST(name AS BLOB)) AS bytes FROM tunnel_profiles WHERE id=?',
      id,
    );
    if (size && size.bytes > 256 * 1024)
      throw new ApplicationError(
        'CAPACITY_EXCEEDED',
        'Tunnel profile record capacity exceeded',
        503,
      );
    const row = this.domain.get<Row>('SELECT * FROM tunnel_profiles WHERE id=?', id);
    if (!row) throw new ApplicationError('NOT_FOUND', 'Tunnel profile not found', 404);
    return decode(row);
  }
  create(key: string, input: TunnelProfileInput): ConnectionFactReceipt {
    const normalized = tunnelProfileInputSchema.parse(input);
    return this.together(() =>
      this.commands.execute(key, 'createTunnelProfile', normalized, () => {
        this.requireHost(normalized.hostId);
        if (
          this.domain.get<{ count: number }>('SELECT COUNT(*) AS count FROM tunnel_profiles')!
            .count >= 10000
        )
          throw new ApplicationError('CAPACITY_EXCEEDED', 'Tunnel profile capacity exceeded', 503);
        this.checkBytes(normalized);
        const id = randomUUID();
        const now = new Date().toISOString();
        this.domain.run(
          'INSERT INTO tunnel_profiles(id,name,payload,created_at,updated_at,version) VALUES(?,?,?,?,?,1)',
          id,
          normalized.name,
          JSON.stringify(normalized),
          now,
          now,
        );
        this.domain.appendEvent('tunnel-profile.created', { id });
        return { ids: [id], cursor: this.domain.cursor(), version: 1 };
      }),
    );
  }
  update(
    key: string,
    id: string,
    patch: TunnelProfilePatch,
    ifMatch: string | undefined,
  ): ConnectionFactReceipt {
    return this.together(() =>
      this.commands.execute(key, 'updateTunnelProfile', { id, patch, ifMatch }, () => {
        const current = this.get(id);
        checkVersion(current, ifMatch);
        if (current.version >= Number.MAX_SAFE_INTEGER)
          throw new ApplicationError(
            'CAPACITY_EXCEEDED',
            'Tunnel profile version capacity exceeded',
            503,
          );
        const {
          id: _id,
          createdAt: _created,
          updatedAt: _updated,
          version: _version,
          ...fields
        } = current;
        const next = tunnelProfileInputSchema.parse({ ...fields, ...patch });
        this.requireHost(next.hostId);
        this.checkBytes(next, id);
        const result = this.domain.run(
          'UPDATE tunnel_profiles SET name=?,payload=?,updated_at=?,version=version+1 WHERE id=? AND version=?',
          next.name,
          JSON.stringify(next),
          new Date().toISOString(),
          id,
          current.version,
        );
        if (!result.changes)
          throw new ApplicationError('PRECONDITION_FAILED', 'Tunnel profile changed', 412);
        this.domain.appendEvent('tunnel-profile.updated', { id });
        return { ids: [id], cursor: this.domain.cursor(), version: current.version + 1 };
      }),
    );
  }
  private checkBytes(value: TunnelProfileInput, replacing?: string): void {
    const current = this.domain.get<{ bytes: number }>(
      'SELECT COALESCE(SUM(length(CAST(payload AS BLOB))+length(CAST(name AS BLOB))),0) AS bytes FROM tunnel_profiles WHERE id<>?',
      replacing ?? '',
    )!.bytes;
    const bytes = Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(value.name);
    if (bytes > 256 * 1024 || current + bytes > 32 * 1024 * 1024)
      throw new ApplicationError(
        'CAPACITY_EXCEEDED',
        'Tunnel profile storage capacity exceeded',
        503,
      );
  }
  remove(key: string, id: string, ifMatch: string | undefined): ConnectionFactReceipt {
    return this.commands.execute(key, 'deleteTunnelProfile', { id, ifMatch }, () => {
      const current = this.get(id);
      checkVersion(current, ifMatch);
      const result = this.domain.run(
        'DELETE FROM tunnel_profiles WHERE id=? AND version=?',
        id,
        current.version,
      );
      if (!result.changes)
        throw new ApplicationError('PRECONDITION_FAILED', 'Tunnel profile changed', 412);
      this.domain.appendEvent('tunnel-profile.deleted', { id });
      return { ids: [id], cursor: this.domain.cursor() };
    });
  }
}
function decode(row: Row): TunnelProfile {
  return tunnelProfileSchema.parse({
    ...JSON.parse(row.payload),
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}
function checkVersion(value: TunnelProfile, ifMatch: string | undefined): void {
  if (!ifMatch) throw new ApplicationError('PRECONDITION_REQUIRED', 'If-Match is required', 428);
  if (ifMatch !== `"v${value.version}"`)
    throw new ApplicationError('PRECONDITION_FAILED', 'Tunnel profile changed', 412);
}
