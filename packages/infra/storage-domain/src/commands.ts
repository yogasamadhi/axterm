import { createHash } from 'node:crypto';
import {
  StorageCommandError,
  type StorageCommandJournal,
  type RelationalDomain,
  type JsonValue,
} from '@axterm/plugin-api';

const MAX_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
interface Receipt {
  operation: string;
  payload_hash: string;
  status: string;
  result_json: string;
}

/** Bounded canonical encoding accepts validated JSON DTOs and omits optional undefined object fields. */
function canonical(value: unknown, code: 'invalid-input' | 'invalid-result'): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  let budget = 0;
  const invalid = (): never => {
    throw new StorageCommandError(code);
  };
  const visit = (value: unknown, depth: number): JsonValue => {
    if (++nodes > 100_000 || depth > 64) return invalid();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number')
      return Number.isFinite(value) && !Object.is(value, -0) ? value : invalid();
    if (typeof value === 'string') {
      budget += Buffer.byteLength(value);
      if (budget > MAX_BYTES) return invalid();
      return value;
    }
    if (typeof value !== 'object' || ancestors.has(value)) return invalid();
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (
          Object.getPrototypeOf(value) !== Array.prototype ||
          Reflect.ownKeys(value).length !== value.length + 1
        )
          return invalid();
        return Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !('value' in descriptor)) return invalid();
          return visit(descriptor.value, depth + 1);
        });
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
      const result: { [key: string]: JsonValue } = Object.create(null);
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== 'string')) return invalid();
      for (const key of (keys as string[]).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!descriptor.enumerable || !('value' in descriptor)) return invalid();
        if (descriptor.value === undefined) continue;
        budget += Buffer.byteLength(key);
        if (budget > MAX_BYTES) return invalid();
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(value);
    }
  };
  try {
    const encoded = JSON.stringify(visit(value, 0));
    if (Buffer.byteLength(encoded) > MAX_BYTES) return invalid();
    return encoded;
  } catch {
    return invalid();
  }
}

/** Bounded canonical input identity shared by fact transactions and reserved IO commands. */
export function commandPayloadHash(input: unknown): string {
  return createHash('sha256').update(canonical(input, 'invalid-input')).digest('hex');
}
/** Generic owned-storage adapter. Domain services choose their operation and compact outcome. */
export class DomainCommands implements StorageCommandJournal {
  private readonly table: string;
  constructor(
    private readonly domain: RelationalDomain,
    table: string,
    private readonly retainedOutcomes = 2000,
  ) {
    if (
      typeof table !== 'string' ||
      !/^[a-z][a-z0-9_]{0,127}$/.test(table) ||
      !Number.isInteger(retainedOutcomes) ||
      retainedOutcomes < 1 ||
      retainedOutcomes > 10_000
    )
      throw new StorageCommandError('invalid-input');
    this.table = `"${table}"`;
    // The facet, not a caller-supplied name, authorizes the receipt table.
    domain.get(`SELECT command_id FROM ${this.table} LIMIT 0`);
  }
  /** Read a prior outcome before allocating IO. Does not expire, insert or notify. */
  lookup<T>(id: string, operation: string, input: unknown): T | undefined {
    if (
      typeof id !== 'string' ||
      typeof operation !== 'string' ||
      !UUID.test(id) ||
      !/^[a-z][a-zA-Z0-9/._-]{0,127}$/.test(operation)
    )
      throw new StorageCommandError('invalid-input');
    const commandId = id.toLowerCase();
    const hash = commandPayloadHash(input);
    const saved = this.domain.get<Receipt>(
      `SELECT operation,payload_hash,status,result_json FROM ${this.table} WHERE command_id=?`,
      commandId,
    );
    if (!saved) return undefined;
    if (saved.operation !== operation || saved.payload_hash !== hash)
      throw new StorageCommandError('conflict');
    if (saved.status === 'expired') throw new StorageCommandError('receipt-expired');
    if (saved.status !== 'completed') throw new StorageCommandError('corrupt-receipt');
    try {
      const result: unknown = JSON.parse(saved.result_json);
      canonical(result, 'invalid-result');
      return result as T;
    } catch {
      throw new StorageCommandError('corrupt-receipt');
    }
  }
  execute<T>(id: string, operation: string, input: unknown, apply: () => T): T {
    if (
      typeof id !== 'string' ||
      typeof operation !== 'string' ||
      !UUID.test(id) ||
      !/^[a-z][a-zA-Z0-9/._-]{0,127}$/.test(operation)
    )
      throw new StorageCommandError('invalid-input');
    const commandId = id.toLowerCase();
    const hash = commandPayloadHash(input);
    return this.domain.transaction(() => {
      const previous = this.lookup<T>(id, operation, input);
      if (previous !== undefined) return previous;
      const result = apply();
      if (result instanceof Promise) {
        void Promise.prototype.then.call(result, undefined, () => {});
        throw new StorageCommandError('invalid-result');
      }
      const encoded = canonical(result, 'invalid-result');
      this.domain.run(
        `INSERT INTO ${this.table}(command_id,operation,payload_hash,status,result_json,created_at) VALUES (?,?,?,'completed',?,?)`,
        commandId,
        operation,
        hash,
        encoded,
        new Date().toISOString(),
      );
      this.domain.run(
        `UPDATE ${this.table} SET status='expired',result_json='null' WHERE status='completed' AND rowid IN (SELECT rowid FROM ${this.table} WHERE status='completed' ORDER BY rowid DESC LIMIT -1 OFFSET ?)`,
        this.retainedOutcomes,
      );
      return JSON.parse(encoded) as T;
    });
  }
}
