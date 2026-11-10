import { describe, expect, it, vi } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import {
  createSshBookmarkSchema,
  createBookmarkSchema,
  type CatalogReceipt,
} from '@axterm/plugin-api/catalog';
import type {
  SavedCredentialActions,
  CredentialCommandReceipt,
  CredentialSubmission,
  CreateSavedCredentialInput,
} from '@axterm/plugin-api/saved-credentials';
import type {
  CatalogModel,
  CatalogState,
} from '../../packages/plugins/catalog/src/client/index.ts';
import { SshSaveWorkflow } from '../../packages/plugins/catalog/src/client/ui/editor/ssh-save-workflow.ts';
import { ProtocolSaveWorkflow } from '../../packages/plugins/catalog/src/client/ui/editor/protocol-save-workflow.ts';
const secret = 'CATALOG_EDITOR_SECRET_CANARY';
function fixture(kind: 'ssh' | 'vnc') {
  let generation = crypto.randomUUID();
  const receipts = new Map<string, CredentialCommandReceipt>();
  const receipt = (
    id: string,
    operation: 'create' | 'delete',
    ref = 'cred_' + crypto.randomUUID(),
  ): CredentialCommandReceipt => ({
    commandId: id,
    generation,
    operation,
    ref,
    status: 'completed',
  });
  const created = vi.fn((input: CreateSavedCredentialInput): CredentialSubmission => {
    expect(input.secret).toBe(secret);
    const id = crypto.randomUUID(),
      value = receipt(id, 'create');
    receipts.set(id, value);
    return { commandId: id, generation, result: Promise.resolve(value) };
  });
  const removed = vi.fn((ref: string): CredentialSubmission => {
    const id = crypto.randomUUID(),
      value = receipt(id, 'delete', ref);
    receipts.set(id, value);
    return { commandId: id, generation, result: Promise.resolve(value) };
  });
  const outcome = vi.fn(async (id: string) => {
    const value = receipts.get(id);
    if (!value) throw new Error('Unknown receipt');
    return value;
  });
  const vault = {
    submitCreate: created,
    submitRemove: removed,
    outcome,
  } as unknown as SavedCredentialActions;
  const committed: CatalogReceipt = {
    ids: [crypto.randomUUID(), ...(kind === 'ssh' ? [crypto.randomUUID()] : [])],
    cursor: 4,
  };
  const commit = vi.fn(async (_key: string, input: unknown, _tree: string | undefined) => {
    if (kind === 'ssh') createSshBookmarkSchema.parse(input);
    else createBookmarkSchema.parse(input);
    expect(JSON.stringify(input)).not.toContain(secret);
    return committed;
  });
  const model = {
    getSnapshot: () =>
      ({
        status: 'ready',
        baseline: { generation, bookmarks: { etag: '"bookmark-tree-v1"' } },
      }) as CatalogState,
    createSshBookmark: commit,
    updateSshBookmark: vi.fn(),
    createBookmark: commit,
    updateBookmark: vi.fn(),
  } as unknown as CatalogModel;
  const workflow =
    kind === 'ssh' ? new SshSaveWorkflow(model, vault) : new ProtocolSaveWorkflow(model, vault);
  const start = () =>
    kind === 'ssh'
      ? (workflow as SshSaveWorkflow).start({
          input: {
            host: { name: 'Saved SSH', hostname: 'example.test', username: 'operator' },
            bookmark: { title: 'Saved SSH' },
          },
          credentials: [
            { field: 'credentialRef', input: { kind: 'sshPassword', label: 'Saved SSH', secret } },
          ],
        })
      : (workflow as ProtocolSaveWorkflow).start({
          input: {
            protocol: 'vnc',
            hostId: null,
            title: 'Saved VNC',
            vnc: { hostname: 'example.test' },
          },
          credentials: [
            {
              field: 'credentialRef',
              input: { kind: 'protocolPassword', label: 'Saved VNC', secret },
            },
          ],
        });
  return {
    workflow,
    start,
    commit,
    created,
    removed,
    outcome,
    receipts,
    committed,
    changeGeneration: () => {
      generation = crypto.randomUUID();
    },
  };
}
for (const kind of ['ssh', 'vnc'] as const)
  describe(kind + ' Catalog editor save ownership', () => {
    it('queries a lost Vault admission outcome without creating another credential or publishing secret data', async () => {
      const f = fixture(kind);
      const original = f.created.getMockImplementation()!;
      f.created.mockImplementationOnce((input) => {
        const result = original(input);
        return { ...result, result: Promise.reject(new Error('Lost Vault ACK')) };
      });
      await f.start();
      expect(f.workflow.getSnapshot().status).toBe('uncertain');
      expect(f.commit).not.toHaveBeenCalled();
      expect(JSON.stringify(f.workflow.getSnapshot())).not.toContain(secret);
      await f.workflow.retry();
      expect(f.created).toHaveBeenCalledTimes(1);
      expect(f.outcome).toHaveBeenCalledTimes(1);
      expect(f.commit).toHaveBeenCalledTimes(1);
      expect(f.workflow.getSnapshot()).toEqual({ status: 'completed', receipt: f.committed });
      await f.workflow.close();
      expect(f.removed).not.toHaveBeenCalled();
    });
    it('retains the same Catalog identity/input after a lost ACK and never deletes committed references', async () => {
      const f = fixture(kind);
      f.commit.mockRejectedValueOnce(new Error('Lost Catalog ACK'));
      await f.start();
      expect(f.workflow.getSnapshot().status).toBe('uncertain');
      expect(f.removed).not.toHaveBeenCalled();
      await f.workflow.retry();
      expect(f.commit).toHaveBeenCalledTimes(2);
      expect(f.commit.mock.calls[1]).toEqual(f.commit.mock.calls[0]);
      expect(f.created).toHaveBeenCalledTimes(1);
      await f.workflow.close();
      expect(f.removed).not.toHaveBeenCalled();
    });
    it('retains owner-created credentials after a definite Catalog rejection because another window may already reference them', async () => {
      const f = fixture(kind);
      f.commit.mockRejectedValue(
        new RemoteError('catalog/failure', 'Rejected', { reason: 'precondition-failed' }),
      );
      await f.start();
      expect(f.workflow.getSnapshot()).toEqual({
        status: 'failed',
        retainedCredentials: true,
        ...(kind === 'ssh'
          ? {
              failure: {
                stage: 'save',
                diagnostic: {
                  code: 'PRECONDITION_FAILED',
                  operationId: f.commit.mock.calls[0]![0],
                },
              },
            }
          : {}),
      });
      expect(f.created).toHaveBeenCalledTimes(1);
      expect(f.removed).not.toHaveBeenCalled();
      expect(f.commit).toHaveBeenCalledTimes(1);
      await f.workflow.close();
      expect(f.removed).not.toHaveBeenCalled();
    });
    it('retires old-generation admissions without deleting possibly referenced credentials or sending a new-generation Catalog command', async () => {
      const f = fixture(kind);
      const late = Promise.withResolvers<CredentialCommandReceipt>();
      const original = f.created.getMockImplementation()!;
      let value: CredentialCommandReceipt | undefined;
      f.created.mockImplementationOnce((input) => {
        const result = original(input);
        value = f.receipts.get(result.commandId);
        return { ...result, result: late.promise };
      });
      const save = f.start();
      f.changeGeneration();
      late.resolve(value!);
      await save;
      expect(f.workflow.getSnapshot().status).toBe('failed');
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.removed).not.toHaveBeenCalled();
      await f.workflow.close();
    });
    it('joins the actual in-flight save before closing and rejects new admission after disposal', async () => {
      const f = fixture(kind);
      const late = Promise.withResolvers<CatalogReceipt>();
      f.commit.mockImplementationOnce(() => late.promise);
      const save = f.start();
      await vi.waitFor(() => expect(f.commit).toHaveBeenCalledTimes(1));
      let closed = false;
      const stop = f.workflow.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      late.resolve(f.committed);
      await Promise.all([save, stop]);
      expect(() => f.start()).toThrow('NOT_IDLE');
      expect(f.removed).not.toHaveBeenCalled();
    });
  });
