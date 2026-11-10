import { join } from 'node:path';
import { z } from 'zod';
import { RemoteError } from '@axterm/plugin-api';
import type { FileGrants, FileGrantLease } from '@axterm/plugin-api/host';
const failure = (reason: 'invalid-input' | 'stale' | 'capacity' | 'closed' | 'unavailable') =>
  new RemoteError('files/failure', 'Granted input paths are unavailable', { reason });
/** Retained temporary path authority belongs to Files Host, independent of a renderer's lifetime. */
export class GrantedInputPaths {
  private readonly retained = new Map<string, FileGrants>();
  private closed = false;
  constructor(
    private readonly generation: string,
    private readonly grants: () => FileGrants,
  ) {}
  async prepare(
    generation: string,
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    if (this.closed) throw failure('closed');
    if (generation !== this.generation) throw failure('stale');
    const checked = z
      .array(z.string().min(1).max(256))
      .min(1)
      .max(32)
      .refine((ids) => new Set(ids).size === ids.length)
      .parse(ids);
    const grants = this.grants(),
      leases: FileGrantLease[] = [];
    try {
      for (const id of checked) {
        signal.throwIfAborted();
        const lease = await grants.authorize(id, 'read', signal);
        leases.push(lease);
        if (lease.authority.generation !== generation) throw failure('stale');
      }
      const files = leases.filter((lease) => lease.authority.grant.kind === 'file');
      if (
        this.retained.size +
          files.filter((lease) => !this.retained.has(lease.authority.grant.grantId)).length >
        128
      )
        throw failure('capacity');
      const paths = leases.map((lease) => {
        lease.assert();
        const authority = lease.authority;
        if (authority.grant.kind === 'save-target') throw failure('invalid-input');
        const path =
          authority.grant.kind === 'directory'
            ? authority.rootPath
            : join(authority.rootPath, authority.fileName!);
        if (!path || path.length > 8192 || /[\0\r\n]/u.test(path)) throw failure('invalid-input');
        return path;
      });
      signal.throwIfAborted();
      if (this.closed) throw failure('closed');
      for (const lease of files) this.retained.set(lease.authority.grant.grantId, grants);
      return paths;
    } finally {
      for (const lease of leases) lease.dispose();
    }
  }
  released(id: string): void {
    this.retained.delete(id);
  }
  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled(
      [...this.retained].map(async ([id, grants]) => {
        await grants.revoke(id);
        this.retained.delete(id);
      }),
    );
    if (results.some((result) => result.status === 'rejected')) throw failure('unavailable');
  }
}
