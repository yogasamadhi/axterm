import { afterEach, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { FileGrantsModel } from '../../packages/plugins/files/src/client/index.ts';
import type { TransferGrantHandoffs } from '../../packages/plugins/files/src/client/ui/transfer-grants.ts';
import { FilesSessionOwner } from '../../packages/plugins/files/src/client/ui/session-owner.ts';
afterEach(() => vi.unstubAllGlobals());
it('uses handed-in directory authority without issuing a second picker/home request, and joins its release on close', async () => {
  const dom = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('window', dom);
  const listeners = new Set<() => void>();
  const grant = {
    grantId: crypto.randomUUID(),
    kind: 'directory' as const,
    name: 'Initial fixture',
    permissions: ['read', 'write'] as ('read' | 'write')[],
    createdAt: new Date().toISOString(),
  };
  const files = {
    openExternalEditors: () => ({ dispose: vi.fn(async () => {}) }),
    getSnapshot: () => ({
      status: 'ready',
      baseline: { generation: crypto.randomUUID(), grants: [grant] },
    }),
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    create: vi.fn(),
  };
  const generation = crypto.randomUUID();
  files.getSnapshot = () => ({ status: 'ready', baseline: { generation, grants: [grant] } });
  const drained = Promise.withResolvers<void>();
  const handoffs = { release: vi.fn(() => drained.promise) };
  const owner = new FilesSessionOwner(
    {} as Context,
    files as unknown as FileGrantsModel,
    handoffs as unknown as TransferGrantHandoffs,
    grant,
  );
  expect(owner.getSnapshot().grant).toEqual(grant);
  expect(files.create).not.toHaveBeenCalled();
  let done = false;
  const close = owner.dispose().then(() => {
    done = true;
  });
  await vi.waitFor(() =>
    expect(handoffs.release).toHaveBeenCalledExactlyOnceWith(grant.grantId, generation),
  );
  expect(done).toBe(false);
  drained.resolve();
  await close;
  expect(listeners.size).toBe(0);
  expect(dom.removeEventListener).toHaveBeenCalledExactlyOnceWith('message', expect.any(Function));
});
