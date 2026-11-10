import { randomUUID } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileGrantSchema, type FileGrant, type FilePermission } from '@axterm/plugin-api/files';
import {
  fileAuthoritySchema,
  type FileAuthority,
  type FileIdentity,
  type FileGrantPage,
} from '@axterm/plugin-api/host';
import { NativeError } from './protocol.ts';

const MAX_GRANTS = 16_384;
const PAGE_SIZE = 256;
interface RecordGrant {
  readonly authority: FileAuthority;
  readonly listed: boolean;
}
const identity = (value: { dev: bigint; ino: bigint }): FileIdentity => ({
  device: String(value.dev),
  inode: String(value.ino),
});
const same = (left: FileIdentity, right: FileIdentity) =>
  left.device === right.device && left.inode === right.inode;
const missing = (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

/** Shell-owned ephemeral authority. It grants paths but performs no file business operation. */
export class NativeFileGrantRegistry {
  private readonly grants = new Map<string, RecordGrant>();
  private revision = 0;
  private active = true;
  private readonly expiry: ReturnType<typeof setInterval>;
  constructor(
    readonly generation: string,
    private readonly capacity = MAX_GRANTS,
  ) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generation)
    )
      throw new NativeError('INVALID');
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_GRANTS)
      throw new NativeError('INVALID');
    this.expiry = setInterval(() => this.sweep(), 60_000);
    this.expiry.unref();
  }
  async createTrustedPath(
    path: string,
    kind: FileGrant['kind'],
    permissions: readonly FilePermission[],
    ttlMs?: number,
    signal?: AbortSignal,
    listed = true,
  ): Promise<FileGrant> {
    this.assertActive();
    this.sweep();
    if (
      !isAbsolute(path) ||
      path.includes('\0') ||
      Buffer.byteLength(path) > 4096 ||
      !permissions.length ||
      permissions.some((value) => value !== 'read' && value !== 'write') ||
      permissions.length > 2 ||
      (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 3_600_000))
    )
      throw new NativeError('INVALID');
    if (this.grants.size >= this.capacity) throw new NativeError('LIMIT');
    signal?.throwIfAborted();
    let rootPath: string;
    let rootIdentity: FileIdentity;
    let fileName: string | undefined;
    let fileIdentity: FileIdentity | undefined;
    try {
      if (kind === 'directory') {
        rootPath = await realpath(path);
        const value = await stat(rootPath, { bigint: true });
        if (!value.isDirectory()) throw new NativeError('INVALID');
        rootIdentity = identity(value);
      } else if (kind === 'file') {
        const canonical = await realpath(path);
        const value = await lstat(canonical, { bigint: true });
        if (!value.isFile() || value.isSymbolicLink()) throw new NativeError('INVALID');
        rootPath = dirname(canonical);
        fileName = basename(canonical);
        rootIdentity = identity(await stat(rootPath, { bigint: true }));
        fileIdentity = identity(value);
      } else if (kind === 'save-target') {
        rootPath = await realpath(dirname(path));
        const parent = await stat(rootPath, { bigint: true });
        if (!parent.isDirectory()) throw new NativeError('INVALID');
        rootIdentity = identity(parent);
        fileName = basename(path);
        const value = await lstat(join(rootPath, fileName), { bigint: true }).catch((error) => {
          if (missing(error)) return undefined;
          throw error;
        });
        if (value) {
          if (!value.isFile() || value.isSymbolicLink()) throw new NativeError('FORBIDDEN');
          fileIdentity = identity(value);
        }
      } else throw new NativeError('INVALID');
    } catch (error) {
      if (error instanceof NativeError) throw error;
      throw new NativeError('IO');
    }
    signal?.throwIfAborted();
    this.assertActive();
    if (this.grants.size >= this.capacity) throw new NativeError('LIMIT');
    const createdAt = new Date().toISOString();
    const grant = fileGrantSchema.parse({
      grantId: 'grant_' + randomUUID(),
      kind,
      name: kind === 'directory' ? basename(rootPath) || rootPath : fileName,
      permissions: [...new Set(permissions)],
      createdAt,
      ...(ttlMs === undefined ? {} : { expiresAt: new Date(Date.now() + ttlMs).toISOString() }),
      ...(kind === 'directory' ? { rootPath } : {}),
    });
    const authority = fileAuthoritySchema.parse({
      grant,
      generation: this.generation,
      rootPath,
      rootIdentity,
      ...(fileName === undefined ? {} : { fileName }),
      ...(fileIdentity === undefined ? {} : { fileIdentity }),
    });
    this.advance();
    this.grants.set(grant.grantId, { authority, listed });
    return structuredClone(grant);
  }
  list(offset = 0, limit = PAGE_SIZE, revision?: number): FileGrantPage {
    this.assertActive();
    this.sweep();
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > PAGE_SIZE
    )
      throw new NativeError('INVALID');
    if (revision !== undefined && revision !== this.revision) throw new NativeError('STALE');
    const items: FileGrant[] = [];
    let index = 0;
    for (const record of this.grants.values()) {
      if (!record.listed) continue;
      if (index++ < offset) continue;
      if (items.length < limit) items.push(structuredClone(record.authority.grant));
    }
    const nextOffset = offset + items.length;
    return {
      revision: this.revision,
      items,
      nextOffset: nextOffset < index ? nextOffset : null,
    };
  }
  async authorize(
    grantId: string,
    permission: FilePermission,
    signal?: AbortSignal,
  ): Promise<FileAuthority> {
    const record = this.require(grantId);
    if (!record.authority.grant.permissions.includes(permission))
      throw new NativeError('FORBIDDEN');
    signal?.throwIfAborted();
    const authority = record.authority;
    try {
      const root = await lstat(authority.rootPath, { bigint: true });
      if (
        !root.isDirectory() ||
        root.isSymbolicLink() ||
        !same(identity(root), authority.rootIdentity)
      )
        throw new NativeError('STALE');
      if (authority.fileName !== undefined) {
        const file = await lstat(join(authority.rootPath, authority.fileName), {
          bigint: true,
        }).catch((error) => {
          if (missing(error)) return undefined;
          throw error;
        });
        if (file) {
          if (
            !file.isFile() ||
            file.isSymbolicLink() ||
            !authority.fileIdentity ||
            !same(identity(file), authority.fileIdentity)
          )
            throw new NativeError('STALE');
        } else if (authority.fileIdentity) throw new NativeError('STALE');
      }
    } catch (error) {
      if (error instanceof NativeError) throw error;
      throw new NativeError(missing(error) ? 'STALE' : 'IO');
    }
    signal?.throwIfAborted();
    if (this.require(grantId) !== record) throw new NativeError('STALE');
    return structuredClone(authority);
  }
  revoke(grantId: string): void {
    this.assertActive();
    if (this.grants.has(grantId)) {
      this.advance();
      this.grants.delete(grantId);
    }
  }
  close(): void {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.expiry);
    this.grants.clear();
  }
  resourceCount(): number {
    return this.grants.size;
  }
  private require(id: string): RecordGrant {
    this.assertActive();
    const record = this.grants.get(id);
    if (!record) throw new NativeError('NOT_FOUND');
    if (
      record.authority.grant.expiresAt &&
      Date.parse(record.authority.grant.expiresAt) <= Date.now()
    ) {
      this.revoke(id);
      throw new NativeError('NOT_FOUND');
    }
    return record;
  }
  private sweep(): void {
    if (!this.active) return;
    for (const [id, record] of this.grants)
      if (
        record.authority.grant.expiresAt &&
        Date.parse(record.authority.grant.expiresAt) <= Date.now()
      )
        this.revoke(id);
  }
  private advance(): void {
    if (!Number.isSafeInteger(this.revision + 1)) throw new NativeError('LIMIT');
    this.revision++;
  }
  private assertActive(): void {
    if (!this.active) throw new NativeError('CLOSED');
  }
}
