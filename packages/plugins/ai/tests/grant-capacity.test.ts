import { expect, it, vi } from 'vitest';
import { fileGrantSchema, type FileGrant } from '@axterm/plugin-api/files';
import type { AiModel } from '../src/client/index.ts';
import { AiPanelActions } from '../src/client/ui/panel-actions.ts';
const grant = () =>
  fileGrantSchema.parse({
    grantId: crypto.randomUUID(),
    kind: 'file',
    name: 'controlled.txt',
    permissions: ['read'],
    createdAt: new Date().toISOString(),
  });
const model = () => ({ subscribe: () => () => {} }) as unknown as AiModel;
it('counts retained grant authority against subsequent acquisition until actual revoke succeeds', async () => {
  const active = new Set<string>();
  const imported: FileGrant[] = [];
  let fail = false;
  const files = {
    create: vi.fn(async () => undefined),
    importFile: vi.fn(async () => {
      const value = grant();
      active.add(value.grantId);
      imported.push(value);
      return value;
    }),
    revoke: vi.fn(async (id: string) => {
      if (fail) throw new Error('Controlled revoke failure');
      active.delete(id);
    }),
  };
  const actions = new AiPanelActions(model(), { create: vi.fn(), remove: vi.fn() }, files, vi.fn());
  const file = new File(['x'], 'controlled.txt', { type: 'text/plain' });
  for (let index = 0; index < 64; index++) await actions.importDroppedFile(file);
  await expect(actions.importDroppedFile(file)).rejects.toThrow('AI_FILE_GRANT_CAPACITY');
  expect(files.importFile).toHaveBeenCalledTimes(64);
  fail = true;
  await expect(actions.revokeFileGrant(imported[0]!.grantId)).rejects.toThrow('revoke failure');
  await expect(actions.importDroppedFile(file)).rejects.toThrow('AI_FILE_GRANT_CAPACITY');
  fail = false;
  await actions.revokeFileGrant(imported[0]!.grantId);
  await actions.importDroppedFile(file);
  expect(files.importFile).toHaveBeenCalledTimes(65);
  const calls = files.revoke.mock.calls.length;
  await actions.revokeFileGrant('unowned-foreign-grant');
  expect(files.revoke).toHaveBeenCalledTimes(calls);
  await actions.dispose();
  expect(active.size).toBe(0);
});
it('reserves concurrent grants and joins canceled late acquisitions before their actual revoke', async () => {
  const deferred: ReturnType<typeof Promise.withResolvers<FileGrant>>[] = [];
  const active = new Set<string>();
  const files = {
    create: vi.fn(async () => undefined),
    importFile: vi.fn(() => {
      const pending = Promise.withResolvers<FileGrant>();
      deferred.push(pending);
      return pending.promise.then((value) => {
        active.add(value.grantId);
        return value;
      });
    }),
    revoke: vi.fn(async (id: string) => {
      active.delete(id);
    }),
  };
  const actions = new AiPanelActions(model(), { create: vi.fn(), remove: vi.fn() }, files, vi.fn());
  const file = new File(['x'], 'controlled.txt');
  const pending = Array.from({ length: 64 }, () => actions.importDroppedFile(file));
  const outcomes = Promise.allSettled(pending);
  await Promise.resolve();
  expect(deferred).toHaveLength(64);
  expect(() => actions.importDroppedFile(file)).toThrow('AI_UI_CAPACITY');
  const close = actions.dispose();
  expect(actions.dispose()).toBe(close);
  let closed = false;
  void close.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  for (const item of deferred) item.resolve(grant());
  await outcomes;
  await close;
  expect(files.revoke).toHaveBeenCalledTimes(64);
  expect(active.size).toBe(0);
});
