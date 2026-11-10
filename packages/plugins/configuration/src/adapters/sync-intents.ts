import { z } from 'zod';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import {
  syncRunReceiptSchema,
  syncOperationResultSchema,
  syncOperationSchema,
  type SyncRunReceipt,
  type SyncCommandOutcome,
  type SyncOperation,
  type SyncOperationResult,
  type SyncFailure,
} from '@axterm/plugin-api/configuration-sync';
import { SyncWorkflowError } from '../application/sync-errors.ts';
import { syncProcessExited, type SyncResourceLease } from './sync-coordination.ts';
interface Row {
  command_id: string;
  profile_name: string;
  generation: string;
  sync_profile_id: string;
  expected_profile_version: number;
  owner_pid: number;
  operation: SyncOperation;
  status: SyncRunReceipt['status'];
  result_json: string;
  error_reason: SyncFailure | null;
  cursor: number;
}
export interface SyncIntent {
  readonly receipt: SyncRunReceipt;
  readonly expectedVersion: number;
}
const fields =
  'command_id,profile_name,generation,sync_profile_id,expected_profile_version,owner_pid,operation,status,error_reason,cursor';
/** One-shot IO admission/outcomes only. No secret values, requests, file bodies or credential hashes. */
export class SyncIntents {
  constructor(
    private readonly domain: RelationalDomain,
    private readonly profile: string,
    private readonly generation: string,
  ) {
    if (!profile || profile.length > 128 || !z.uuid().safeParse(generation).success)
      throw new SyncWorkflowError('invalid-input');
  }
  reserve(
    commandId: string,
    generation: string,
    profileId: string,
    operation: SyncOperation,
    expectedVersion: number,
  ): SyncIntent {
    if (generation !== this.generation) throw new SyncWorkflowError('stale-generation');
    if (
      !z.uuid().safeParse(commandId).success ||
      !z.uuid().safeParse(profileId).success ||
      !syncOperationSchema.safeParse(operation).success ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1
    )
      throw new SyncWorkflowError('invalid-input');
    commandId = commandId.toLowerCase();
    return this.domain.transaction(() => {
      if (this.get(commandId)) throw new SyncWorkflowError('already-submitted');
      const count = this.domain.get<{ count: number }>(
        'SELECT COUNT(*) AS count FROM axterm_sync_run_intents WHERE profile_name=? AND generation=?',
        this.profile,
        this.generation,
      )!.count;
      if (count >= 1_000_000) throw new SyncWorkflowError('capacity');
      const current = this.domain.get<{ version: number }>(
        'SELECT version FROM sync_profiles WHERE id=?',
        profileId,
      );
      if (!current) throw new SyncWorkflowError('not-found');
      if (current.version !== expectedVersion) throw new SyncWorkflowError('conflict');
      const now = new Date().toISOString();
      this.domain.run(
        `INSERT INTO axterm_sync_run_intents(command_id,profile_name,generation,sync_profile_id,expected_profile_version,owner_pid,operation,status,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'queued','null',?,?)`,
        commandId,
        this.profile,
        this.generation,
        profileId,
        expectedVersion,
        process.pid,
        operation,
        now,
        now,
      );
      const cursor = this.domain.appendEvent('configuration/sync-run-admitted', {
        commandId,
        profileId,
        operation,
      });
      this.domain.run(
        'UPDATE axterm_sync_run_intents SET cursor=? WHERE command_id=?',
        cursor,
        commandId,
      );
      return this.get(commandId)!;
    });
  }
  get(commandId: string): SyncIntent | undefined {
    const row = this.domain.get<Row>(
      'SELECT ' + fields + ' FROM axterm_sync_run_intents WHERE command_id=?',
      commandId.toLowerCase(),
    );
    return row
      ? { receipt: this.receipt(row), expectedVersion: row.expected_profile_version }
      : undefined;
  }
  outcome(commandId: string): SyncCommandOutcome {
    if (!z.uuid().safeParse(commandId).success) throw new SyncWorkflowError('invalid-input');
    const row = this.domain.get<Row>(
      'SELECT ' + fields + ',result_json FROM axterm_sync_run_intents WHERE command_id=?',
      commandId.toLowerCase(),
    );
    if (!row) throw new SyncWorkflowError('not-found');
    try {
      const receipt = this.receipt(row);
      const result =
        row.status === 'completed'
          ? syncOperationResultSchema.parse(JSON.parse(row.result_json))
          : undefined;
      if (result && result.operation !== row.operation) throw new Error();
      return { receipt, ...(result ? { result } : {}) };
    } catch {
      throw new SyncWorkflowError('unavailable');
    }
  }
  list(): SyncRunReceipt[] {
    const rows = this.domain.all<Row>(
      `SELECT ${fields} FROM axterm_sync_run_intents WHERE status IN ('queued','running','uncertain') OR command_id IN (SELECT command_id FROM axterm_sync_run_intents ORDER BY result_order DESC LIMIT 2000) ORDER BY cursor DESC LIMIT 2049`,
    );
    if (rows.length > 2048) throw new SyncWorkflowError('capacity');
    return rows.map((row) => this.receipt(row));
  }
  running(commandId: string, lease: SyncResourceLease): void {
    commandId = commandId.toLowerCase();
    this.domain.transaction(() => {
      const row = this.get(commandId);
      if (!row) throw new SyncWorkflowError('not-found');
      this.assertLease(row, lease);
      if (
        row.receipt.ownerProfile !== this.profile ||
        row.receipt.generation !== this.generation ||
        row.receipt.status !== 'queued'
      )
        throw new SyncWorkflowError('already-submitted');
      const version = this.domain.get<{ version: number }>(
        'SELECT version FROM sync_profiles WHERE id=?',
        row.receipt.profileId,
      )?.version;
      if (version !== row.expectedVersion) throw new SyncWorkflowError('conflict');
      const cursor = this.domain.appendEvent('configuration/sync-run-started', {
        commandId,
        profileId: row.receipt.profileId,
      });
      this.domain.run(
        "UPDATE axterm_sync_run_intents SET status='running',updated_at=?,cursor=? WHERE command_id=?",
        new Date().toISOString(),
        cursor,
        commandId,
      );
    });
  }
  finish(
    commandId: string,
    status: 'completed' | 'failed' | 'uncertain',
    result?: SyncOperationResult,
    reason?: SyncFailure,
  ): SyncCommandOutcome {
    commandId = commandId.toLowerCase();
    return this.domain.transaction(() => {
      const row = this.get(commandId);
      if (!row) throw new SyncWorkflowError('not-found');
      if (!['queued', 'running'].includes(row.receipt.status)) return this.outcome(commandId);
      const safe = result ? syncOperationResultSchema.parse(result) : undefined;
      if (status === 'completed' && (!safe || safe.operation !== row.receipt.operation))
        throw new SyncWorkflowError('unavailable');
      const serialized = safe ? JSON.stringify(safe) : 'null';
      if (Buffer.byteLength(serialized) > 512 * 1024) throw new SyncWorkflowError('capacity');
      const order = this.domain.get<{ value: number }>(
        'SELECT COALESCE(MAX(result_order),0) AS value FROM axterm_sync_run_intents',
      )!.value;
      if (order >= Number.MAX_SAFE_INTEGER) throw new SyncWorkflowError('capacity');
      const cursor = this.domain.appendEvent('configuration/sync-run-finished', {
        commandId,
        profileId: row.receipt.profileId,
        status,
      });
      this.domain.run(
        'UPDATE axterm_sync_run_intents SET status=?,result_json=?,error_reason=?,updated_at=?,result_order=?,cursor=? WHERE command_id=?',
        status,
        serialized,
        reason ?? null,
        new Date().toISOString(),
        order + 1,
        cursor,
        commandId,
      );
      this.domain.run(
        "UPDATE axterm_sync_run_intents SET status='expired',result_json='null',error_reason='receipt-expired',cursor=? WHERE command_id IN (SELECT command_id FROM axterm_sync_run_intents WHERE status IN ('completed','failed','interrupted') ORDER BY result_order DESC LIMIT -1 OFFSET 2000)",
        cursor,
      );
      return this.outcome(commandId);
    });
  }
  /** Caller holds the actual shared resource lease. Queued activity of another live Profile is left alone. */
  recoverResource(lease: SyncResourceLease, currentCommandId?: string): void {
    lease.assert();
    this.domain.transaction(() => {
      const rows = this.domain.all<Row>(
        `SELECT ${fields} FROM axterm_sync_run_intents WHERE sync_profile_id=? AND status IN ('running','queued') LIMIT 1001`,
        lease.resourceId,
      );
      if (rows.length > 1000) throw new SyncWorkflowError('capacity');
      for (const row of rows) {
        if (row.command_id === currentCommandId) continue;
        if (
          row.status === 'queued' &&
          row.profile_name !== this.profile &&
          !syncProcessExited(row.owner_pid)
        )
          continue;
        lease.assert();
        const order = this.domain.get<{ value: number }>(
          'SELECT COALESCE(MAX(result_order),0) AS value FROM axterm_sync_run_intents',
        )!.value;
        if (order >= Number.MAX_SAFE_INTEGER) throw new SyncWorkflowError('capacity');
        const cursor = this.domain.appendEvent('configuration/sync-run-interrupted', {
          commandId: row.command_id,
          profileId: row.sync_profile_id,
        });
        this.domain.run(
          "UPDATE axterm_sync_run_intents SET status='interrupted',result_json='null',error_reason='interrupted',updated_at=?,cursor=?,result_order=? WHERE command_id=?",
          new Date().toISOString(),
          cursor,
          order + 1,
          row.command_id,
        );
      }
    });
  }
  private assertLease(intent: SyncIntent, lease: SyncResourceLease): void {
    lease.assert();
    if (lease.resourceId !== intent.receipt.profileId) throw new SyncWorkflowError('conflict');
  }
  private receipt(row: Row): SyncRunReceipt {
    try {
      return syncRunReceiptSchema.parse({
        ownerProfile: row.profile_name,
        commandId: row.command_id,
        generation: row.generation,
        profileId: row.sync_profile_id,
        operation: row.operation,
        status: row.status,
        ...(row.error_reason ? { reason: row.error_reason } : {}),
        cursor: row.cursor,
      });
    } catch {
      throw new SyncWorkflowError('unavailable');
    }
  }
}
