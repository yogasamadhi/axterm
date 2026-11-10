import { DomainCommands } from '@axterm/infra-storage-domain';
import type { ConnectionFactReceipt } from '@axterm/plugin-api/connections';
import { randomUUID } from 'node:crypto';
import { knownHostKeySchema, type KnownHostKey } from '@axterm/plugin-api/connections';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import { ApplicationError } from '../application/errors.ts';
interface Row {
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
const fromRow = (row: Row): KnownHostKey =>
  knownHostKeySchema.parse({
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
/** Known-host writes stay in Connections; Catalog only receives a selected reference projection. */
export class KnownHosts {
  private readonly commands: DomainCommands;
  constructor(private readonly domain: RelationalDomain) {
    this.commands = new DomainCommands(domain, 'axterm_connection_command_receipts');
  }
  remove(key: string, id: string, ifMatch: string | undefined): ConnectionFactReceipt {
    return this.commands.execute(key, 'deleteKnownHostKey', { id, ifMatch }, () => {
      const row = this.domain.get<Row>('SELECT * FROM known_host_keys WHERE id=?', id);
      if (!row) throw new ApplicationError('NOT_FOUND', 'Known host not found', 404);
      if (ifMatch === undefined)
        throw new ApplicationError('PRECONDITION_REQUIRED', 'Known host version required', 428);
      if (ifMatch !== '"v' + row.version + '"')
        throw new ApplicationError('PRECONDITION_FAILED', 'Known host changed', 412);
      this.domain.run('DELETE FROM known_host_keys WHERE id=?', id);
      this.domain.appendEvent('known-host-key.revoked', { entityId: id });
      return { ids: [id], cursor: this.domain.cursor() };
    });
  }
  get(host: string, port: number): KnownHostKey | undefined {
    const row = this.domain.get<Row>(
      'SELECT * FROM known_host_keys WHERE host=? AND port=?',
      host,
      port,
    );
    return row ? fromRow(row) : undefined;
  }
  list(): KnownHostKey[] {
    return this.domain
      .all<Row>('SELECT * FROM known_host_keys ORDER BY host COLLATE NOCASE,port')
      .map(fromRow);
  }
  save(
    input: Omit<
      KnownHostKey,
      'id' | 'firstSeenAt' | 'lastSeenAt' | 'createdAt' | 'updatedAt' | 'version'
    >,
    expected?: { readonly version: number } | null,
  ): KnownHostKey {
    return this.domain.transaction(() => {
      const existing = this.get(input.host, input.port);
      if (existing?.publicKey === input.publicKey) return existing;
      if (
        expected === null
          ? !!existing
          : expected !== undefined && existing?.version !== expected.version
      )
        throw new ApplicationError(
          'PRECONDITION_FAILED',
          'Known host changed during confirmation',
          412,
        );
      const now = new Date().toISOString();
      const next: KnownHostKey = knownHostKeySchema.parse({
        ...input,
        id: existing?.id ?? randomUUID(),
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastSeenAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        version: (existing?.version ?? 0) + 1,
      });
      this.domain.run(
        `INSERT INTO known_host_keys(id,host,port,algorithm,fingerprint,public_key,first_seen_at,last_seen_at,created_at,updated_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(host,port) DO UPDATE SET algorithm=excluded.algorithm,fingerprint=excluded.fingerprint,public_key=excluded.public_key,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at,version=excluded.version`,
        next.id,
        next.host,
        next.port,
        next.algorithm,
        next.fingerprint,
        next.publicKey,
        next.firstSeenAt,
        next.lastSeenAt,
        next.createdAt,
        next.updatedAt,
        next.version,
      );
      this.domain.appendEvent(existing ? 'known-host-key.changed' : 'known-host-key.accepted', {
        entityId: next.id,
        payload: {
          host: next.host,
          port: next.port,
          algorithm: next.algorithm,
          fingerprint: next.fingerprint,
        },
      });
      return next;
    });
  }
  retainedBy(hostId: string): readonly 'tunnel'[] {
    return this.domain.get(
      "SELECT id FROM tunnel_profiles WHERE json_extract(payload,'$.hostId')=? LIMIT 1",
      hostId,
    )
      ? ['tunnel']
      : [];
  }
}
