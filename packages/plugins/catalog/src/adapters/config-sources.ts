import { resolve } from 'node:path';
import type {
  FileGrants,
  HostFiles,
  LocalFileLease,
  FileGrantLease,
} from '@axterm/plugin-api/host';
import type {
  ConfigSources,
  ConfigSourceScope,
  ConfigSource,
  ConfigFile,
} from '../ports/config-sources.ts';
import { ApplicationError } from '../application/errors.ts';

/** Each preview owns actual authority/IO leases until all reads and cleanup settle. */
export class GrantedConfigSources implements ConfigSources {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly scopes = new Set<GrantedScope>();
  private closing: Promise<void> | undefined;
  constructor(private readonly services: () => { files: HostFiles; grants: FileGrants }) {}
  run<T>(signal: AbortSignal, action: (scope: ConfigSourceScope) => Promise<T>): Promise<T> {
    if (this.closing || this.scopes.size >= 4)
      return Promise.reject(
        new ApplicationError(
          this.closing ? 'CAPABILITY_UNAVAILABLE' : 'CAPACITY_EXCEEDED',
          'Config reader is unavailable',
        ),
      );
    let resources: { files: HostFiles; grants: FileGrants };
    try {
      resources = this.services();
    } catch (error) {
      return Promise.reject(error);
    }
    const scope = new GrantedScope(
      resources.files,
      resources.grants,
      AbortSignal.any([signal, this.lifetime.signal]),
    );
    this.scopes.add(scope);
    const task = Promise.resolve().then(async () => {
      let value: T;
      try {
        scope.signal.throwIfAborted();
        value = await action(scope);
        scope.signal.throwIfAborted();
      } finally {
        await scope.close();
        this.scopes.delete(scope);
      }
      scope.signal.throwIfAborted();
      return value;
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
      const failures: unknown[] = [];
      for (const scope of this.scopes) {
        try {
          await scope.close();
          this.scopes.delete(scope);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'CATALOG_IMPORT_DRAIN_FAILED');
    })());
  }
}
class GrantedScope implements ConfigSourceScope {
  private readonly authorities = new Set<FileGrantLease>();
  private readonly leases = new Set<LocalFileLease>();
  constructor(
    private readonly files: HostFiles,
    private readonly grants: FileGrants,
    readonly signal: AbortSignal,
  ) {}
  async resolveGrant(id: string): Promise<ConfigSource> {
    this.signal.throwIfAborted();
    const authority = await this.grants.authorize(id, 'read', this.signal);
    this.authorities.add(authority);
    this.signal.throwIfAborted();
    const lease = await this.files.open(id, 'read', this.signal);
    this.leases.add(lease);
    this.signal.throwIfAborted();
    const grant = authority.authority.grant;
    const file = (path: string): ConfigFile => ({
      name: path.split('/').pop() || grant.name,
      // Host-only cycle identity. This path never enters a public DTO or diagnostic.
      key: resolve(authority.authority.rootPath, path),
      stat: () => lease.stat(path),
      read: async (maxBytes) => {
        this.signal.throwIfAborted();
        const metadata = await lease.stat(path);
        if (metadata.type !== 'file' || metadata.size > maxBytes)
          throw new ApplicationError(
            'INVALID_STATE',
            'SSH config exceeds the import limit or is not a regular file',
          );
        const stream = await lease.read(path, { start: 0, end: maxBytes });
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          for await (const raw of stream) {
            this.signal.throwIfAborted();
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            size += chunk.length;
            if (size > maxBytes)
              throw new ApplicationError('INVALID_STATE', 'SSH config exceeds the import limit');
            chunks.push(chunk);
          }
          this.signal.throwIfAborted();
          return Buffer.concat(chunks, size).toString('utf8');
        } finally {
          stream.destroy();
        }
      },
      list: async () => {
        const entries = await lease.list(path);
        return entries
          .filter((item) => item.type === 'file' || item.type === 'directory')
          .map((item) => file(item.path));
      },
    });
    return {
      name: grant.name,
      kind: grant.kind,
      permissions: grant.permissions,
      path: file(lease.path),
    };
  }
  async close(): Promise<void> {
    const failures: unknown[] = [];
    for (const lease of this.leases) {
      try {
        await lease.close();
        this.leases.delete(lease);
      } catch (error) {
        failures.push(error);
      }
    }
    if (!this.leases.size)
      for (const authority of this.authorities) {
        try {
          authority.dispose();
          this.authorities.delete(authority);
        } catch (error) {
          failures.push(error);
        }
      }
    if (failures.length) throw new AggregateError(failures, 'CATALOG_IMPORT_LEASE_CLOSE_FAILED');
  }
}
