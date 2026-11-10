import { remoteErrorOf } from '@axterm/plugin-api';
import type {
  CreateTransferInput,
  Transfer,
  TransferClientActions,
} from '@axterm/plugin-api/transfers';
import type { FileGrantsModel } from '../index.ts';
interface Record {
  grantId: string;
  generation: string;
  keys: Map<string, { id?: string }>;
  releaseRequested: boolean;
  cleanup?: Promise<void>;
}
const terminal = (state: Transfer['state']) => ['succeeded', 'failed', 'canceled'].includes(state);
/** Authority lifetime only; the Transfers owner remains the queue, IO and fact source. */
export class TransferGrantHandoffs {
  private readonly grants = new Map<string, Record>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly off: () => void;
  private sweeping: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly files: FileGrantsModel,
    private readonly transfers: TransferClientActions,
  ) {
    this.off = transfers.subscribe(() => this.refresh());
    this.timer = setInterval(() => this.refresh(), 250);
  }
  create(key: string, input: CreateTransferInput): Promise<Transfer> {
    if (this.closing) return Promise.reject(Error('FILES_HANDOFF_CLOSED'));
    if (input.direction === 'remote-copy') return this.transfers.create(key, input);
    // Terminals without cwd integration target the SFTP home. Only Files resolves
    // that relative child before handing an absolute path to Transfers.
    if (input.remotePath.startsWith('./')) {
      const name = input.remotePath.slice(2);
      if (!name || name === '.' || name === '..' || /[/\\\0]/u.test(name))
        return Promise.reject(Error('FILES_HANDOFF_INVALID_PATH'));
      const facts = this.files.getSnapshot();
      if (facts.status !== 'ready') return Promise.reject(Error('FILES_NOT_READY'));
      const generation = facts.baseline.generation;
      const captured = structuredClone(input);
      const task = this.files.getRemoteHome(captured.target).then(({ path }) => {
        this.assertGeneration(generation);
        return this.create(key, {
          ...captured,
          remotePath: path.replace(/\/+$/u, '') + '/' + name,
        });
      });
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task)).catch(() => {});
      return task;
    }
    const facts = this.files.getSnapshot();
    if (facts.status !== 'ready') return Promise.reject(Error('FILES_NOT_READY'));
    let record = this.grants.get(input.grantId);
    if (!record) {
      if (this.grants.size >= 64) return Promise.reject(Error('FILES_HANDOFF_CAPACITY'));
      record = {
        grantId: input.grantId,
        generation: facts.baseline.generation,
        keys: new Map(),
        releaseRequested: false,
      };
      this.grants.set(input.grantId, record);
    }
    this.assertGeneration(record.generation);
    if (record.keys.size >= 32 && !record.keys.has(key))
      return Promise.reject(Error('FILES_HANDOFF_CAPACITY'));
    record.keys.set(key, record.keys.get(key) ?? {});
    const owned = record;
    const task = this.transfers.create(key, input).then(
      (value) => {
        owned.keys.set(key, { id: value.id });
        this.refresh();
        return value;
      },
      async (error) => {
        try {
          this.assertGeneration(owned.generation);
          const outcome = await this.transfers.getCommandOutcome(owned.generation, key);
          if (outcome.status === 'accepted') {
            owned.keys.set(key, { id: outcome.transfer.id });
            this.refresh();
            return outcome.transfer;
          }
          if (outcome.status === 'expired') owned.keys.delete(key);
          else {
            const marked = remoteErrorOf(error);
            if (
              marked?.code === 'transfers/failure' &&
              ['invalid-input', 'capacity', 'conflict', 'not-found'].includes(marked.details.reason)
            )
              owned.keys.delete(key);
          }
        } catch {
          /* Unknown acceptance retains authority. */
        }
        throw error;
      },
    );
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  async release(grantId: string, generation: string): Promise<void> {
    const record = this.grants.get(grantId);
    if (!record) {
      await this.revoke(grantId, generation);
      return;
    }
    if (record.generation !== generation) throw Error('FILES_HANDOFF_GENERATION_CHANGED');
    this.assertGeneration(generation);
    record.releaseRequested = true;
    await this.sweep();
  }
  resourceCount() {
    return this.grants.size + this.pending.size;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      clearInterval(this.timer);
      this.off();
      await Promise.allSettled([...this.pending]);
      await this.sweeping;
      await this.sweep();
      for (const record of this.grants.values()) {
        this.assertGeneration(record.generation);
        record.releaseRequested = true;
        for (const [key, ref] of record.keys) {
          if (!ref.id) {
            const outcome = await this.transfers.getCommandOutcome(record.generation, key);
            if (outcome.status === 'accepted') ref.id = outcome.transfer.id;
            else if (outcome.status === 'expired') {
              record.keys.delete(key);
              continue;
            } else throw Error('FILES_HANDOFF_UNCERTAIN');
          }
          this.assertGeneration(record.generation);
          const value = await this.transfers.get(ref.id);
          this.assertGeneration(record.generation);
          if (!terminal(value.state)) await this.transfers.cancel(crypto.randomUUID(), value.id);
        }
      }
      const deadline = Date.now() + 10_000;
      while (this.grants.size && Date.now() < deadline) {
        await this.sweep();
        if (this.grants.size) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (this.grants.size) throw Error('FILES_HANDOFF_UNDRAINED');
    })());
  }
  private refresh() {
    if (!this.closing) void this.sweep().catch(() => {});
  }
  private sweep(): Promise<void> {
    return (this.sweeping ??= (async () => {
      const facts = this.transfers.getSnapshot();
      for (const record of this.grants.values()) {
        this.assertGeneration(record.generation);
        for (const [key, ref] of record.keys) {
          if (!ref.id) {
            const outcome = await this.transfers.getCommandOutcome(record.generation, key);
            if (outcome.status === 'accepted') ref.id = outcome.transfer.id;
            else if (outcome.status === 'expired') record.keys.delete(key);
            else continue;
          }
          if (ref.id) {
            this.assertGeneration(record.generation);
            const value =
              facts.status === 'ready'
                ? facts.baseline.items.find((value) => value.id === ref.id)
                : undefined;
            const current = value ?? (await this.transfers.get(ref.id));
            this.assertGeneration(record.generation);
            if (terminal(current.state)) record.keys.delete(key);
          }
        }
        if (record.keys.size === 0) {
          if (record.releaseRequested) {
            try {
              await (record.cleanup ??= this.revoke(record.grantId, record.generation));
            } finally {
              delete record.cleanup;
            }
          }
          this.grants.delete(record.grantId);
        }
      }
    })().finally(() => {
      this.sweeping = undefined;
    }));
  }
  private assertGeneration(generation: string): void {
    const files = this.files.getSnapshot(),
      transfers = this.transfers.getSnapshot();
    if (files.status !== 'ready' || transfers.status !== 'ready')
      throw Error('FILES_HANDOFF_NOT_READY');
    if (files.baseline.generation !== generation || transfers.baseline.generation !== generation)
      throw Error('FILES_HANDOFF_GENERATION_CHANGED');
  }
  private async revoke(id: string, generation: string) {
    const facts = this.files.getSnapshot();
    if (facts.status !== 'ready' || facts.baseline.generation !== generation)
      throw Error('FILES_HANDOFF_GENERATION_CHANGED');
    try {
      await this.files.revokeInGeneration(id, generation);
    } catch (error) {
      const marked = remoteErrorOf(error),
        current = this.files.getSnapshot();
      if (
        marked?.code !== 'files/failure' ||
        marked.details.reason !== 'not-found' ||
        current.status !== 'ready' ||
        current.baseline.generation !== generation
      )
        throw error;
    }
  }
}
