import { afterEach, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, readFile, writeFile, readdir, rm, stat, unlink, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { createDecipheriv, randomUUID } from 'node:crypto';
import { LocalVaultCredentials, EncryptedVault, VaultError } from '../src/index.ts';
import { credentialRef, credentialKey, encodeOpaqueCredentialRef } from '@axterm/infra-credentials';
import { Generation2Vault as PreviousVault } from '../../../../tests/fixtures/migration/generation2-vault.ts';
import { metadataSchema } from '../src/vault.ts';
import { savedCredentialMetadataSchema } from '@axterm/plugin-api/saved-credentials';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'axterm-level3-vault-'));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function openVault(path: string): Promise<EncryptedVault> {
  const vault = new EncryptedVault(path);
  cleanups.push(() => vault.close());
  await vault.open();
  return vault;
}
async function provider(
  path: string,
): Promise<{ ctx: Context; owner: ReturnType<Context['plugin']> }> {
  const ctx = new Context();
  cleanups.push(() => ctx.fiber.dispose());
  const owner = ctx.plugin(LocalVaultCredentials, { directory: path });
  await owner;
  return { ctx, owner };
}
it('reads copied current ciphertext and preserves key, identifier and AAD across replacement', async () => {
  const source = await directory();
  const previous = new PreviousVault(source);
  await previous.open();
  const metadata = await previous.put({
    kind: 'password',
    label: 'SSH',
    secret: 'original-secret',
  });
  previous.close();
  const target = await directory();
  await cp(source, target, { recursive: true });
  const sourceKey = await readFile(join(source, 'master.key'));
  const sourceCipher = await readFile(join(source, `${metadata.ref}.bin`));
  const vault = await openVault(target);
  expect(await vault.list()).toEqual([metadata]);
  expect(await vault.get(metadata.ref)).toBe('original-secret');
  const { ctx } = await provider(target);
  const ref = encodeOpaqueCredentialRef(metadata.ref);
  expect(await ctx.credentials.resolve(ref)).toEqual({
    value: 'original-secret',
    source: 'application-vault',
  });
  await ctx.credentials.set(ref, 'replacement-secret');
  expect(await vault.get(metadata.ref)).toBe('replacement-secret');
  expect(await readFile(join(target, 'master.key'))).toEqual(sourceKey);
  expect(await readFile(join(source, `${metadata.ref}.bin`))).toEqual(sourceCipher);
  // An independent legacy-format decrypt proves that the reference is still the original AAD.
  const envelope = JSON.parse(await readFile(join(target, `${metadata.ref}.bin`), 'utf8'));
  const decipher = createDecipheriv(
    'aes-256-gcm',
    sourceKey,
    Buffer.from(envelope.nonce, 'base64'),
  );
  decipher.setAAD(Buffer.from(metadata.ref));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  expect(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString(),
  ).toBe('replacement-secret');
});
it('uses owner-only files, hides internal addresses and never persists plaintext', async () => {
  const path = await directory();
  const vault = await openVault(path);
  const entry = await vault.put({ kind: 'token', label: 'token', secret: 'private-value-unique' });
  await vault.modifyAddress(
    { space: 'reference', key: 'API_KEY' },
    async () => 'private-value-unique',
  );
  expect(await vault.list()).toEqual([entry]);
  expect((await stat(path)).mode & 0o777).toBe(0o700);
  for (const file of await readdir(path)) {
    expect((await stat(join(path, file))).mode & 0o777).toBe(0o600);
    expect((await readFile(join(path, file))).includes(Buffer.from('private-value-unique'))).toBe(
      false,
    );
  }
  const reopened = await openVault(path);
  expect(await reopened.get(entry.ref)).toBe('private-value-unique');
});
it('rejects corrupt metadata and missing or malformed master keys without regenerating existing media', async () => {
  for (const failure of ['metadata', 'missing-key', 'bad-key'] as const) {
    const path = await directory();
    const vault = await openVault(path);
    const entry = await vault.put({ kind: 'password', label: 'SSH', secret: 'retain-me' });
    await vault.close();
    const ciphertext = await readFile(join(path, `${entry.ref}.bin`));
    if (failure === 'metadata')
      await writeFile(join(path, 'metadata.json'), '[{"secret":"do-not-log-this"}]');
    if (failure === 'missing-key') await unlink(join(path, 'master.key'));
    if (failure === 'bad-key') await writeFile(join(path, 'master.key'), 'bad-key');
    const candidate = new EncryptedVault(path);
    cleanups.push(() => candidate.close());
    const error = await candidate.open().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(VaultError);
    expect(String(error)).not.toContain('do-not-log-this');
    expect(await readFile(join(path, `${entry.ref}.bin`))).toEqual(ciphertext);
    if (failure === 'missing-key')
      await expect(readFile(join(path, 'master.key'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (failure === 'bad-key')
      expect(await readFile(join(path, 'master.key'), 'utf8')).toBe('bad-key');
  }
});
it('reports tampered, missing and invalid-base64 ciphertext with bounded redacted errors', async () => {
  const path = await directory();
  const vault = await openVault(path);
  const entry = await vault.put({ kind: 'password', label: 'test', secret: 'do-not-log-secret' });
  const filename = join(path, `${entry.ref}.bin`);
  const payload = JSON.parse(await readFile(filename, 'utf8'));
  await writeFile(
    filename,
    JSON.stringify({ ...payload, tag: Buffer.alloc(16).toString('base64') }),
  );
  await expect(vault.get(entry.ref)).rejects.toThrow('VAULT_CORRUPT');
  await writeFile(filename, JSON.stringify({ ...payload, nonce: payload.nonce + '?' }));
  await expect(vault.get(entry.ref)).rejects.toThrow('VAULT_CORRUPT');
  await unlink(filename);
  await expect(vault.get(entry.ref)).rejects.toThrow('VAULT_CORRUPT');
  await expect(vault.get('../master.key')).rejects.toThrow('VAULT_INVALID');
});
it('replays a durable encrypted commit journal after interruption and contains no plaintext in the journal', async () => {
  const path = await directory();
  const vault = await openVault(path);
  const original = await vault.put({ kind: 'password', label: 'one', secret: 'original' });
  const initialMetadata = await readFile(join(path, 'metadata.json'));
  const initialPayload = await readFile(join(path, `${original.ref}.bin`));
  await vault.replace(original.ref, 'after-interruption');
  const metadata = JSON.parse(await readFile(join(path, 'metadata.json'), 'utf8'));
  const payload = JSON.parse(await readFile(join(path, `${original.ref}.bin`), 'utf8'));
  await vault.close();
  await writeFile(join(path, 'metadata.json'), initialMetadata);
  await writeFile(join(path, `${original.ref}.bin`), initialPayload);
  const journal = JSON.stringify({ version: 1, metadata, write: { ref: original.ref, payload } });
  expect(journal).not.toContain('after-interruption');
  await writeFile(join(path, 'commit.json'), journal, { mode: 0o600 });
  const reopened = await openVault(path);
  expect(await reopened.get(original.ref)).toBe('after-interruption');
  await expect(readFile(join(path, 'commit.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  // A deletion interrupted after metadata commit also replays idempotently.
  await reopened.close();
  await writeFile(join(path, 'metadata.json'), '[]');
  await writeFile(
    join(path, 'commit.json'),
    JSON.stringify({ version: 1, metadata: [], remove: original.ref }),
  );
  const deleted = await openVault(path);
  expect(await deleted.list()).toEqual([]);
  await expect(readFile(join(path, `${original.ref}.bin`))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
it('coordinates writers from two Profiles and performs record refresh under one address lease', async () => {
  const path = await directory();
  const first = await provider(path);
  const second = await provider(path);
  const key = credentialKey('engine-pi', 'provider');
  await first.ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: 0 }));
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      (i % 2 ? first : second).ctx.credentials.modifyRecord(key, async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          kind: 'grant',
          payload: (current?.kind === 'grant' ? Number(current.payload) : 0) + 1,
        };
      }),
    ),
  );
  expect(await first.ctx.credentials.readRecord(key)).toEqual({ kind: 'grant', payload: 8 });
  await Promise.all([
    first.ctx.credentials.set(credentialRef('ONE'), 'one'),
    second.ctx.credentials.set(credentialRef('TWO'), 'two'),
  ]);
  expect(await second.ctx.credentials.resolve(credentialRef('ONE'))).toMatchObject({
    value: 'one',
  });
  expect(await first.ctx.credentials.resolve(credentialRef('TWO'))).toMatchObject({ value: 'two' });
});
it('supports nested reference resolution during a record mutation and preserves explicit empty records without ambient discovery', async () => {
  const path = await directory();
  const { ctx } = await provider(path);
  const ref = credentialRef('PATH');
  expect(await ctx.credentials.resolve(ref)).toBeUndefined();
  const key = credentialKey('engine-pi', 'empty');
  await ctx.credentials.modifyRecord(key, async () => {
    expect(await ctx.credentials.resolve(ref)).toBeUndefined();
    return { kind: 'api-key' };
  });
  expect(await ctx.credentials.describeRecord(key)).toEqual({
    configured: true,
    kind: 'api-key',
    writable: true,
  });
  expect(await ctx.credentials.listRecords()).toEqual([{ key, kind: 'api-key' }]);
  await ctx.credentials.modifyRecord(key, async () => undefined);
  expect(await ctx.credentials.readRecord(key)).toEqual({ kind: 'api-key' });
  await ctx.credentials.deleteRecord(key);
  expect(await ctx.credentials.readRecord(key)).toBeUndefined();
});
it('drains admitted mutations on provider unload and revokes cached service and Vault references', async () => {
  const path = await directory();
  const { ctx, owner } = await provider(path);
  const credentials = ctx.credentials;
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const key = credentialKey('engine-pi', 'drain');
  const change = credentials.modifyRecord(key, async () => {
    started();
    await wait;
    return { kind: 'grant', payload: 'committed' };
  });
  await entered;
  let closed = false;
  const closing = owner.dispose().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(closed).toBe(false);
  await expect(credentials.resolve(credentialRef('KEY'))).rejects.toThrow('VAULT_CLOSED');
  release();
  await change;
  await closing;
  expect(ctx.get('credentials')).toBeUndefined();
  const next = await provider(path);
  expect(await next.ctx.credentials.readRecord(key)).toEqual({
    kind: 'grant',
    payload: 'committed',
  });
  const vault = await openVault(path);
  await vault.close();
  await expect(vault.open()).rejects.toThrow('VAULT_CLOSED');
  await expect(vault.list()).rejects.toThrow('VAULT_CLOSED');
});
it('publishes only durable changes and contains observer failures and rejected record mutations', async () => {
  const path = await directory();
  const { ctx } = await provider(path);
  const ref = credentialRef('API_KEY');
  const key = credentialKey('engine-pi', 'token');
  let notifications = 0;
  ctx.on('credentials/reference-updated', () => {
    notifications++;
    throw new Error('observer-private-error');
  });
  ctx.on('credentials/record-updated', async () => {
    throw new Error('observer-private-error');
  });
  await ctx.credentials.set(ref, 'stored');
  expect(notifications).toBe(1);
  await ctx.credentials.modifyRecord(key, async () => ({
    kind: 'grant',
    payload: { token: 'saved' },
  }));
  await expect(
    ctx.credentials.modifyRecord(key, async () => {
      throw new Error('mutation-private-error');
    }),
  ).rejects.toThrow('VAULT_MUTATION_FAILED');
  expect(await ctx.credentials.readRecord(key)).toEqual({
    kind: 'grant',
    payload: { token: 'saved' },
  });
  await expect(ctx.credentials.set(ref, '')).rejects.toThrow('VAULT_INVALID');
  expect(notifications).toBe(1);
});
it('serializes actual external-process mutations against the same encrypted media', async () => {
  const path = await directory();
  const vault = await openVault(path);
  const address = { space: 'record' as const, key: 'engine-pi/shared' };
  await vault.modifyAddress(address, async () => '0');
  // The child runs the actual compiled package, with no Vitest aliases or TypeScript loader.
  const script = join(path, 'writer.mjs');
  const source = new URL('../lib/index.js', import.meta.url).href;
  await writeFile(
    script,
    `import { EncryptedVault } from ${JSON.stringify(source)};\nconst v = new EncryptedVault(process.argv[2]); await v.open();\nfor (let i=0;i<4;i++) await v.modifyAddress({space:'record',key:'engine-pi/shared'}, async n => {await new Promise(r=>setTimeout(r,5));return String(Number(n)+1)});\nawait v.close();\n`,
  );
  const run = () =>
    new Promise<void>((resolve, reject) => {
      const child = fork(script, [path], {
        execArgv: [],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('Vault writer child failed')),
      );
    });
  // Packaged source's dependencies are actual node_modules links, not Vitest's alias mapping.
  await Promise.all([run(), run()]);
  expect(await vault.readAddress(address)).toBe('8');
});
it('rejects an unauthenticated recovery envelope before changing existing ciphertext or metadata', async () => {
  const path = await directory();
  const vault = await openVault(path);
  const entry = await vault.put({ kind: 'password', label: 'one', secret: 'must-survive' });
  const metadata = await readFile(join(path, 'metadata.json'));
  const ciphertext = await readFile(join(path, `${entry.ref}.bin`));
  const payload = JSON.parse(ciphertext.toString());
  await vault.close();
  await writeFile(
    join(path, 'commit.json'),
    JSON.stringify({
      version: 1,
      metadata: JSON.parse(metadata.toString()),
      write: { ref: entry.ref, payload: { ...payload, tag: Buffer.alloc(16).toString('base64') } },
    }),
  );
  const candidate = new EncryptedVault(path);
  cleanups.push(() => candidate.close());
  await expect(candidate.open()).rejects.toThrow('VAULT_CORRUPT');
  expect(await readFile(join(path, 'metadata.json'))).toEqual(metadata);
  expect(await readFile(join(path, `${entry.ref}.bin`))).toEqual(ciphertext);
});
it('rejects missing metadata with existing ciphertext and oversized secret input', async () => {
  const path = await directory();
  const vault = await openVault(path);
  const entry = await vault.put({ kind: 'password', label: 'one', secret: 'must-survive' });
  const original = await readFile(join(path, `${entry.ref}.bin`));
  await expect(vault.replace(entry.ref, 'x'.repeat(4 * 1024 * 1024 + 1))).rejects.toThrow(
    'VAULT_INVALID',
  );
  await expect(vault.replace(entry.ref, '\ud800')).rejects.toThrow('VAULT_INVALID');
  expect(await readFile(join(path, `${entry.ref}.bin`))).toEqual(original);
  await vault.close();
  await unlink(join(path, 'metadata.json'));
  const candidate = new EncryptedVault(path);
  cleanups.push(() => candidate.close());
  await expect(candidate.open()).rejects.toThrow('VAULT_CORRUPT');
});
it('coordinates first-time master key creation and drains an open racing close', async () => {
  const path = await directory();
  const a = new EncryptedVault(path);
  const b = new EncryptedVault(path);
  cleanups.push(
    () => a.close(),
    () => b.close(),
  );
  await Promise.all([a.open(), b.open()]);
  const [one, two] = await Promise.all([
    a.put({ kind: 'one', label: '', secret: 'one' }),
    b.put({ kind: 'two', label: '', secret: 'two' }),
  ]);
  expect(await a.get(two.ref)).toBe('two');
  expect(await b.get(one.ref)).toBe('one');
  const next = new EncryptedVault(await directory());
  const opening = next.open();
  const closing = next.close();
  await opening;
  await closing;
  await expect(next.list()).rejects.toThrow('VAULT_CLOSED');
});

it('publishes a preallocated credential once, records only mutation identity and clears stale proof on an unmanaged replacement', async () => {
  const { randomUUID, createHash } = await import('node:crypto');
  const path = await directory();
  const vault = await openVault(path);
  const ref = 'cred_' + randomUUID();
  const mutation = { generation: randomUUID(), commandId: randomUUID() };
  const secret = 'PRIVATE_MANAGED_CREDENTIAL_CANARY';
  const created = await vault.createAt(
    ref,
    { kind: 'sshPassword', label: 'Managed fixture', secret },
    mutation,
  );
  expect(created.ref).toBe(ref);
  expect(created.mutation).toEqual(mutation);
  expect(await vault.get(ref)).toBe(secret);
  await expect(
    vault.createAt(ref, { kind: 'sshPassword', label: 'collision', secret: 'different' }, mutation),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await vault.get(ref)).toBe(secret);
  const replaced = await vault.replaceManaged(ref, 'PRIVATE_REPLACED_CREDENTIAL_CANARY', {
    ...mutation,
    commandId: randomUUID(),
  });
  expect(replaced.mutation?.commandId).not.toBe(mutation.commandId);
  await vault.replace(ref, 'PRIVATE_UNMANAGED_CREDENTIAL_CANARY');
  expect((await vault.list())[0]!.mutation).toBeUndefined();
  const serialized = (
    await Promise.all(
      (await readdir(path))
        .filter((name) => name !== 'master.key')
        .map((name) => readFile(join(path, name), 'utf8')),
    )
  ).join('\n');
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain(createHash('sha256').update(secret).digest('hex'));
});

it('exposes a metadata-only saved port, preserves unknown existing kinds and resolves the same stored reference through the canonical seam', async () => {
  const { randomUUID } = await import('node:crypto');
  const path = await directory();
  const physical = await openVault(path);
  await physical.put({
    kind: 'provider-custom-kind',
    label: 'Existing provider record',
    secret: 'PRIVATE_EXISTING',
  });
  const { ctx } = await provider(path);
  const saved = ctx.credentials.saved!;
  expect((await saved.list())[0]!.kind).toBe('provider-custom-kind');
  const ref = 'cred_' + randomUUID();
  const marker = { generation: randomUUID(), commandId: randomUUID() };
  const metadata = await saved.createAt(
    ref,
    { kind: 'aiApiKey', label: 'Model fixture', secret: 'PRIVATE_SAVED_PORT' },
    marker,
  );
  expect(metadata).not.toHaveProperty('mutation');
  expect(metadata).not.toHaveProperty('secret');
  expect(await saved.inspect(ref)).toEqual({ metadata, mutation: marker });
  expect(await ctx.credentials.resolve(encodeOpaqueCredentialRef(ref))).toEqual({
    value: 'PRIVATE_SAVED_PORT',
    source: 'application-vault',
  });
  expect(JSON.stringify(await saved.list())).not.toContain('PRIVATE_');
  await saved.replace(ref, 'PRIVATE_UPDATED_PORT', { ...marker, commandId: randomUUID() });
  expect(await physical.get(ref)).toBe('PRIVATE_UPDATED_PORT');
  await saved.remove(ref);
  expect(await saved.inspect(ref)).toBeUndefined();
});

it('coordinates competing managed publications through the shared Vault lock', async () => {
  const { randomUUID } = await import('node:crypto');
  const path = await directory();
  const first = await openVault(path);
  const second = await openVault(path);
  const ref = 'cred_' + randomUUID();
  const outcomes = await Promise.allSettled(
    [first, second].map((vault, index) =>
      vault.createAt(
        ref,
        { kind: 'sshPassword', label: 'Raced fixture', secret: 'PRIVATE_RACE_' + index },
        { generation: randomUUID(), commandId: randomUUID() },
      ),
    ),
  );
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  const failed = outcomes.find((outcome) => outcome.status === 'rejected');
  expect(failed).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT' } });
  expect(await first.list()).toHaveLength(1);
  expect(await second.get(ref)).toMatch(/^PRIVATE_RACE_[01]$/);
});

it('keeps physical and public credential metadata local-only and refuses system-storage records without resolving blobs', async () => {
  const metadata = {
    ref: `cred_${randomUUID()}`,
    kind: 'sshPassword',
    label: 'Fixture',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    storage: 'local' as const,
  };
  expect(metadataSchema.parse(metadata).storage).toBe('local');
  expect(savedCredentialMetadataSchema.parse(metadata).storage).toBe('local');
  for (const storage of ['secure', 'basic', 'session']) {
    expect(metadataSchema.safeParse({ ...metadata, storage }).success).toBe(false);
    expect(savedCredentialMetadataSchema.safeParse({ ...metadata, storage }).success).toBe(false);
    const path = await directory(),
      source = JSON.stringify([{ ...metadata, storage }]);
    await writeFile(join(path, 'metadata.json'), source, { mode: 0o600 });
    await writeFile(join(path, metadata.ref + '.bin'), 'RETAIN_UNRESOLVED_BLOB', { mode: 0o600 });
    const vault = new EncryptedVault(path);
    cleanups.push(() => vault.close());
    await expect(vault.open()).rejects.toThrow('VAULT_CORRUPT');
    expect(await readFile(join(path, 'metadata.json'), 'utf8')).toBe(source);
    expect(await readFile(join(path, metadata.ref + '.bin'), 'utf8')).toBe(
      'RETAIN_UNRESOLVED_BLOB',
    );
    await expect(readFile(join(path, 'master.key'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});
it('re-encrypts replacements and durably deletes public saved references across reopen', async () => {
  const path = await directory(),
    vault = await openVault(path);
  const entry = await vault.put({
    kind: 'aiApiKey',
    label: 'Fixture',
    secret: 'FIRST_FIXTURE_VALUE',
  });
  const before = await readFile(join(path, entry.ref + '.bin'));
  await vault.replace(entry.ref, 'SECOND_FIXTURE_VALUE');
  expect(await vault.get(entry.ref)).toBe('SECOND_FIXTURE_VALUE');
  expect(await readFile(join(path, entry.ref + '.bin'))).not.toEqual(before);
  await vault.delete(entry.ref);
  expect(await vault.list()).toEqual([]);
  await expect(readFile(join(path, entry.ref + '.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  await vault.close();
  const reopened = await openVault(path);
  expect(await reopened.list()).toEqual([]);
});
