import { RemoteError } from '@axterm/plugin-api';
import {
  transferSchema,
  type Transfer,
  type TransferCommandOutcome,
  type TransfersFailureReason,
} from '@axterm/plugin-api/transfers';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import { commandPayloadHash } from '@axterm/infra-storage-domain';
import type { TransferRepository } from '../ports/repository.ts';
const failure = (reason: TransfersFailureReason) =>
  new RemoteError('transfers/failure', 'The transfer fact could not be updated', { reason });
interface FactRow {
  id: string;
  connection_id: string;
  direction: Transfer['direction'];
  state: Transfer['state'];
  source: string;
  destination: string;
  bytes_transferred: number;
  total_bytes: number | null;
  bytes_per_second: number | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}
const columns =
  'id,connection_id,direction,state,source,destination,bytes_transferred,total_bytes,bytes_per_second,error_code,created_at,updated_at';
const live = "('queued','preparing','running','paused','awaiting-decision')";
function decode(row: FactRow): Transfer {
  return transferSchema.parse({
    id: row.id,
    connectionId: row.connection_id,
    direction: row.direction,
    state: row.state,
    source: row.source,
    destination: row.destination,
    bytesTransferred: row.bytes_transferred,
    ...(row.total_bytes === null ? {} : { totalBytes: row.total_bytes }),
    ...(row.bytes_per_second === null ? {} : { bytesPerSecond: row.bytes_per_second }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
/** Only this owner writes transfer_history; old Profile work is interrupted without replay. */
export class OwnedTransferRepository implements TransferRepository {
  constructor(
    private readonly domain: RelationalDomain,
    private readonly profile: string,
    private readonly generation: string,
  ) {
    if (!profile.length || profile.length > 128 || !uuid(generation))
      throw failure('invalid-input');
    domain.transaction(() => {
      const previous = domain.all<{ id: string }>(
        `SELECT h.id FROM transfer_history h JOIN axterm_transfer_commands c ON c.transfer_id=h.id WHERE c.profile_name=? AND c.generation<>? AND h.state IN ${live} LIMIT 33`,
        profile,
        generation,
      );
      if (previous.length > 32) throw failure('capacity');
      for (const row of previous) {
        domain.run(
          "UPDATE transfer_history SET state='failed',error_code='RUNTIME_INTERRUPTED',updated_at=?,version=version+1 WHERE id=?",
          new Date().toISOString(),
          row.id,
        );
        domain.appendEvent('transfers/interrupted', { id: row.id });
      }
    });
  }
  commandOutcome(key: string): TransferCommandOutcome {
    key = this.key(key);
    const row = this.domain.get<{ transfer_id: string; expired: number }>(
      'SELECT transfer_id,expired FROM axterm_transfer_commands WHERE command_id=? AND profile_name=?',
      key,
      this.profile,
    );
    if (!row) return { status: 'missing' };
    if (row.expired) return { status: 'expired' };
    return { status: 'accepted', transfer: this.getTransfer(row.transfer_id) };
  }
  reserve(
    key: string,
    input: unknown,
    create: () => Transfer,
  ): { created: boolean; transfer: Transfer } {
    key = this.key(key);
    const hash = this.hash(input);
    return this.domain.transaction(() => {
      const existing = this.domain.get<{
        transfer_id: string;
        payload_hash: string;
        expired: number;
        profile_name: string;
      }>(
        'SELECT transfer_id,payload_hash,expired,profile_name FROM axterm_transfer_commands WHERE command_id=?',
        key,
      );
      if (existing) {
        if (existing.profile_name !== this.profile) throw failure('conflict');
        if (existing.payload_hash !== hash) throw failure('conflict');
        if (existing.expired) throw failure('receipt-expired');
        return { created: false, transfer: this.getTransfer(existing.transfer_id) };
      }
      const count = this.domain.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM axterm_transfer_commands',
      )!.count;
      if (count >= 1_000_000) throw failure('capacity');
      // The owner creates metadata synchronously; no network/FS operation runs in SQLite.
      const result = transferSchema.parse(create());
      this.domain.run(
        'INSERT INTO axterm_transfer_commands(command_id,transfer_id,payload_hash,profile_name,generation,expired,created_at) VALUES(?,?,?,?,?,0,?)',
        key,
        result.id,
        hash,
        this.profile,
        this.generation,
        result.createdAt,
      );
      this.saveTransfer({
        ...result,
        source: result.source ?? '',
        destination: result.destination ?? '',
      });
      return { created: true, transfer: result };
    });
  }
  saveTransfer(value: Transfer & { source: string; destination: string }): void {
    transferSchema.parse(value);
    this.domain.transaction(() => {
      const owner = this.domain.get<{ profile_name: string; generation: string }>(
        'SELECT profile_name,generation FROM axterm_transfer_commands WHERE transfer_id=?',
        value.id,
      );
      if (!owner || owner.profile_name !== this.profile || owner.generation !== this.generation)
        throw failure('conflict');
      this.domain.run(
        `INSERT INTO transfer_history(id,connection_id,direction,state,source,destination,bytes_transferred,total_bytes,bytes_per_second,error_code,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET state=excluded.state,source=excluded.source,destination=excluded.destination,bytes_transferred=excluded.bytes_transferred,total_bytes=excluded.total_bytes,bytes_per_second=excluded.bytes_per_second,error_code=excluded.error_code,updated_at=excluded.updated_at,version=transfer_history.version+1`,
        value.id,
        value.connectionId,
        value.direction,
        value.state,
        value.source,
        value.destination,
        value.bytesTransferred,
        value.totalBytes ?? null,
        value.bytesPerSecond ?? null,
        value.errorCode ?? null,
        value.createdAt,
        value.updatedAt,
      );
      this.domain.appendEvent('transfers/updated', { id: value.id });
    });
  }
  listTransfers(): Transfer[] {
    return this.domain
      .all<FactRow>(
        `SELECT ${columns} FROM transfer_history ORDER BY updated_at DESC,id DESC LIMIT 500`,
      )
      .map(decode);
  }
  getTransfer(id: string): Transfer {
    if (!uuid(id)) throw failure('invalid-input');
    const row = this.domain.get<FactRow>(`SELECT ${columns} FROM transfer_history WHERE id=?`, id);
    if (!row) throw failure('not-found');
    return decode(row);
  }
  hasMore(): boolean {
    return (
      this.domain.get<{ count: number }>('SELECT COUNT(*) AS count FROM transfer_history')!.count >
      500
    );
  }
  cursor(): number {
    return this.domain.cursor();
  }
  clearCompletedTransfers(): number {
    return this.domain.transaction(() => {
      // Keep command tombstones after clearing visible history; a stale nonce never
      // reauthorizes a network action or a file grant.
      this.domain.run(
        "UPDATE axterm_transfer_commands SET expired=1 WHERE transfer_id IN (SELECT id FROM transfer_history WHERE state IN ('succeeded','failed','canceled'))",
      );
      const result = this.domain.run(
        "DELETE FROM transfer_history WHERE state IN ('succeeded','failed','canceled')",
      );
      const count = Number(result.changes);
      if (count) this.domain.appendEvent('transfers/cleared', { count });
      return count;
    });
  }
  private key(value: string): string {
    if (!uuid(value)) throw failure('invalid-input');
    return value.toLowerCase();
  }
  private hash(input: unknown): string {
    try {
      return commandPayloadHash(input);
    } catch {
      throw failure('invalid-input');
    }
  }
}
function uuid(value: string): boolean {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
