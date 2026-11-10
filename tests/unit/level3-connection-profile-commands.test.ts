import { expect, it, vi } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import { connectionProfileSchema, connectionProfileInputSchema } from '@axterm/plugin-api/catalog';
import type { CatalogState } from '../../packages/plugins/catalog/src/client/index.ts';
import {
  ConnectionProfileCommands,
  profileCredentialTargets,
  type ProfileDraft,
} from '../../packages/plugins/catalog/src/client/ui/profiles/commands.ts';
import type {
  SavedCredentialActions,
  CredentialCommandReceipt,
} from '@axterm/plugin-api/saved-credentials';
import type { FileGrantActions } from '@axterm/plugin-api/files';
const secret = 'PROFILE_SECRET_CANARY';
function fixture() {
  let generation = crypto.randomUUID(),
    ready = true;
  const receipts = new Map<string, CredentialCommandReceipt>();
  const create = vi.fn(() => {
    const commandId = crypto.randomUUID();
    const receipt: CredentialCommandReceipt = {
      commandId,
      generation,
      operation: 'create',
      ref: 'cred_' + crypto.randomUUID(),
      status: 'completed',
    };
    receipts.set(commandId, receipt);
    return { commandId, generation, result: Promise.resolve(receipt) };
  });
  const outcome = vi.fn(async (id: string) => receipts.get(id)!);
  const vault = {
    submitCreate: create,
    submitFromGrant: vi.fn(create),
    outcome,
    submitRemove: vi.fn(),
  } as unknown as SavedCredentialActions;
  const commit = vi.fn(async (_key: string, input: unknown) => {
    connectionProfileInputSchema.parse(input);
    expect(JSON.stringify(input)).not.toContain(secret);
    return { ids: ['profile'], cursor: 4 };
  });
  const update = vi.fn(
    async (_key: string, _id: string, input: unknown, _version: string | undefined) =>
      commit(_key, input),
  );
  const remove = vi.fn(async (_key: string, _id: string, _version: string | undefined) => ({
    ids: ['profile'],
    cursor: 5,
  }));
  const model = {
    getSnapshot: () =>
      (ready
        ? { status: 'ready', baseline: { generation } }
        : { status: 'connecting' }) as CatalogState,
    createConnectionProfile: commit,
    updateConnectionProfile: update,
    deleteConnectionProfile: remove,
  };
  const grant = {
    grantId: 'owned-file',
    name: 'key.pem',
    kind: 'file' as const,
    permissions: ['read' as const],
    createdAt: new Date().toISOString(),
  };
  const files = {
    create: vi.fn(async () => grant),
    importFile: vi.fn(async () => grant),
    revoke: vi.fn(async () => {}),
  } as unknown as FileGrantActions;
  const commands = new ConnectionProfileCommands(model, vault, files);
  const draft: ProfileDraft = {
    input: { name: 'Operator' },
    credentials: [
      { field: 'ssh.password', input: { kind: 'sshPassword', label: 'Operator', secret } },
    ],
  };
  const current = connectionProfileSchema.parse({
    ...connectionProfileInputSchema.parse({ name: 'Existing' }),
    id: crypto.randomUUID(),
    version: 7,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return {
    commands,
    model,
    commit,
    update,
    remove,
    create,
    vault,
    files,
    grant,
    receipts,
    draft,
    current,
    setGeneration: () => {
      generation = crypto.randomUUID();
    },
    disconnect: () => {
      ready = false;
    },
  };
}
it('saves all nine credential fields through Configuration and publishes only opaque facts', async () => {
  const f = fixture();
  const published: unknown[] = [];
  f.commands.subscribe(() => published.push(f.commands.getSnapshot()));
  await f.commands.start({
    input: { name: 'All protocols' },
    credentials: profileCredentialTargets.map(([, , field, kind]) => ({
      field,
      input: { kind, label: 'Credentials', secret },
    })),
  });
  expect(f.create).toHaveBeenCalledTimes(9);
  expect(f.commit).toHaveBeenCalledTimes(1);
  expect(f.commands.getSnapshot().status).toBe('completed');
  expect(JSON.stringify(published)).not.toContain(secret);
  expect(f.vault.submitRemove).not.toHaveBeenCalled();
  await f.commands.close();
});
it('reconciles a lost Vault acknowledgment without resubmitting a secret', async () => {
  const f = fixture();
  const create = f.create.getMockImplementation()!;
  f.create.mockImplementationOnce(() => {
    const submission = create();
    return { ...submission, result: Promise.reject(new Error('lost ACK')) };
  });
  await f.commands.start(f.draft);
  expect(f.commands.getSnapshot().status).toBe('uncertain');
  expect(f.commit).not.toHaveBeenCalled();
  await f.commands.retry();
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.vault.outcome).toHaveBeenCalledTimes(1);
  expect(f.commit).toHaveBeenCalledTimes(1);
  await f.commands.close();
});
it('retries a lost Catalog acknowledgment with the same key, payload and captured version', async () => {
  const f = fixture();
  f.update.mockRejectedValueOnce(new Error('lost ACK'));
  await f.commands.start({ ...f.draft, current: f.current });
  expect(f.commands.getSnapshot().status).toBe('uncertain');
  await f.commands.retry();
  expect(f.update).toHaveBeenCalledTimes(2);
  expect(f.update.mock.calls[0]).toEqual(f.update.mock.calls[1]);
  expect(f.update.mock.calls[0]?.[3]).toBe('"v7"');
  expect(f.create).toHaveBeenCalledTimes(1);
  await f.commands.close();
});
it('retains a potentially adopted Vault entry after a definite Catalog failure', async () => {
  const f = fixture();
  f.commit.mockRejectedValueOnce(
    new RemoteError('catalog/failure', 'STALE', { reason: 'precondition-failed' }),
  );
  await f.commands.start(f.draft);
  expect(f.commands.getSnapshot()).toMatchObject({ status: 'failed', retainedCredentials: true });
  expect(f.vault.submitRemove).not.toHaveBeenCalled();
  await f.commands.close();
});
it('retires an uncertain old generation without new Vault or Catalog IO', async () => {
  const f = fixture();
  f.commit.mockRejectedValueOnce(new Error('lost ACK'));
  await f.commands.start(f.draft);
  f.setGeneration();
  await f.commands.retry();
  expect(f.commands.getSnapshot().status).toBe('failed');
  expect(f.commit).toHaveBeenCalledTimes(1);
  expect(f.create).toHaveBeenCalledTimes(1);
  await f.commands.close();
});
it('refuses to unload unresolved commands when transport is disconnected', async () => {
  const f = fixture();
  f.commit.mockRejectedValueOnce(new Error('lost ACK'));
  await f.commands.start(f.draft);
  f.disconnect();
  await expect(f.commands.close()).rejects.toThrow('PROFILE_DRAIN_UNCERTAIN');
});
it('joins an admitted Vault write on disposal and rejects new admissions', async () => {
  const f = fixture();
  let complete!: () => void;
  const original = f.create.getMockImplementation()!;
  f.create.mockImplementationOnce(() => {
    const submission = original();
    return {
      ...submission,
      result: new Promise((resolve) => {
        complete = () => {
          void submission.result.then(resolve);
        };
      }),
    };
  });
  const pending = f.commands.start(f.draft);
  const close = f.commands.close();
  expect(() => f.commands.start(f.draft)).toThrow('PROFILE_BUSY');
  let closed = false;
  void close.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  complete();
  await pending;
  await close;
  expect(f.commit).toHaveBeenCalledTimes(1);
});
it('imports a selected key through an owned grant without reading its bytes in the Client', async () => {
  const f = fixture();
  await f.commands.choose('ssh.privateKey');
  await f.commands.start({
    input: { name: 'File' },
    credentials: [
      {
        field: 'ssh.privateKey',
        grant: { kind: 'privateKey', label: 'File', grantId: f.grant.grantId },
      },
    ],
  });
  expect(f.vault.submitFromGrant).toHaveBeenCalledWith(
    { kind: 'privateKey', label: 'File', grantId: f.grant.grantId },
    expect.any(AbortSignal),
  );
  expect(JSON.stringify(f.commands.getSnapshot())).not.toContain('cred_');
  await f.commands.reset();
  expect(f.files.revoke).toHaveBeenCalledWith(f.grant.grantId);
  await f.commands.close();
});
it('rejects duplicate credential targets and unowned grants before writing anything', async () => {
  const f = fixture();
  expect(() =>
    f.commands.start({ ...f.draft, credentials: [...f.draft.credentials, ...f.draft.credentials] }),
  ).toThrow('PROFILE_CREDENTIALS_INVALID');
  expect(() =>
    f.commands.start({
      input: { name: 'No grant' },
      credentials: [
        {
          field: 'ssh.privateKey',
          grant: { kind: 'privateKey', label: 'No grant', grantId: 'foreign' },
        },
      ],
    }),
  ).toThrow('PROFILE_GRANT_INVALID');
  expect(f.create).not.toHaveBeenCalled();
  expect(f.commit).not.toHaveBeenCalled();
  await f.commands.close();
});
it('deletes only the Profile with its captured version and preserves shared credentials', async () => {
  const f = fixture();
  await f.commands.remove(f.current);
  expect(f.remove).toHaveBeenCalledWith(expect.any(String), f.current.id, '"v7"');
  expect(f.vault.submitRemove).not.toHaveBeenCalled();
  await f.commands.close();
});
