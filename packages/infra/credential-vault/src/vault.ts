import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { withFileLock } from '@axterm/infra-atomic-write';
import { z } from 'zod';
import {
  credentialMutationMarkerSchema,
  type CredentialMutationMarker,
} from '@axterm/plugin-api/saved-credentials';

const MAX_SECRET_BYTES = 4 * 1024 * 1024;
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const reference = z
  .string()
  .regex(/^cred_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const addressSchema = z.discriminatedUnion('space', [
  z
    .object({
      space: z.literal('reference'),
      key: z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .max(2048),
    })
    .strict(),
  z
    .object({
      space: z.literal('record'),
      key: z
        .string()
        .regex(/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/)
        .max(2048),
    })
    .strict(),
]);
export const metadataSchema = z
  .object({
    ref: reference,
    kind: z.string().max(4096),
    label: z.string().max(4096),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    storage: z.literal('local'),
    address: addressSchema.optional(),
    mutation: credentialMutationMarkerSchema.optional(),
  })
  .strict();
const metadataListSchema = z
  .array(metadataSchema)
  .max(100_000)
  .superRefine((entries, ctx) => {
    const refs = new Set<string>();
    const addresses = new Set<string>();
    for (const entry of entries) {
      const address = entry.address && `${entry.address.space}:${entry.address.key}`;
      if (refs.has(entry.ref) || (address && addresses.has(address)))
        ctx.addIssue({ code: 'custom', message: 'Duplicate Vault entry' });
      refs.add(entry.ref);
      if (address) addresses.add(address);
    }
  });
const payloadSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal('aes-256-gcm'),
    nonce: z.string(),
    tag: z.string(),
    ciphertext: z.string(),
  })
  .strict();
const journalSchema = z
  .object({
    version: z.literal(1),
    metadata: metadataListSchema,
    write: z.object({ ref: reference, payload: payloadSchema }).strict().optional(),
    remove: reference.optional(),
  })
  .strict()
  .superRefine((journal, ctx) => {
    if (
      (journal.write && journal.remove) ||
      (journal.write && !journal.metadata.some((entry) => entry.ref === journal.write!.ref)) ||
      (journal.remove && journal.metadata.some((entry) => entry.ref === journal.remove))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid Vault journal' });
    }
  });
export type VaultAddress = z.infer<typeof addressSchema>;
export type VaultMetadata = z.infer<typeof metadataSchema>;
type Payload = z.infer<typeof payloadSchema>;
type Journal = z.infer<typeof journalSchema>;

/** Stable diagnostics never retain crypto/JSON/filesystem causes or secret-bearing inputs. */
export class VaultError extends Error {
  readonly code:
    | 'CLOSED'
    | 'INVALID'
    | 'CORRUPT'
    | 'KEY_MISSING'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'IO'
    | 'MUTATION_FAILED';
  constructor(code: VaultError['code']) {
    super(`VAULT_${code}`);
    this.name = 'VaultError';
    this.code = code;
  }
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
function decode64(value: string, size?: number): Buffer {
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value || (size !== undefined && result.length !== size))
    throw new VaultError('CORRUPT');
  return result;
}
function parse<T>(schema: z.ZodType<T>, text: string): T {
  try {
    const result = schema.safeParse(JSON.parse(text));
    if (!result.success) throw new VaultError('CORRUPT');
    return result.data;
  } catch {
    throw new VaultError('CORRUPT');
  }
}
async function readBounded(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    if ((await handle.stat()).size > MAX_MEDIA_BYTES) throw new VaultError('CORRUPT');
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_MEDIA_BYTES - size + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_MEDIA_BYTES) throw new VaultError('CORRUPT');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally {
    await handle.close();
  }
}
/** The encrypted Vault needs crash durability in addition to atomic replacement. */
async function durableReplace(path: string, content: string | Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
  }
}

