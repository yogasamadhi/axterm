import { RemoteError, remoteErrorOf } from '@axterm/plugin-api';
import {
  fileOperationReceiptSchema,
  fileOperationOutcomeSchema,
  type FileOperationOutcome,
  type FileOperationReceipt,
  type FilesFailureReason,
} from '@axterm/plugin-api/files';
import type { RelationalDomain } from '@axterm/plugin-api/storage';
import { commandPayloadHash } from '@axterm/infra-storage-domain';
import type { FileCommands } from '../ports/commands.ts';
interface Row {
  profile_name: string;
  generation: string;
  operation: string;
  payload_hash: string;
  status: string;
  result_json: string;
  error_reason: string | null;
}
const failure = (reason: FilesFailureReason) =>
  new RemoteError('files/failure', 'The file operation could not be completed', { reason });
/** The durable reservation spans IO, never a SQLite transaction across awaits. */
export class FileCommandJournal implements FileCommands {
  private readonly active = new Map<
    string,
    { hash: string; operation: string; done: Promise<FileOperationReceipt> }
  >();
  private readonly lifetime = new AbortController();
  private open = true;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly domain: RelationalDomain,
    private readonly profile: string,
    private readonly generation: string,
  ) {
    if (!profile.length || profile.length > 128) throw failure('invalid-input');
    domain.transaction(() => {
      const stale = domain.all<{ command_id: string }>(
        "SELECT command_id FROM axterm_file_operation_receipts WHERE profile_name=? AND generation<>? AND status='running' LIMIT 65",
        profile,
        generation,
      );
      if (stale.length > 64) throw failure('capacity');
      for (const row of stale) {
        domain.run(
          "UPDATE axterm_file_operation_receipts SET status='interrupted',error_reason='uncertain',updated_at=? WHERE command_id=?",
          new Date().toISOString(),
          row.command_id,
        );
        domain.appendEvent('files/operation-interrupted', { id: row.command_id });
      }
    });
  }
  execute(
    id: string,
    operation: string,
    input: unknown,
    perform: (signal: AbortSignal) => Promise<number>,
    signal: AbortSignal,
  ): Promise<FileOperationReceipt> {
    try {
      if (!this.open) throw failure('closed');
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
        !/^[a-zA-Z][a-zA-Z0-9]{0,127}$/.test(operation)
      )
        throw failure('invalid-input');
      signal.throwIfAborted();
      id = id.toLowerCase();
      let hash: string;
      try {
        hash = commandPayloadHash(input);
      } catch {
        throw failure('invalid-input');
      }
      const active = this.active.get(id);
      if (active) {
        if (active.hash !== hash || active.operation !== operation) throw failure('conflict');
        return this.join(active.done, signal);
      }
      if (this.active.size >= 64) throw failure('capacity');
      const saved = this.domain.transaction(() => {
        const row = this.domain.get<Row>(
          'SELECT profile_name,generation,operation,payload_hash,status,result_json,error_reason FROM axterm_file_operation_receipts WHERE command_id=?',
          id,
        );
        if (row) return row;
        const now = new Date().toISOString();
        this.domain.run(
          "INSERT INTO axterm_file_operation_receipts(command_id,operation,payload_hash,profile_name,generation,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,'running','null',?,?)",
          id,
          operation,
          hash,
          this.profile,
          this.generation,
          now,
          now,
        );
        this.domain.appendEvent('files/operation-started', { id, operation });
        return undefined;
      });
      if (saved) {
        if (saved.profile_name !== this.profile) throw failure('conflict');
        if (saved.operation !== operation || saved.payload_hash !== hash) throw failure('conflict');
        if (saved.status === 'expired') throw failure('receipt-expired');
        if (saved.status === 'completed') {
          try {
            return Promise.resolve(fileOperationReceiptSchema.parse(JSON.parse(saved.result_json)));
          } catch {
            throw failure('unavailable');
          }
        }
        if (saved.status === 'failed') throw failure(this.reason(saved.error_reason));
        throw failure('uncertain');
      }
      const lifetime = AbortSignal.any([signal, this.lifetime.signal]);
      const done = Promise.resolve().then(async () => {
        try {
          lifetime.throwIfAborted();
          const changedCount = await perform(lifetime);
          return this.domain.transaction(() => {
            const cursor = this.domain.appendEvent('files/operation-completed', {
              id,
              operation,
              changedCount,
            });
            const receipt = fileOperationReceiptSchema.parse({
              id,
              operation,
              changedCount,
              cursor,
            });
            this.domain.run(
              "UPDATE axterm_file_operation_receipts SET status='completed',result_json=?,updated_at=? WHERE command_id=? AND status='running'",
              JSON.stringify(receipt),
              new Date().toISOString(),
              id,
            );
            this.trim();
            return receipt;
          });
        } catch (error) {
          const marked = remoteErrorOf(error);
          const reason =
            marked?.code === 'files/failure' && marked.details.reason === 'uncertain'
              ? 'uncertain'
              : lifetime.aborted
                ? 'cancelled'
                : marked?.code === 'files/failure'
                  ? marked.details.reason
                  : 'unavailable';
          // Failure can follow a partial filesystem mutation. A receipt never authorizes replay.
          this.domain.transaction(() => {
            this.domain.run(
              "UPDATE axterm_file_operation_receipts SET status='failed',error_reason=?,updated_at=? WHERE command_id=? AND status='running'",
              reason,
              new Date().toISOString(),
              id,
            );
            this.domain.appendEvent('files/operation-failed', { id, operation, reason });
            this.trim();
          });
          throw failure(reason);
        } finally {
          this.active.delete(id);
        }
      });
      this.active.set(id, { hash, operation, done });
      return done;
    } catch (error) {
      return Promise.reject(signal.aborted ? failure('cancelled') : error);
    }
  }
  outcome(id: string): FileOperationOutcome {
    if (!this.open) throw failure('closed');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      throw failure('invalid-input');
    id = id.toLowerCase();
    const row = this.domain.get<Row>(
      'SELECT profile_name,generation,operation,payload_hash,status,result_json,error_reason FROM axterm_file_operation_receipts WHERE command_id=? AND profile_name=?',
      id,
      this.profile,
    );
    if (!row) return { status: 'missing', id };
    const identity = { id, generation: row.generation, operation: row.operation };
    try {
      return fileOperationOutcomeSchema.parse({
        ...identity,
        status: row.status,
        ...(row.status === 'completed' ? { receipt: JSON.parse(row.result_json) } : {}),
        ...(row.status === 'failed' ? { reason: this.reason(row.error_reason) } : {}),
        ...(row.status === 'interrupted' ? { reason: 'uncertain' } : {}),
      });
    } catch {
      throw failure('unavailable');
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.open = false;
    this.lifetime.abort();
    return (this.closing = Promise.allSettled(
      [...this.active.values()].map((value) => value.done),
    ).then(() => {}));
  }
  private trim(): void {
    this.domain.run(
      "UPDATE axterm_file_operation_receipts SET status='expired',result_json='null',error_reason=NULL WHERE status IN ('completed','failed','interrupted') AND rowid IN (SELECT rowid FROM axterm_file_operation_receipts WHERE status IN ('completed','failed','interrupted') ORDER BY rowid DESC LIMIT -1 OFFSET 2000)",
    );
  }
  private reason(value: string | null): FilesFailureReason {
    return value &&
      [
        'invalid-input',
        'not-found',
        'forbidden',
        'stale',
        'closed',
        'cancelled',
        'capacity',
        'unavailable',
        'unsupported-destination',
        'conflict',
        'uncertain',
        'receipt-expired',
      ].includes(value)
      ? (value as FilesFailureReason)
      : 'unavailable';
  }
  private join<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(failure('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      void task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }
}
