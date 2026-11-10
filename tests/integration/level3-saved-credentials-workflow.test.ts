import { Context } from '@deepseek-ai/cordis';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import Storage from '@axterm/infra-storage';
import * as Schema from '@axterm/data-schema';
import * as Relational from '@axterm/infra-storage-relational';
import * as Domains from '@axterm/infra-storage-domain';
import { LocalVaultCredentials } from '@axterm/infra-credential-vault';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import { SavedCredentialStorageError } from '@axterm/plugin-api/saved-credentials';
import type { SavedCredentialsService } from '@axterm/plugin-api/host';
import { CredentialIntents } from '../../packages/plugins/configuration/src/adapters/credential-intents.ts';
import { SavedCredentialWorkflow } from '../../packages/plugins/configuration/src/application/saved-credentials.ts';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'axterm-saved-intents-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const ctx = new Context();
  cleanup.push(() => ctx.fiber.dispose());
  await ctx.plugin(Storage);
  await ctx.plugin(Schema);
  await ctx.plugin(Relational, { path: join(home, 'product.sqlite'), schema: 'productSchema' });
  await ctx.plugin(Domains, { backend: 'relational' });
  await ctx.plugin(LocalVaultCredentials, { directory: join(home, 'vault') });
  const domain = await ctx.storage.domain.open(Schema.productDomains.configuration);
  cleanup.push(() => domain.close());
  const generation = randomUUID();
  const store = new CredentialIntents(domain, 'fixture', generation);
  let port: SavedCredentialsService | undefined = ctx.credentials.saved;
  const workflow = new SavedCredentialWorkflow(generation, store, () => port);
  cleanup.push(() => workflow.close().catch(() => {}));
  return {
    home,
    ctx,
    domain,
    generation,
    store,
    workflow,
    port: port!,
    setPort(value: SavedCredentialsService | undefined) {
      port = value;
    },
  };
}
it('reserves before Vault IO, persists only non-secret outcomes and refuses a repeated submission even with a different secret', async () => {
  const f = await fixture();
  const commandId = randomUUID();
  const secret = 'PRIVATE_INTENT_SECRET_CANARY';
  const created = await f.workflow.create(commandId, f.generation, {
    kind: 'sshPassword',
    label: 'Fixture connection',
    secret,
  });
  expect(created).toMatchObject({ commandId, status: 'completed', operation: 'create' });
  expect(created.metadata?.ref).toBe(created.ref);
  expect(await f.ctx.credentials.resolve(encodeOpaqueCredentialRef(created.ref))).toEqual({
    value: secret,
    source: 'application-vault',
  });
  expect(() =>
    f.workflow.create(commandId, f.generation, {
      kind: 'sshPassword',
      label: 'Other label',
      secret: 'PRIVATE_DIFFERENT_SECRET',
    }),
  ).toThrow('ALREADY_SUBMITTED');
  expect(await f.workflow.outcome(commandId)).toEqual(created);
  expect(await f.workflow.list()).toEqual([created.metadata]);
  expect(f.workflow.active()).toBe(false);
  const serialized = f.domain.all<{ metadata_json: string; result_json: string }>(
    'SELECT metadata_json,result_json FROM axterm_credential_command_intents',
  );
  expect(JSON.stringify(serialized)).not.toContain('PRIVATE_');
  for (const name of ['product.sqlite', 'product.sqlite-wal']) {
    const bytes = await readFile(join(f.home, name)).catch((error) => {
      if (error.code === 'ENOENT') return Buffer.alloc(0);
      throw error;
    });
    expect(bytes.includes(Buffer.from(secret))).toBe(false);
    expect(bytes.includes(Buffer.from(createHash('sha256').update(secret).digest('hex')))).toBe(
      false,
    );
  }
});
it('rejects a stale generation and unavailable storage before reservation or IO', async () => {
  const f = await fixture();
  const create = vi.spyOn(f.port, 'createAt');
  expect(() =>
    f.workflow.create(randomUUID(), randomUUID(), {
      kind: 'aiApiKey',
      label: 'Model',
      secret: 'PRIVATE_STALE',
    }),
  ).toThrow('STALE_GENERATION');
  expect(create).not.toHaveBeenCalled();
  f.setPort(undefined);
  expect(() =>
    f.workflow.create(randomUUID(), f.generation, {
      kind: 'aiApiKey',
      label: 'Model',
      secret: 'PRIVATE_MISSING',
    }),
  ).toThrow('UNAVAILABLE');
  expect(
    f.domain.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM axterm_credential_command_intents',
    )?.count,
  ).toBe(0);
});
it('reconciles a committed create after a lost response by reading its marker, without submitting the secret again', async () => {
  const f = await fixture();
  const original = f.port;
  const create = vi.fn(async (...args: Parameters<SavedCredentialsService['createAt']>) => {
    await original.createAt(...args);
    throw new SavedCredentialStorageError('unavailable');
  });
  f.setPort({ ...original, createAt: create });
  const id = randomUUID();
  const uncertain = await f.workflow.create(id, f.generation, {
    kind: 'aiApiKey',
    label: 'Model',
    secret: 'PRIVATE_UNCERTAIN_CREATE',
  });
  expect(uncertain.status).toBe('uncertain');
  expect(f.workflow.active()).toBe(true);
  const outcomes = await Promise.all([f.workflow.outcome(id), f.workflow.outcome(id)]);
  expect(outcomes.map((result) => result.status)).toEqual(['completed', 'completed']);
  expect(create).toHaveBeenCalledOnce();
  expect(f.workflow.active()).toBe(false);
  expect(await f.ctx.credentials.resolve(encodeOpaqueCredentialRef(uncertain.ref))).toMatchObject({
    value: 'PRIVATE_UNCERTAIN_CREATE',
  });
});
it('recovers a database outcome failure without replay and does not interrupt another Profile', async () => {
  const f = await fixture();
  const append = f.domain.appendEvent.bind(f.domain);
  let fail = true;
  vi.spyOn(f.domain, 'appendEvent').mockImplementation((type, payload) => {
    if (type === 'configuration/credential-command-finished' && fail) {
      fail = false;
      throw new Error('Injected receipt failure');
    }
    return append(type, payload);
  });
  const id = randomUUID();
  await expect(
    f.workflow.create(id, f.generation, {
      kind: 'aiApiKey',
      label: 'Model',
      secret: 'PRIVATE_DB_OUTCOME',
    }),
  ).rejects.toThrow('UNCERTAIN');
  expect(f.store.get(id)?.status).toBe('running');
  new CredentialIntents(f.domain, 'another-profile', randomUUID());
  expect(f.store.get(id)?.status).toBe('running');
  expect((await f.workflow.outcome(id)).status).toBe('completed');
  expect(f.workflow.active()).toBe(false);
  const row = f.store.get(id)!;
  expect(await f.ctx.credentials.resolve(encodeOpaqueCredentialRef(row.ref))).toMatchObject({
    value: 'PRIVATE_DB_OUTCOME',
  });
});
it('joins an accepted write on unload and fails closed for an unprovable delete outcome', async () => {
  const f = await fixture();
  const created = await f.workflow.create(randomUUID(), f.generation, {
    kind: 'sshPassword',
    label: 'Connection',
    secret: 'PRIVATE_TO_DELETE',
  });
  const original = f.port;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.setPort({
    ...original,
    replace: async (...args) => {
      entered.resolve();
      await release.promise;
      return original.replace(...args);
    },
  });
  const replace = f.workflow.replace(randomUUID(), f.generation, created.ref, 'PRIVATE_DRAINED');
  await entered.promise;
  let ended = false;
  const closing = f.workflow.close().then(() => {
    ended = true;
  });
  expect(ended).toBe(false);
  expect(() => f.workflow.remove(randomUUID(), f.generation, created.ref)).toThrow('CLOSED');
  release.resolve();
  expect((await replace).status).toBe('completed');
  await closing;
  const next = new SavedCredentialWorkflow(f.generation, f.store, () => ({
    ...original,
    remove: async (ref) => {
      await original.remove(ref);
      throw new SavedCredentialStorageError('unavailable');
    },
  }));
  cleanup.push(() => next.close().catch(() => {}));
  const id = randomUUID();
  expect((await next.remove(id, f.generation, created.ref)).status).toBe('uncertain');
  expect((await next.outcome(id)).status).toBe('uncertain');
  await expect(next.close()).rejects.toThrow('UNCERTAIN');
  expect(await original.inspect(created.ref)).toBeUndefined();
});
it('marks interrupted intents without writing Vault or replaying secrets after HMR/restart', async () => {
  const f = await fixture();
  const id = randomUUID();
  const ref = 'cred_' + randomUUID();
  f.store.reserve(id, 'create', ref, { kind: 'aiApiKey', label: 'Interrupted' });
  const create = vi.spyOn(f.port, 'createAt');
  const next = new CredentialIntents(f.domain, 'fixture', f.generation);
  expect(next.get(id)?.status).toBe('interrupted');
  const workflow = new SavedCredentialWorkflow(f.generation, next, () => f.port);
  cleanup.push(() => workflow.close());
  expect((await workflow.outcome(id)).status).toBe('interrupted');
  expect(create).not.toHaveBeenCalled();
  expect(await f.port.inspect(ref)).toBeUndefined();
  expect(() =>
    workflow.create(id, f.generation, {
      kind: 'aiApiKey',
      label: 'Retry',
      secret: 'PRIVATE_REPLAY',
    }),
  ).toThrow('ALREADY_SUBMITTED');
});