/** Shell-owned physical media; the Host consumes a narrow credentials port on Desktop. */
export class EncryptedVault {
  private readonly directory: string;
  private masterKey: Buffer | undefined;
  private opening: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private accepting = true;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(directory: string) {
    if (!directory) throw new VaultError('INVALID');
    this.directory = resolve(directory);
  }
  open(): Promise<void> {
    if (!this.accepting) return Promise.reject(new VaultError('CLOSED'));
    return (this.opening ??= this.operation(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      await this.exclusive(async () => {
        const entries = await this.metadata();
        const path = join(this.directory, 'master.key');
        try {
          const handle = await open(path, 'r');
          let key: Buffer;
          try {
            key = Buffer.alloc(33);
            const { bytesRead } = await handle.read(key, 0, 33, 0);
            key = key.subarray(0, bytesRead);
          } finally {
            await handle.close();
          }
          if (key.length !== 32) {
            key.fill(0);
            throw new VaultError('CORRUPT');
          }
          this.masterKey = key;
          try {
            await chmod(path, 0o600);
          } catch (error) {
            key.fill(0);
            this.masterKey = undefined;
            throw error;
          }
        } catch (error) {
          if (!missing(error)) throw error;
          if (
            entries.length ||
            (await readdir(this.directory)).some(
              (file) => file.endsWith('.bin') || file === 'commit.json',
            )
          )
            throw new VaultError('KEY_MISSING');
          const key = randomBytes(32);
          try {
            await durableReplace(path, key);
            await this.syncDirectory();
            this.masterKey = key;
          } catch (error) {
            key.fill(0);
            throw error;
          }
        }
        try {
          await this.recover();
        } catch (error) {
          this.masterKey?.fill(0);
          this.masterKey = undefined;
          throw error;
        }
      }, false);
    }));
  }
  close(): Promise<void> {
    this.accepting = false;
    return (this.closing ??= (async () => {
      await Promise.allSettled([...this.pending]);
      this.masterKey?.fill(0);
      this.masterKey = undefined;
    })());
  }
  list(): Promise<readonly VaultMetadata[]> {
    return this.run(() =>
      this.exclusive(async () => (await this.metadata()).filter((entry) => !entry.address)),
    );
  }
  put(input: { kind: string; label: string; secret: string }): Promise<VaultMetadata> {
    return this.run(() =>
      this.exclusive(async () => {
        this.validateSecret(input.secret);
        const now = new Date().toISOString();
        const entry = metadataSchema.safeParse({
          ref: `cred_${randomUUID()}`,
          kind: input.kind,
          label: input.label,
          createdAt: now,
          updatedAt: now,
          storage: 'local',
        });
        if (!entry.success) throw new VaultError('INVALID');
        await this.commit({
          version: 1,
          metadata: [...(await this.metadata()), entry.data],
          write: { ref: entry.data.ref, payload: this.encrypt(entry.data.ref, input.secret) },
        });
        return entry.data;
      }),
    );
  }
  /** Publish only a preallocated new reference; recovery can identify an already committed mutation. */
  createAt(
    ref: string,
    input: { kind: string; label: string; secret: string },
    mutation: CredentialMutationMarker,
  ): Promise<VaultMetadata> {
    return this.run(() =>
      this.exclusive(async () => {
        this.validateRef(ref);
        this.validateSecret(input.secret);
        const parsedMarker = credentialMutationMarkerSchema.safeParse(mutation);
        if (!parsedMarker.success) throw new VaultError('INVALID');
        const entries = await this.metadata();
        if (entries.some((entry) => entry.ref === ref)) throw new VaultError('CONFLICT');
        const now = new Date().toISOString();
        const parsed = metadataSchema.safeParse({
          ref,
          kind: input.kind,
          label: input.label,
          storage: 'local',
          createdAt: now,
          updatedAt: now,
          mutation: parsedMarker.data,
        });
        if (!parsed.success) throw new VaultError('INVALID');
        await this.commit({
          version: 1,
          metadata: [...entries, parsed.data],
          write: { ref, payload: this.encrypt(ref, input.secret) },
        });
        return parsed.data;
      }),
    );
  }
  get(ref: string): Promise<string> {
    return this.run(() =>
      this.exclusive(async () => {
        this.validateRef(ref);
        const entry = (await this.metadata()).find((entry) => entry.ref === ref && !entry.address);
        if (!entry) throw new VaultError('NOT_FOUND');
        return this.decrypt(ref);
      }),
    );
  }
  replace(ref: string, secret: string): Promise<VaultMetadata> {
    return this.replaceEntry(ref, secret);
  }
  replaceManaged(
    ref: string,
    secret: string,
    mutation: CredentialMutationMarker,
  ): Promise<VaultMetadata> {
    const parsed = credentialMutationMarkerSchema.safeParse(mutation);
    if (!parsed.success) return Promise.reject(new VaultError('INVALID'));
    return this.replaceEntry(ref, secret, parsed.data);
  }
  private replaceEntry(
    ref: string,
    secret: string,
    mutation?: CredentialMutationMarker,
  ): Promise<VaultMetadata> {
    return this.run(() =>
      this.exclusive(async () => {
        this.validateRef(ref);
        this.validateSecret(secret);
        const entries = await this.metadata();
        const index = entries.findIndex((entry) => entry.ref === ref && !entry.address);
        if (index < 0) throw new VaultError('NOT_FOUND');
        // A later unmanaged write must not leave an old managed proof attached to different ciphertext.
        const { mutation: _previous, ...previous } = entries[index]!;
        const entry = {
          ...previous,
          updatedAt: new Date().toISOString(),
          ...(mutation ? { mutation } : {}),
        };
        entries[index] = entry;
        await this.commit({
          version: 1,
          metadata: entries,
          write: { ref, payload: this.encrypt(ref, secret) },
        });
        return entry;
      }),
    );
  }
  deleteManaged(
    ref: string,
    expected: CredentialMutationMarker,
  ): Promise<'deleted' | 'missing' | 'changed'> {
    const parsed = credentialMutationMarkerSchema.safeParse(expected);
    if (!parsed.success) return Promise.reject(new VaultError('INVALID'));
    return this.run(() =>
      this.exclusive(async () => {
        this.validateRef(ref);
        const entries = await this.metadata();
        const entry = entries.find((item) => item.ref === ref && !item.address);
        if (!entry) return 'missing';
        if (
          entry.kind !== 'mcpApiKey' ||
          entry.mutation?.generation !== parsed.data.generation ||
          entry.mutation.commandId !== parsed.data.commandId
        )
          return 'changed';
        await this.commit({
          version: 1,
          metadata: entries.filter((item) => item.ref !== ref),
          remove: ref,
        });
        return 'deleted';
      }),
    );
  }
  delete(ref: string): Promise<void> {
    return this.run(() =>
      this.exclusive(async () => {
        this.validateRef(ref);
        const entries = await this.metadata();
        if (!entries.some((entry) => entry.ref === ref && !entry.address)) return;
        await this.commit({
          version: 1,
          metadata: entries.filter((entry) => entry.ref !== ref),
          remove: ref,
        });
      }),
    );
  }
  readAddress(address: VaultAddress): Promise<string | undefined> {
    return this.run(() => this.readAddressCore(this.validateAddress(address)));
  }
  addresses(space: VaultAddress['space']): Promise<readonly VaultAddress[]> {
    return this.run(() =>
      this.exclusive(async () =>
        (await this.metadata()).flatMap((entry) =>
          entry.address?.space === space ? [entry.address] : [],
        ),
      ),
    );
  }
  /** Mutators hold only their address lease; nested resolution of other references stays usable. */
  modifyAddress(
    address: VaultAddress,
    mutate: (current: string | undefined) => Promise<string | undefined>,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    return this.run(async () => {
      address = this.validateAddress(address);
      const lock = join(
        this.directory,
        `entry-${createHash('sha256').update(`${address.space}:${address.key}`).digest('hex')}`,
      );
      return withFileLock(
        lock,
        async () => {
          const current = await this.readAddressCore(address);
          let next: string | undefined;
          try {
            next = await mutate(current);
          } catch {
            throw new VaultError('MUTATION_FAILED');
          }
          if (next === undefined) return current;
          this.validateSecret(next);
          await this.writeAddressCore(address, next);
          return next;
        },
        { waitMs: 30_000, ...(signal ? { signal } : {}) },
      );
    });
  }
  deleteAddress(address: VaultAddress): Promise<boolean> {
    return this.run(async () => {
      address = this.validateAddress(address);
      const lock = join(
        this.directory,
        `entry-${createHash('sha256').update(`${address.space}:${address.key}`).digest('hex')}`,
      );
      return withFileLock(
        lock,
        () =>
          this.exclusive(async () => {
            const entries = await this.metadata();
            const entry = entries.find((entry) => this.sameAddress(entry.address, address));
            if (!entry) return false;
            await this.commit({
              version: 1,
              metadata: entries.filter((item) => item.ref !== entry.ref),
              remove: entry.ref,
            });
            return true;
          }),
        { waitMs: 30_000 },
      );
    });
  }
  private readAddressCore(address: VaultAddress): Promise<string | undefined> {
    return this.exclusive(async () => {
      const entry = (await this.metadata()).find((entry) =>
        this.sameAddress(entry.address, address),
      );
      return entry ? this.decrypt(entry.ref) : undefined;
    });
  }
  private async writeAddressCore(address: VaultAddress, secret: string): Promise<void> {
    await this.exclusive(async () => {
      const entries = await this.metadata();
      const index = entries.findIndex((entry) => this.sameAddress(entry.address, address));
      const now = new Date().toISOString();
      const entry: VaultMetadata =
        index >= 0
          ? { ...entries[index]!, updatedAt: now }
          : {
              ref: `cred_${randomUUID()}`,
              kind: `axterm-${address.space}`,
              label: address.key,
              createdAt: now,
              updatedAt: now,
              storage: 'local',
              address,
            };
      if (index >= 0) entries[index] = entry;
      else entries.push(entry);
      await this.commit({
        version: 1,
        metadata: entries,
        write: { ref: entry.ref, payload: this.encrypt(entry.ref, secret) },
      });
    });
  }
  private sameAddress(left: VaultAddress | undefined, right: VaultAddress): boolean {
    return left?.space === right.space && left.key === right.key;
  }
  private validateAddress(address: VaultAddress): VaultAddress {
    const parsed = addressSchema.safeParse(address);
    if (!parsed.success) throw new VaultError('INVALID');
    return parsed.data;
  }
  private validateRef(ref: string): void {
    if (!reference.safeParse(ref).success) throw new VaultError('INVALID');
  }
  private validateSecret(secret: string): void {
    if (
      typeof secret !== 'string' ||
      !secret ||
      Buffer.byteLength(secret) > MAX_SECRET_BYTES ||
      Buffer.from(secret, 'utf8').toString('utf8') !== secret
    )
      throw new VaultError('INVALID');
  }
  private requireKey(): Buffer {
    if (!this.masterKey) throw new VaultError('CLOSED');
    return this.masterKey;
  }
  private encrypt(ref: string, secret: string): Payload {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.requireKey(), nonce);
    cipher.setAAD(Buffer.from(ref, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return {
      version: 1,
      algorithm: 'aes-256-gcm',
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }
  private async decrypt(ref: string): Promise<string> {
    try {
      const payload = parse(payloadSchema, await readBounded(join(this.directory, `${ref}.bin`)));
      return this.decryptPayload(ref, payload);
    } catch {
      throw new VaultError('CORRUPT');
    }
  }
  private decryptPayload(ref: string, payload: Payload): string {
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.requireKey(),
        decode64(payload.nonce, 12),
      );
      decipher.setAAD(Buffer.from(ref, 'utf8'));
      decipher.setAuthTag(decode64(payload.tag, 16));
      const secret = Buffer.concat([
        decipher.update(decode64(payload.ciphertext)),
        decipher.final(),
      ]).toString('utf8');
      this.validateSecret(secret);
      return secret;
    } catch {
      throw new VaultError('CORRUPT');
    }
  }
  private async metadata(): Promise<VaultMetadata[]> {
    try {
      return parse(metadataListSchema, await readBounded(join(this.directory, 'metadata.json')));
    } catch (error) {
      if (missing(error)) {
        const files = await readdir(this.directory);
        if (files.some((file) => file.endsWith('.bin')) && !files.includes('commit.json'))
          throw new VaultError('CORRUPT');
        return [];
      }
      throw error;
    }
  }
  private async commit(journal: Journal): Promise<void> {
    if (!journalSchema.safeParse(journal).success) throw new VaultError('INVALID');
    const content = JSON.stringify(journal);
    if (Buffer.byteLength(content) > MAX_MEDIA_BYTES) throw new VaultError('INVALID');
    await durableReplace(join(this.directory, 'commit.json'), content);
    await this.syncDirectory();
    await this.recover();
  }
  private async recover(): Promise<void> {
    let journal: Journal;
    try {
      journal = parse(journalSchema, await readBounded(join(this.directory, 'commit.json')));
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    if (journal.write) {
      // Validate the encrypted envelope fully before changing either committed file.
      this.decryptPayload(journal.write.ref, journal.write.payload);
      await durableReplace(
        join(this.directory, `${journal.write.ref}.bin`),
        JSON.stringify(journal.write.payload),
      );
    }
    await durableReplace(join(this.directory, 'metadata.json'), JSON.stringify(journal.metadata));
    if (journal.remove)
      await unlink(join(this.directory, `${journal.remove}.bin`)).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    await this.syncDirectory();
    await unlink(join(this.directory, 'commit.json'));
    await this.syncDirectory();
  }
  private async syncDirectory(): Promise<void> {
    // Windows directory handles cannot be fsynced through node:fs. Atomic replacement
    // and the replayable commit journal remain active; native validation stays separate.
    if (process.platform === 'win32') return;
    const handle = await open(this.directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  private exclusive<T>(operation: () => Promise<T>, recover = true): Promise<T> {
    return withFileLock(
      join(this.directory, 'writer'),
      async () => {
        if (recover) {
          this.requireKey();
          await this.recover();
        }
        return operation();
      },
      { waitMs: 30_000 },
    );
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new VaultError('CLOSED'));
    const ready = this.opening;
    if (!ready) return Promise.reject(new VaultError('CLOSED'));
    return this.operation(async () => {
      await ready;
      return operation();
    });
  }
  private operation<T>(operation: () => Promise<T>): Promise<T> {
    const task = operation().catch((error: unknown) => {
      throw error instanceof VaultError ? error : new VaultError('IO');
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
}
