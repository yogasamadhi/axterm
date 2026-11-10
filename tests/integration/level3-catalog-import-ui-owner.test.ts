import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import {
  bookmarkTreeSchema,
  type CatalogBaseline,
  type CatalogImportReceipt,
  type SshConfigImportResult,
} from '@axterm/plugin-api/catalog';
import { fileGrantSchema, type FileGrantActions } from '@axterm/plugin-api/files';
import {
  ImportDialogActions,
  type ImportCatalogModel,
} from '../../packages/plugins/catalog/src/client/ui/import-actions.ts';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture() {
  vi.stubGlobal('location', { protocol: 'axterm-app:' });
  const generation = randomUUID();
  const tree = bookmarkTreeSchema.parse({
    revision: 1,
    etag: '"bookmark-tree-v1"',
    groups: [],
    bookmarks: [],
  });
  const baseline: CatalogBaseline = {
    generation,
    cursor: 0,
    hosts: [],
    hostGroups: [],
    bookmarks: tree,
    connectionProfiles: [],
    history: {
      revision: 1,
      etag: '"connection-history-v1"',
      sort: 'recent',
      limit: 50,
      total: 0,
      items: [],
      nextCursor: null,
    },
  };
  const result: SshConfigImportResult = {
    source: 'ssh-config',
    importedAt: new Date().toISOString(),
    createdHosts: [],
    createdBookmarks: [],
    tree,
    items: [],
    notices: [],
    summary: { total: 0, imported: 0, linked: 0, unchanged: 0, skipped: 0, warningCount: 0 },
  };
  const receipt: CatalogImportReceipt = {
    ids: [],
    cursor: 0,
    treeRevision: 1,
    reportId: randomUUID(),
    summary: result.summary,
  };
  const model = {
    getSnapshot: () => ({ status: 'ready' as const, baseline }),
    previewSshConfigImport: vi.fn<ImportCatalogModel['previewSshConfigImport']>(),
    commitSshConfigImport: vi
      .fn<ImportCatalogModel['commitSshConfigImport']>()
      .mockResolvedValue(receipt),
    getSshConfigImportReport: vi
      .fn<ImportCatalogModel['getSshConfigImportReport']>()
      .mockResolvedValue(result),
  } satisfies ImportCatalogModel;
  const makeGrant = () =>
    fileGrantSchema.parse({
      grantId: randomUUID(),
      name: 'config',
      kind: 'file',
      permissions: ['read'],
      createdAt: new Date().toISOString(),
    });
  const files = {
    create: vi.fn<FileGrantActions['create']>(async () => makeGrant()),
    importFile: vi.fn<FileGrantActions['importFile']>(async () => makeGrant()),
    revoke: vi.fn<FileGrantActions['revoke']>().mockResolvedValue(undefined),
  } satisfies FileGrantActions;
  const owner = new ImportDialogActions(model, files, generation);
  return { model, files, owner, baseline, tree, result, receipt, makeGrant };
}
it('retries an uncertain explicit command with its original copied payload and key', async () => {
  const f = fixture();
  f.model.commitSshConfigImport.mockRejectedValueOnce(new Error('CARRIER_LOST'));
  const input = { previewId: randomUUID(), items: [] };
  const original = structuredClone(input);
  const first = f.owner.commitSshConfigImport(input, f.tree);
  input.previewId = randomUUID();
  await expect(first).rejects.toThrow('CARRIER_LOST');
  expect(f.owner.getSnapshot().status).toBe('uncertain');
  const previous = f.model.commitSshConfigImport.mock.calls[0]!;
  expect(previous[1]).toEqual(original);
  expect(
    await f.owner.commitSshConfigImport(input, { ...f.tree, etag: '"bookmark-tree-v9"' }),
  ).toEqual(f.result);
  expect(f.model.commitSshConfigImport.mock.calls[1]).toEqual(previous);
  expect(f.owner.getSnapshot()).toEqual({ status: 'committed', receipt: f.receipt });
  await f.owner.dispose();
});
it('only rereads the accepted report after a report failure and permits editing again after explicit noncommit', async () => {
  const f = fixture();
  const input = { previewId: randomUUID(), items: [] };
  f.model.commitSshConfigImport.mockRejectedValueOnce(
    new RemoteError('catalog/failure', 'Stale', { reason: 'precondition-failed' }),
  );
  await expect(f.owner.commitSshConfigImport(input, f.tree)).rejects.toThrow('Stale');
  expect(f.owner.getSnapshot().status).toBe('idle');
  f.model.getSshConfigImportReport.mockRejectedValueOnce(new Error('REPORT_CARRIER_LOST'));
  input.previewId = randomUUID();
  await expect(f.owner.commitSshConfigImport(input, f.tree)).rejects.toThrow('REPORT_CARRIER_LOST');
  expect(f.owner.getSnapshot().status).toBe('committed');
  expect(await f.owner.commitSshConfigImport(input, f.tree)).toEqual(f.result);
  expect(f.model.commitSshConfigImport).toHaveBeenCalledTimes(2);
  expect(f.model.getSshConfigImportReport).toHaveBeenCalledTimes(2);
  await f.owner.dispose();
});
it('retains failed revokes in the grant limit and never adopts another owner grant', async () => {
  const f = fixture();
  const grants = [];
  for (let index = 0; index < 129; index++)
    grants.push((await f.owner.createFileGrant('open-file'))!);
  await expect(f.owner.createFileGrant('open-file')).rejects.toThrow(
    'CATALOG_IMPORT_GRANT_CAPACITY',
  );
  expect(f.files.create).toHaveBeenCalledTimes(129);
  f.files.revoke.mockRejectedValueOnce(new Error('REVOKE_FAILED'));
  await expect(f.owner.revokeFileGrant(grants[0]!.grantId)).rejects.toThrow('REVOKE_FAILED');
  await expect(f.owner.createFileGrant('open-file')).rejects.toThrow(
    'CATALOG_IMPORT_GRANT_CAPACITY',
  );
  await f.owner.revokeFileGrant('NOT_OWNED');
  expect(f.files.revoke).toHaveBeenCalledTimes(1);
  await f.owner.revokeFileGrant(grants[0]!.grantId);
  await f.owner.createFileGrant('open-file');
  await f.owner.dispose();
  expect(f.files.revoke).toHaveBeenCalledTimes(131);
});
it('joins late native selection and revokes it before finishing close; a retired generation never submits', async () => {
  const f = fixture();
  const gate = Promise.withResolvers<ReturnType<typeof f.makeGrant>>();
  const entered = Promise.withResolvers<void>();
  f.files.create.mockImplementation(async () => {
    entered.resolve();
    return gate.promise;
  });
  const selection = f.owner.createFileGrant('open-file');
  const rejected = expect(selection).rejects.toThrow();
  await entered.promise;
  let done = false;
  const close = f.owner.dispose().then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  const grant = f.makeGrant();
  gate.resolve(grant);
  await rejected;
  await close;
  expect(f.files.revoke).toHaveBeenCalledWith(grant.grantId);
  const next = fixture();
  next.model.getSnapshot = () => ({
    status: 'ready',
    baseline: { ...next.baseline, generation: randomUUID() },
  });
  await expect(
    next.owner.commitSshConfigImport({ previewId: randomUUID(), items: [] }, next.tree),
  ).rejects.toThrow('CATALOG_IMPORT_GENERATION_CHANGED');
  expect(next.model.commitSshConfigImport).not.toHaveBeenCalled();
  await next.owner.dispose();
});

it('stops cleanup admission during close and joins the already owned revoke instead of issuing a second one', async () => {
  const f = fixture();
  const grant = (await f.owner.createFileGrant('open-file'))!;
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  f.files.revoke.mockImplementation(async () => {
    entered.resolve();
    await gate.promise;
  });
  const close = f.owner.dispose();
  await entered.promise;
  const late = f.owner.revokeFileGrant(grant.grantId);
  expect(f.files.revoke).toHaveBeenCalledTimes(1);
  gate.resolve();
  await close;
  await late;
});
