import { expect, it, vi } from 'vitest';
import type {
  ConfigurationClientActions,
  SettingsBaseline,
} from '@axterm/plugin-api/configuration';
import type { WorkspaceSessionDescriptions, TerminalSessionUi } from '@axterm/ui/workspace';
import { WorkspaceStore } from '../../packages/plugins/workspace/src/client/store.ts';
import { WorkspaceTabActions } from '../../packages/plugins/workspace/src/client/tab-actions.ts';
function fixture(kind = 'terminal') {
  const workspace = new WorkspaceStore(),
    id = crypto.randomUUID(),
    listeners = new Set<() => void>();
  let generation = crypto.randomUUID();
  workspace.registerTab({ id, kind, title: 'Selected target' }, async () => {});
  const configuration = {
    getSnapshot: () => ({ status: 'ready' as const, baseline: { generation } as SettingsBaseline }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as ConfigurationClientActions;
  return {
    workspace,
    id,
    configuration,
    generation,
    listeners,
    retire: () => {
      generation = crypto.randomUUID();
      for (const listener of listeners) listener();
    },
  };
}
it('delegates a captured terminal target once and drains the real owner promise on unload', async () => {
  const f = fixture();
  let complete!: (id: string) => void;
  const actual = new Promise<string>((resolve) => {
    complete = resolve;
  });
  let signal: AbortSignal | undefined;
  const duplicate = vi.fn(
      (_id: string, _pane: boolean | undefined, owned: AbortSignal | undefined) => {
        signal = owned;
        return actual;
      },
    ),
    owner = new WorkspaceTabActions(
      f.workspace,
      f.configuration,
      {} as WorkspaceSessionDescriptions,
      () => ({ duplicate }) as unknown as TerminalSessionUi,
    );
  const task = owner.duplicate(f.id);
  await vi.waitFor(() => expect(duplicate).toHaveBeenCalledOnce());
  expect(() => owner.duplicate(f.id)).toThrow('BUSY');
  let closed = false;
  const closing = owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(signal?.aborted).toBe(true);
  expect(closed).toBe(false);
  complete(crypto.randomUUID());
  await task;
  await closing;
  expect(f.listeners.size).toBe(0);
  await f.workspace.dispose();
});
it('rejects a queued action when its generation retires before IO', async () => {
  const f = fixture(),
    duplicate = vi.fn(),
    owner = new WorkspaceTabActions(
      f.workspace,
      f.configuration,
      {} as WorkspaceSessionDescriptions,
      () => ({ duplicate }) as unknown as TerminalSessionUi,
    );
  const task = owner.duplicate(f.id);
  f.retire();
  await expect(task).rejects.toThrow();
  expect(duplicate).not.toHaveBeenCalled();
  await owner.close();
  await f.workspace.dispose();
});
it('delegates portable duplication to its source and keeps the original pane, title and pin', async () => {
  const f = fixture('web-session');
  f.workspace.arrange.setLayout('c2');
  f.workspace.arrange.moveToPane(f.id, 1);
  f.workspace.arrange.pinTab(f.id);
  const created = crypto.randomUUID(),
    restore = vi.fn(async (_input: unknown, _generation: string, _signal: AbortSignal) => {
      f.workspace.registerTab(
        { id: created, kind: 'web-session', title: 'Owner default' },
        async () => {},
      );
      return created;
    });
  const source = {
    describe: () => ({
      id: f.id,
      kind: 'web' as const,
      title: 'Selected target',
      bookmarkId: crypto.randomUUID(),
      pinned: true,
      paneIndex: 1,
    }),
    restore,
  } as unknown as WorkspaceSessionDescriptions;
  const owner = new WorkspaceTabActions(f.workspace, f.configuration, source, () => undefined);
  await owner.duplicate(f.id);
  expect(restore).toHaveBeenCalledOnce();
  expect(restore.mock.calls[0]?.[1]).toBe(f.generation);
  expect(f.workspace.getSnapshot().tabs.find((tab) => tab.id === created)).toMatchObject({
    title: 'Selected target',
    paneIndex: 1,
    pinned: true,
  });
  await owner.close();
  await f.workspace.dispose();
});
