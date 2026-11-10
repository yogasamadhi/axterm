import { remoteErrorOf } from '@axterm/plugin-api';
import { fileGrantSchema, type FileGrant, type FileGrantRequest } from '@axterm/plugin-api/files';
interface DirectoryGrants {
  create(
    input: FileGrantRequest,
    generation: string,
    signal?: AbortSignal,
  ): Promise<FileGrant | undefined>;
  revoke(id: string, generation: string): Promise<void>;
}
/** Transient UI lease owner; facts still belong to the Files model. */
export class LocalDirectoryGrantOwner {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly owned = new Map<string, { grant: FileGrant; generation: string }>();
  private selection: symbol | undefined;
  private grant: FileGrant | undefined;
  private grantGeneration: string | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly client: DirectoryGrants,
    private readonly generation: () => string | undefined,
    initial?: FileGrant,
  ) {
    if (initial) {
      const value = fileGrantSchema.parse(initial);
      if (value.kind !== 'directory') throw Error('FILES_DIRECTORY_EXPECTED');
      this.grant = Object.freeze(value);
      this.grantGeneration = this.generation();
      if (!this.grantGeneration) throw Error('FILES_NOT_READY');
      this.owned.set(value.grantId, { grant: value, generation: this.grantGeneration });
    }
  }
  current(): FileGrant | undefined {
    return !this.lifetime.signal.aborted && this.grantGeneration === this.generation()
      ? this.grant
      : undefined;
  }
  resourceCount(): number {
    return this.pending.size + this.owned.size;
  }
  select(input: FileGrantRequest, signal?: AbortSignal): Promise<FileGrant | undefined> {
    if (this.closing || this.lifetime.signal.aborted)
      return Promise.reject(Error('FILES_DIRECTORY_OWNER_CLOSED'));
    const generation = this.generation();
    if (!generation) return Promise.reject(Error('FILES_NOT_READY'));
    if (this.pending.size >= 2 || this.owned.size + this.pending.size >= 16)
      return Promise.reject(Error('FILES_DIRECTORY_SELECTION_CAPACITY'));
    const ticket = Symbol('directory-selection');
    this.selection = ticket;
    const owned = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const task = Promise.resolve().then(async () => {
      owned.throwIfAborted();
      const returned = await this.client.create(input, generation, owned);
      if (!returned) return;
      const grant = Object.freeze(fileGrantSchema.parse(returned));
      this.owned.set(grant.grantId, { grant, generation });
      if (
        this.closing ||
        owned.aborted ||
        generation !== this.generation() ||
        this.selection !== ticket ||
        grant.kind !== 'directory'
      ) {
        if (this.grant?.grantId !== grant.grantId) await this.release(grant);
        return;
      }
      const previous = this.grant;
      this.grant = grant;
      this.grantGeneration = generation;
      if (previous && previous.grantId !== grant.grantId) await this.release(previous);
      if (
        !this.closing &&
        !owned.aborted &&
        this.selection === ticket &&
        generation === this.generation() &&
        this.grant?.grantId === grant.grantId
      )
        return grant;
    });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.selection = undefined;
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
      this.grant = undefined;
      const results = await Promise.allSettled(
        [...this.owned.values()].map(({ grant }) => this.release(grant)),
      );
      if (results.some((result) => result.status === 'rejected') || this.owned.size)
        throw Error('FILES_DIRECTORY_GRANTS_UNDRAINED');
    })());
  }
  private async release(grant: FileGrant): Promise<void> {
    const record = this.owned.get(grant.grantId);
    if (!record) return;
    if (record.generation !== this.generation()) throw Error('FILES_DIRECTORY_GENERATION_CHANGED');
    try {
      await this.client.revoke(grant.grantId, record.generation);
    } catch (error) {
      const marked = remoteErrorOf(error);
      if (
        marked?.code !== 'files/failure' ||
        marked.details.reason !== 'not-found' ||
        record.generation !== this.generation()
      )
        throw error;
    }
    this.owned.delete(grant.grantId);
  }
}
