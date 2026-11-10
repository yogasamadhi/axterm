import { RemoteError } from '@axterm/plugin-api';
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { fileGrantSchema, type FileGrantRequest } from '@axterm/plugin-api/files';
import { terminalBackgroundMetadataSchema } from '@axterm/plugin-api/terminals';
import { TerminalThemeAssetPicker } from '../../packages/plugins/terminals/src/client/themes/assets.ts';
function fixture() {
  let generation = randomUUID();
  const asset = terminalBackgroundMetadataSchema.parse({
    id: randomUUID(),
    mimeType: 'image/png',
    bytes: 84,
    sha256: 'a'.repeat(64),
    version: 1,
    createdAt: new Date().toISOString(),
  });
  const grant = fileGrantSchema.parse({
    grantId: 'theme-grant',
    kind: 'file',
    name: 'image.png',
    permissions: ['read'],
    createdAt: new Date().toISOString(),
  });
  const model = {
    getSnapshot: () => ({
      status: 'ready' as const,
      baseline: { generation, cursor: 0, assets: [asset] },
    }),
    importAsset: vi.fn(async (_key: string, _grant: string, _generation: string) => ({
      asset,
      cursor: 1,
    })),
    deleteAsset: vi.fn(async (_key: string, id: string, _version: number, _generation: string) => ({
      id,
      cursor: 2,
    })),
  };
  const grants = {
    create: vi.fn(async (_input: FileGrantRequest, _signal?: AbortSignal) => grant),
    revokeInGeneration: vi.fn(async (_id: string, _generation: string) => {}),
    revoke: async () => {},
    importFile: async () => {
      throw Error('unused');
    },
  };
  const picker = new TerminalThemeAssetPicker(model, grants);
  return {
    asset,
    grant,
    model,
    grants,
    picker,
    retire: () => {
      generation = randomUUID();
    },
  };
}
it('cancels a late picker import only after actual completion, original grant revocation and unapplied asset deletion', async () => {
  const f = fixture(),
    imported = Promise.withResolvers<{ asset: typeof f.asset; cursor: number }>(),
    abort = new AbortController();
  f.model.importAsset.mockImplementation(() => imported.promise);
  const task = f.picker.choose(abort.signal),
    rejected = expect(task).rejects.toThrow();
  await setImmediate();
  abort.abort();
  const closing = f.picker.close();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await setImmediate();
  expect(closed).toBe(false);
  imported.resolve({ asset: f.asset, cursor: 1 });
  await rejected;
  await closing;
  expect(f.grants.revokeInGeneration).toHaveBeenCalledExactlyOnceWith(
    f.grant.grantId,
    f.model.getSnapshot().baseline.generation,
  );
  expect(f.model.deleteAsset).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    f.asset.id,
    1,
    f.model.getSnapshot().baseline.generation,
  );
});
it('reconciles an unknown import with exactly the original key/grant/generation and never opens another picker', async () => {
  const f = fixture();
  f.model.importAsset.mockRejectedValueOnce(Error('lost response'));
  await expect(f.picker.choose()).rejects.toThrow('lost response');
  expect(f.picker.hasPendingIntent()).toBe(true);
  const result = await f.picker.retry();
  expect(result).toEqual(f.asset);
  expect(Object.isFrozen(result)).toBe(true);
  expect(f.model.importAsset.mock.calls[1]).toEqual(f.model.importAsset.mock.calls[0]);
  expect(f.grants.create).toHaveBeenCalledOnce();
  expect(f.grants.revokeInGeneration).toHaveBeenCalledOnce();
  f.picker.commit(f.asset.id);
  await f.picker.close();
  expect(f.model.deleteAsset).not.toHaveBeenCalled();
});
it('keeps a failed grant cleanup owned and retries it before disposing the imported resource', async () => {
  const f = fixture();
  f.grants.revokeInGeneration.mockRejectedValue(Error('controlled revoke'));
  await expect(f.picker.choose()).rejects.toThrow('controlled revoke');
  await expect(f.picker.close()).rejects.toThrow('controlled revoke');
  expect(f.model.deleteAsset).not.toHaveBeenCalled();
  f.grants.revokeInGeneration.mockResolvedValue();
  await f.picker.close();
  expect(f.model.importAsset).toHaveBeenCalledOnce();
  expect(f.model.deleteAsset).toHaveBeenCalledOnce();
});
it('protects an asset during an unknown global application and hands it off only after accepted completion', async () => {
  const f = fixture();
  await f.picker.choose();
  const settled = f.picker.protect(f.asset.id);
  await expect(f.picker.reset()).rejects.toThrow('DRAIN_FAILED');
  expect(f.model.deleteAsset).not.toHaveBeenCalled();
  settled(true);
  await f.picker.close();
  expect(f.model.deleteAsset).not.toHaveBeenCalled();
});
it('retires previous-generation cleanup without deleting resources through a new Host', async () => {
  const f = fixture();
  await f.picker.choose();
  f.retire();
  await f.picker.close();
  expect(f.model.deleteAsset).not.toHaveBeenCalled();
});
it('does not replace an unidentified grant outcome with another native request', async () => {
  const f = fixture();
  f.grants.create.mockRejectedValue(Error('unknown native grant'));
  await expect(f.picker.choose()).rejects.toThrow('unknown native grant');
  await expect(f.picker.retry()).rejects.toThrow('GRANT_OUTCOME_UNCERTAIN');
  expect(f.grants.create).toHaveBeenCalledOnce();
  expect(f.model.importAsset).not.toHaveBeenCalled();
  f.retire();
  await f.picker.close();
});

it('releases a definite grant refusal without retaining an unidentified resource or repeating selection', async () => {
  const f = fixture();
  f.grants.create.mockRejectedValue(
    new RemoteError('files/failure', 'Refused', { reason: 'forbidden' }),
  );
  await expect(f.picker.choose()).rejects.toThrow('Refused');
  expect(f.picker.hasPendingIntent()).toBe(false);
  await f.picker.close();
  expect(f.grants.create).toHaveBeenCalledOnce();
  expect(f.model.importAsset).not.toHaveBeenCalled();
});
