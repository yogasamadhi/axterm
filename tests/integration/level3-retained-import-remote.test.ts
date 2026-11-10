import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import type { SshConfigImportPreview } from '@axterm/plugin-api/catalog';
import { CatalogModel } from '../../packages/plugins/catalog/src/client/index.ts';
import { remoteProfile, remoteValue } from '../fixtures/level3-remote-profile.ts';
const homes: string[] = [],
  profiles: Awaited<ReturnType<typeof remoteProfile>>[] = [];
afterEach(async () => {
  for (const f of profiles.splice(0).reverse()) await f.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'axterm-import-remote-'));
  homes.push(home);
  const f = await remoteProfile(home, { application: true });
  profiles.push(f);
  const model = new CatalogModel(f.client);
  f.client.effect(() => () => model.dispose());
  const text =
      'Host gateway\n  HostName gateway.example.test\n  User operator\nHost application\n  HostName application.example.test\n  User operator\n  ProxyJump gateway\n',
    ctx = f.application.ctx;
  const provisional = await ctx.fileImports.prepare(
    {
      name: 'ssh-config',
      size: Buffer.byteLength(text),
      editable: false,
    },
    new AbortController().signal,
  );
  const writer = await ctx.files.open(provisional.grantId, 'write');
  try {
    await writer.write(writer.path, Readable.from([Buffer.from(text)]), {
      overwrite: true,
      mode: 0o600,
    });
  } finally {
    await writer.close();
  }
  const grant = await ctx.fileImports.commit(provisional.grantId, new AbortController().signal);
  return { ...f, model, grant };
}
const drafts = (preview: SshConfigImportPreview) =>
  preview.items.flatMap((item) => (item.draft ? [item.draft] : []));
it('returns the original two-host atomic import report and leaves repeated complete import unchanged through generated Remote', async () => {
  const f = await fixture(),
    api = f.client.remote.catalog,
    before = await remoteValue(api.getBookmarkTree());
  const preview = await f.model.previewSshConfigImport({ grantId: f.grant.grantId });
  const receipt = await f.model.commitSshConfigImport(
    randomUUID(),
    { previewId: preview.previewId, groupId: null, items: drafts(preview) },
    before.etag,
  );
  const imported = await f.model.getSshConfigImportReport(receipt.reportId);
  expect(imported.summary).toMatchObject({ imported: 2, linked: 0, unchanged: 0 });
  expect(imported.tree.revision).toBe(before.revision + 1);
  expect(imported.createdHosts).toHaveLength(2);
  expect(imported.createdBookmarks).toHaveLength(2);
  const repeatedPreview = await f.model.previewSshConfigImport({ grantId: f.grant.grantId });
  const repeatedReceipt = await f.model.commitSshConfigImport(
    randomUUID(),
    {
      previewId: repeatedPreview.previewId,
      groupId: null,
      items: drafts(repeatedPreview).map((draft) => ({ ...draft, selected: true })),
    },
    imported.tree.etag,
  );
  const repeated = await f.model.getSshConfigImportReport(repeatedReceipt.reportId);
  expect(repeated.summary).toMatchObject({ imported: 0, linked: 0, unchanged: 2 });
  expect(repeated.tree).toEqual(imported.tree);
  expect(await remoteValue(api.listHosts())).toHaveLength(2);
});
it('commits the original editable two-host preview once and keeps a subsequent full preview import safe', async () => {
  const f = await fixture(),
    api = f.client.remote.catalog,
    before = await remoteValue(api.getBookmarkTree()),
    preview = await f.model.previewSshConfigImport({ grantId: f.grant.grantId });
  expect(preview.summary).toMatchObject({ imported: 2, selected: 2, skipped: 0 });
  expect(preview.items.every((item) => item.draft?.selected)).toBe(true);
  const items = drafts(preview).map((draft) =>
      draft.name === 'application' ? { ...draft, title: 'Edited application' } : draft,
    ),
    input = { previewId: preview.previewId, groupId: null, items };
  const receipt = await f.model.commitSshConfigImport(randomUUID(), input, before.etag),
    imported = await f.model.getSshConfigImportReport(receipt.reportId);
  expect(imported.summary).toMatchObject({ imported: 2, linked: 0, unchanged: 0 });
  expect(imported.tree.bookmarks.some((bookmark) => bookmark.title === 'Edited application')).toBe(
    true,
  );
  await expect(
    f.model.commitSshConfigImport(randomUUID(), input, imported.tree.etag),
  ).rejects.toMatchObject({ code: 'catalog/failure', details: { reason: 'precondition-failed' } });
  const repeatedPreview = await f.model.previewSshConfigImport({ grantId: f.grant.grantId });
  expect(repeatedPreview.summary).toMatchObject({ imported: 0, unchanged: 2, selected: 0 });
  const repeatedReceipt = await f.model.commitSshConfigImport(
      randomUUID(),
      {
        previewId: repeatedPreview.previewId,
        groupId: null,
        items: drafts(repeatedPreview).map((draft) => ({ ...draft, selected: true })),
      },
      imported.tree.etag,
    ),
    repeated = await f.model.getSshConfigImportReport(repeatedReceipt.reportId);
  expect(repeated.summary).toMatchObject({ imported: 0, unchanged: 2 });
  expect(repeated.tree).toEqual(imported.tree);
  expect(await remoteValue(api.listHosts())).toHaveLength(2);
});
it('requires the original tree precondition and leaves no Host or partial import after stale confirmation', async () => {
  const f = await fixture(),
    api = f.client.remote.catalog,
    tree = await remoteValue(api.getBookmarkTree()),
    preview = await f.model.previewSshConfigImport({ grantId: f.grant.grantId }),
    input = { previewId: preview.previewId, groupId: null, items: drafts(preview) };
  await expect(f.model.commitSshConfigImport(randomUUID(), input, undefined)).rejects.toMatchObject(
    { code: 'catalog/failure', details: { reason: 'precondition-required' } },
  );
  await remoteValue(api.createBookmarkGroup(randomUUID(), { name: 'Concurrent group' }, tree.etag));
  const current = await remoteValue(api.getBookmarkTree());
  await expect(f.model.commitSshConfigImport(randomUUID(), input, tree.etag)).rejects.toMatchObject(
    { code: 'catalog/failure', details: { reason: 'precondition-failed' } },
  );
  expect(await remoteValue(api.listHosts())).toEqual([]);
  expect(await remoteValue(api.getBookmarkTree())).toEqual(current);
});