it('validates a new proxy password before Vault admission and only commits the owner-issued reference', async () => {
  const f = fixture('ssh');
  const workflow = f.workflow as SshSaveWorkflow;
  await workflow.start({
    input: {
      host: {
        name: 'Proxy SSH',
        hostname: 'example.test',
        username: 'operator',
        proxy: {
          mode: 'custom',
          endpoint: { url: 'socks5://localhost:1080', username: 'proxy-user', credentialRef: null },
        },
      },
      bookmark: { title: 'Proxy SSH' },
    },
    credentials: [
      { field: 'proxy', input: { kind: 'proxyPassword', label: 'Proxy password', secret } },
    ],
  });
  expect(workflow.getSnapshot().status).toBe('completed');
  const input = f.commit.mock.calls[0]![1] as {
    host: { proxy: { endpoint: { credentialRef: string } } };
  };
  expect(input.host.proxy.endpoint.credentialRef).toMatch(/^cred_/);
  expect(JSON.stringify(input)).not.toContain('catalog-validation-only');
  await workflow.close();
});

it('publishes only owned stage and safe Catalog diagnostics with the actual admission key', async () => {
  const f = fixture('ssh');
  f.commit.mockRejectedValueOnce(
    new RemoteError('catalog/failure', secret, {
      reason: 'conflict',
      diagnostic: { code: 'HOST_NAME_CONFLICT' },
    }),
  );
  await f.start();
  expect(f.workflow.getSnapshot()).toMatchObject({
    status: 'failed',
    retainedCredentials: true,
    failure: {
      stage: 'save',
      diagnostic: { code: 'HOST_NAME_CONFLICT', operationId: f.commit.mock.calls[0]![0] },
    },
  });
  expect(JSON.stringify(f.workflow.getSnapshot())).not.toContain(secret);
  expect(f.removed).not.toHaveBeenCalled();
  await f.workflow.close();
});
it('reports confirmed Vault failure in its credential stage without admitting Catalog or exposing the secret', async () => {
  const f = fixture('ssh'),
    original = f.created.getMockImplementation()!;
  let commandId = '';
  f.created.mockImplementationOnce((input) => {
    const submission = original(input);
    commandId = submission.commandId;
    const receipt = f.receipts.get(commandId)!;
    return {
      ...submission,
      result: Promise.resolve({
        ...receipt,
        status: 'failed' as const,
        reason: 'unavailable' as const,
      }),
    };
  });
  await f.start();
  expect(f.workflow.getSnapshot()).toMatchObject({
    status: 'failed',
    failure: {
      stage: 'credential',
      diagnostic: { code: 'CAPABILITY_UNAVAILABLE', operationId: commandId },
    },
  });
  expect(f.commit).not.toHaveBeenCalled();
  expect(JSON.stringify(f.workflow.getSnapshot())).not.toContain(secret);
  await f.workflow.close();
});