it('drains an admitted readonly reconciliation before allowing its intent storage to close', async () => {
  const f = await fixture();
  const create = f.port.createAt.bind(f.port);
  f.setPort({
    ...f.port,
    async createAt(...args) {
      await create(...args);
      throw new SavedCredentialStorageError('unavailable');
    },
  });
  const commandId = randomUUID();
  await f.workflow.create(commandId, f.generation, {
    kind: 'sshPassword',
    label: 'Drain proof',
    secret: 'DRAIN_SECRET',
  });
  const inspect = f.port.inspect.bind(f.port);
  const release = Promise.withResolvers<void>();
  f.setPort({
    ...f.port,
    async inspect(ref) {
      await release.promise;
      return inspect(ref);
    },
  });
  const read = f.workflow.outcome(commandId);
  let closed = false;
  const ending = f.workflow.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release.resolve();
  expect((await read).status).toBe('completed');
  await ending;
  expect(closed).toBe(true);
});

it('reserves granted-key intent before reading, writes only to Vault and reconciles without reading again', async () => {
  const f = await fixture(),
    id = randomUUID(),
    grantId = 'PRIVATE_SELECTED_GRANT_CANARY',
    secret = 'PRIVATE_GRANTED_KEY_CANARY';
  const reader = vi.fn(async (source: string, max: number, signal: AbortSignal) => {
    expect(f.store.get(id)?.status).toBe('running');
    expect(source).toBe(grantId);
    expect(max).toBe(131072);
    expect(signal.aborted).toBe(false);
    return secret;
  });
  const result = await f.workflow.createFromGrant(
    id,
    f.generation,
    { kind: 'privateKey', label: 'Selected key', grantId },
    reader,
  );
  expect(result.status).toBe('completed');
  expect(reader).toHaveBeenCalledTimes(1);
  expect(await f.ctx.credentials.resolve(encodeOpaqueCredentialRef(result.ref))).toMatchObject({
    value: secret,
  });
  expect(await f.workflow.outcome(id)).toEqual(result);
  expect(reader).toHaveBeenCalledTimes(1);
  expect(() =>
    f.workflow.createFromGrant(
      id,
      f.generation,
      { kind: 'privateKey', label: 'Changed', grantId },
      reader,
    ),
  ).toThrow('ALREADY_SUBMITTED');
  const rows = f.domain.all<{ metadata_json: string; result_json: string }>(
    'SELECT metadata_json,result_json FROM axterm_credential_command_intents',
  );
  expect(JSON.stringify(rows)).not.toContain(secret);
  expect(JSON.stringify(rows)).not.toContain(grantId);
  for (const name of ['product.sqlite', 'product.sqlite-wal'])
    expect(
      (await readFile(join(f.home, name)).catch(() => Buffer.alloc(0))).includes(
        Buffer.from(secret),
      ),
    ).toBe(false);
});
it('does not read stale, already-canceled or closed granted-key commands', async () => {
  const f = await fixture(),
    reader = vi.fn(async () => 'PRIVATE_NEVER_READ'),
    create = vi.spyOn(f.port, 'createAt');
  expect(() =>
    f.workflow.createFromGrant(
      randomUUID(),
      randomUUID(),
      { kind: 'privateKey', label: 'Key', grantId: 'opaque' },
      reader,
    ),
  ).toThrow('STALE_GENERATION');
  const aborted = new AbortController();
  aborted.abort();
  expect(() =>
    f.workflow.createFromGrant(
      randomUUID(),
      f.generation,
      { kind: 'privateKey', label: 'Key', grantId: 'opaque' },
      reader,
      aborted.signal,
    ),
  ).toThrow('CLOSED');
  await f.workflow.close();
  expect(() =>
    f.workflow.createFromGrant(
      randomUUID(),
      f.generation,
      { kind: 'privateKey', label: 'Key', grantId: 'opaque' },
      reader,
    ),
  ).toThrow('CLOSED');
  expect(reader).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
it('records definite read and UTF-8 byte-limit failures before Vault IO without quarantining a nonexistent mutation', async () => {
  const f = await fixture(),
    create = vi.spyOn(f.port, 'createAt');
  for (const read of [
    async () => {
      throw new Error('PRIVATE_FILE_PATH_CANARY');
    },
    async () => 'é'.repeat(70000),
  ]) {
    const id = randomUUID();
    const receipt = await f.workflow.createFromGrant(
      id,
      f.generation,
      { kind: 'sshCertificate', label: 'Certificate', grantId: 'opaque' },
      read,
    );
    expect(receipt).toMatchObject({ status: 'failed', reason: 'invalid-input' });
    expect(await f.workflow.outcome(id)).toEqual(receipt);
  }
  expect(create).not.toHaveBeenCalled();
  expect(f.workflow.active()).toBe(false);
  await expect(f.workflow.close()).resolves.toBeUndefined();
});
it('aborts a granted-file reader and waits for its actual late completion before closing without Vault IO', async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    create = vi.spyOn(f.port, 'createAt');
  let signal: AbortSignal | undefined,
    drained = false;
  const pending = f.workflow.createFromGrant(
    randomUUID(),
    f.generation,
    { kind: 'privateKey', label: 'Key', grantId: 'opaque' },
    async (_grant, _max, current) => {
      signal = current;
      entered.resolve();
      try {
        await release.promise;
        return 'PRIVATE_LATE_READ';
      } finally {
        drained = true;
      }
    },
  );
  await entered.promise;
  let closed = false;
  const closing = f.workflow.close().then(() => {
    closed = true;
  });
  expect(signal?.aborted).toBe(true);
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(drained).toBe(false);
  release.resolve();
  expect(await pending).toMatchObject({ status: 'failed', reason: 'closed' });
  await closing;
  expect(drained).toBe(true);
  expect(create).not.toHaveBeenCalled();
  expect(f.workflow.active()).toBe(false);
});
it('drains an already admitted granted-key Vault mutation and preserves the committed outcome after cancellation', async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    original = f.port;
  let written = false;
  f.setPort({
    ...original,
    createAt: async (...args) => {
      const result = await original.createAt(...args);
      written = true;
      entered.resolve();
      await release.promise;
      return result;
    },
  });
  const id = randomUUID(),
    reader = vi.fn(async () => 'PRIVATE_ADMITTED_FILE_KEY');
  const pending = f.workflow.createFromGrant(
    id,
    f.generation,
    { kind: 'privateKey', label: 'Key', grantId: 'opaque' },
    reader,
  );
  await entered.promise;
  let closed = false;
  const closing = f.workflow.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(written).toBe(true);
  release.resolve();
  const receipt = await pending;
  expect(receipt.status).toBe('completed');
  await closing;
  expect((await original.inspect(receipt.ref))?.mutation).toMatchObject({
    generation: f.generation,
    commandId: id,
  });
  expect(reader).toHaveBeenCalledTimes(1);
});
it('removes only the unchanged owned temporary MCP credential under the Vault write lock', async () => {
  const f = await fixture(),
    createdBy = { generation: f.generation, commandId: randomUUID() };
  const created = await f.workflow.create(createdBy.commandId, f.generation, {
    kind: 'mcpApiKey',
    label: 'Widget token',
    secret: 'temporary-widget-token',
  });
  const { TemporaryCredentialCleanup } =
    await import('../../packages/plugins/configuration/src/application/temporary-credentials.ts');
  const owner = new TemporaryCredentialCleanup(f.generation, f.workflow, () => f.port);
  const replacement = { generation: f.generation, commandId: randomUUID() };
  await f.port.replace(created.ref, 'user-replaced-token', replacement);
  await owner.removeOwned(randomUUID(), f.generation, created.ref, createdBy);
  expect((await f.port.inspect(created.ref))?.mutation).toEqual(replacement);
  const fresh = await f.workflow.create(randomUUID(), f.generation, {
    kind: 'mcpApiKey',
    label: 'Unchanged token',
    secret: 'temporary-widget-token-2',
  });
  await owner.removeOwned(randomUUID(), f.generation, fresh.ref, {
    generation: f.generation,
    commandId: fresh.commandId,
  });
  expect(await f.port.inspect(fresh.ref)).toBeUndefined();
  await expect(
    owner.removeOwned(randomUUID(), randomUUID(), created.ref, createdBy),
  ).rejects.toThrow();
  await owner.close();
});
