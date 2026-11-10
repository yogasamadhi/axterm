import { expect, it, vi } from 'vitest';
import { webSessionSchema } from '@axterm/plugin-api/remote-desktop';
import type { WebSessionState } from '../../packages/plugins/remote-desktop/src/client/web-model.ts';
import { WebSessionWorkspace } from '../../packages/plugins/remote-desktop/src/client/ui/web-owner.ts';
import { WorkspaceStore } from '../../packages/plugins/workspace/src/client/store.ts';
function fixture() {
  const generation = crypto.randomUUID(),
    session = webSessionSchema.parse({
      id: crypto.randomUUID(),
      windowId: crypto.randomUUID(),
      bookmarkId: crypto.randomUUID(),
      title: 'Website',
      description: '',
      url: 'https://fixture.test/',
      currentUrl: 'https://fixture.test/',
      userAgent: null,
      hideAddressBar: false,
      state: 'ready',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1,
      visible: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  let state: WebSessionState = {
    status: 'ready',
    baseline: { type: 'baseline', generation, revision: 0, sessions: [] },
  };
  const listeners = new Set<() => void>(),
    model = {
      getSnapshot: () => state,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      create: vi.fn(async () => session),
      close: vi.fn(async () => {}),
      getCommandOutcome: vi.fn(async () => ({ status: 'accepted' as const, id: session.id })),
    },
    store = new WorkspaceStore(),
    owner = new WebSessionWorkspace(model, store);
  const publish = (value: WebSessionState) => {
    state = value;
    for (const listener of [...listeners]) listener();
  };
  return {
    session,
    generation,
    model,
    store,
    owner,
    listeners,
    publish,
    accept: () =>
      publish({
        status: 'ready',
        baseline: { type: 'baseline', generation, revision: 1, sessions: [session] },
      }),
  };
}
it('waits for owned metadata and joins presentation teardown before closing the native session', async () => {
  const f = fixture(),
    opening = f.owner.open({ bookmarkId: f.session.bookmarkId });
  await vi.waitFor(() => expect(f.listeners.size).toBe(2));
  expect(f.store.getSnapshot().tabs).toEqual([]);
  f.accept();
  await opening;
  const late = Promise.withResolvers<void>();
  f.owner.attach(f.session.id, { dispose: () => late.promise });
  const closing = f.owner.closeView(f.session.id);
  await Promise.resolve();
  expect(f.model.close).not.toHaveBeenCalled();
  late.resolve();
  await closing;
  expect(f.model.close).toHaveBeenCalledWith(f.session.id, f.generation);
  await f.owner.close();
  await f.store.dispose();
  expect(f.listeners.size).toBe(0);
});
it('reconciles unknown admission once, retains failed close for retry, and never sends old cleanup into a new generation', async () => {
  const f = fixture();
  f.model.create.mockRejectedValueOnce(Error('unknown response'));
  await expect(f.owner.open({ bookmarkId: f.session.bookmarkId })).rejects.toThrow();
  expect(f.model.create).toHaveBeenCalledOnce();
  expect(f.model.getCommandOutcome).toHaveBeenCalledOnce();
  expect(f.model.close).toHaveBeenCalledWith(f.session.id, f.generation);
  f.accept();
  await f.owner.open({ bookmarkId: f.session.bookmarkId });
  f.model.close.mockRejectedValueOnce(Error('undrained'));
  await expect(f.owner.closeView(f.session.id)).rejects.toThrow();
  expect(f.store.getSnapshot().tabs).toHaveLength(1);
  await f.owner.closeView(f.session.id);
  await f.owner.open({ bookmarkId: f.session.bookmarkId });
  f.model.close.mockClear();
  f.publish({
    status: 'ready',
    baseline: { type: 'baseline', generation: crypto.randomUUID(), revision: 0, sessions: [] },
  });
  await vi.waitFor(() => expect(f.store.getSnapshot().tabs).toEqual([]));
  expect(f.model.close).not.toHaveBeenCalled();
  await f.owner.close();
  await f.store.dispose();
});
