import { expect, it, vi } from 'vitest';
import {
  terminalSessionSchema,
  type CreateTerminalInput,
  type TerminalSession,
  type TerminalBaseline,
} from '@axterm/plugin-api/terminals';
import { TerminalSessionActions } from '../../packages/plugins/terminals/src/client/session/actions.ts';
import { TerminalWorkspaceAdmissions } from '../../packages/plugins/terminals/src/client/workspace-owner.ts';
import { WorkspaceStore } from '../../packages/plugins/workspace/src/client/store.ts';
function fixture() {
  const workspace = new WorkspaceStore(),
    listeners = new Set<() => void>(),
    registrations = new Map<string, ReturnType<WorkspaceStore['registerTab']>>();
  let generation = crypto.randomUUID(),
    items: TerminalSession[] = [],
    drop = false;
  const source = terminalSessionSchema.parse({
    id: crypto.randomUUID(),
    kind: 'local',
    title: 'Source',
    state: 'ready',
    createdAt: new Date().toISOString(),
  });
  const add = (session: TerminalSession) => {
    items.push(session);
    registrations.set(
      session.id,
      workspace.registerTab(
        { id: session.id, kind: 'terminal', title: session.title },
        async () => {},
      ),
    );
    for (const listener of [...listeners]) listener();
  };
  add(source);
  workspace.selectTab(source.id);
  const disconnectKeys = new Set<string>();
  const model = {
    getSnapshot: () => ({
      status: 'ready' as const,
      baseline: {
        type: 'baseline',
        revision: 1,
        generation,
        sessions: items,
      } satisfies TerminalBaseline,
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    create: vi.fn(async (input: CreateTerminalInput, _key?: string) => {
      const created = terminalSessionSchema.parse({
        ...source,
        id: crypto.randomUUID(),
        kind: input.kind,
        ...(input.profileId ? { profileId: input.profileId } : {}),
      });
      add(created);
      return created;
    }),
    close: vi.fn(async (id: string, _generation?: string) => {
      items = items.filter((item) => item.id !== id);
      registrations.get(id)?.dispose();
      registrations.delete(id);
      for (const listener of [...listeners]) listener();
    }),
    disconnect: vi.fn(async (key: string, id: string, _generation: string) => {
      disconnectKeys.add(key);
      items = items.map((item) => (item.id === id ? { ...item, state: 'closed' } : item));
      for (const listener of [...listeners]) listener();
      if (drop) {
        drop = false;
        throw Error('controlled lost response');
      }
      return items.find((item) => item.id === id)!;
    }),
    getCommandOutcome: vi.fn(async (_generation: string, _key: string) => ({
      status: 'accepted' as const,
      id: source.id,
    })),
  };
  const admissions = new TerminalWorkspaceAdmissions(model, (id) => workspace.selectTab(id));
  const connections = {
    getSnapshot: () => ({ status: 'connecting' as const }),
    subscribe: (_listener: () => void) => () => {},
    retryConnection: vi.fn(async () => {
      throw Error('not selected');
    }),
    cancelReconnect: vi.fn(async () => {
      throw Error('not selected');
    }),
  };
  const actions = new TerminalSessionActions(
    model,
    admissions,
    workspace,
    connections,
    () => undefined,
    (id, oldId) => {
      const old = workspace.getSnapshot().tabs.find((tab) => tab.id === oldId)!;
      registrations.get(id)!.present!({ title: old.title });
    },
  );
  return {
    workspace,
    model,
    actions,
    source,
    disconnectKeys,
    listeners,
    dropNext() {
      drop = true;
    },
    retire() {
      generation = crypto.randomUUID();
      for (const listener of [...listeners]) listener();
      actions.retire(generation);
    },
    async close() {
      await actions.close();
      await admissions.dispose();
      await workspace.dispose();
    },
  };
}
it('reloads a pinned renamed tab into the same pane and closes only the original accepted resource', async () => {
  const f = fixture();
  try {
    f.workspace.arrange.setLayout('c2');
    f.workspace.arrange.moveToPane(f.source.id, 1);
    f.workspace.arrange.pinTab(f.source.id);
    f.workspace.arrange.renameTab(f.source.id, 'Kept title');
    const created = await f.actions.reload(f.source.id);
    expect(f.model.create).toHaveBeenCalledOnce();
    expect(f.model.close).toHaveBeenCalledWith(f.source.id, expect.any(String));
    expect(f.workspace.getSnapshot().tabs).toMatchObject([
      { id: created, title: 'Kept title', pinned: true, paneIndex: 1 },
    ]);
    expect(f.workspace.getSnapshot().activeTabId).toBe(created);
  } finally {
    await f.close();
  }
});
it('clones into the next pane without closing the source or moving the existing visible tab out of its pane', async () => {
  const f = fixture();
  try {
    const created = await f.actions.duplicate(f.source.id, true);
    expect(f.model.close).not.toHaveBeenCalled();
    expect(f.workspace.getSnapshot().arrangement).toMatchObject({
      mode: 'c2',
      paneTabIds: [f.source.id, created],
    });
    expect(f.workspace.getSnapshot().activeTabId).toBe(created);
  } finally {
    await f.close();
  }
});
it('retains an unknown disconnect intent, blocks replacement, and retries the exact original key even after metadata closes', async () => {
  const f = fixture();
  try {
    f.dropNext();
    await expect(f.actions.disconnect(f.source.id)).rejects.toThrow('lost response');
    expect(f.actions.getSnapshot().uncertain).toEqual([f.source.id]);
    await expect(f.actions.reload(f.source.id)).rejects.toThrow('OUTCOME_UNCERTAIN');
    expect(f.model.create).not.toHaveBeenCalled();
    await f.actions.disconnect(f.source.id);
    expect(f.model.disconnect.mock.calls[1]).toEqual(f.model.disconnect.mock.calls[0]);
    expect(f.disconnectKeys.size).toBe(1);
    expect(f.actions.getSnapshot().uncertain).toEqual([]);
    expect(f.listeners.size).toBe(0);
  } finally {
    await f.close();
  }
});
it('does not retarget old-generation cleanup to a replacement Host', async () => {
  const f = fixture();
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.model.create.mockImplementationOnce(async (input) => {
      await gate;
      f.retire();
      return terminalSessionSchema.parse({
        ...f.source,
        kind: input.kind,
        id: crypto.randomUUID(),
      });
    });
    const opening = f.actions.reload(f.source.id);
    const rejected = expect(opening).rejects.toThrow('RETIRED');
    await vi.waitFor(() => expect(f.model.create).toHaveBeenCalledOnce());
    release();
    await rejected;
    expect(f.model.close).not.toHaveBeenCalled();
    expect(f.workspace.getSnapshot().tabs.map((tab) => tab.id)).toEqual([f.source.id]);
  } finally {
    await f.close();
  }
});

it('reloads only the captured batch once and stops after a generation change', async () => {
  const f = fixture();
  try {
    await f.actions.duplicate(f.source.id);
    f.model.create.mockClear();
    f.model.close.mockClear();
    await f.actions.reloadAll();
    expect(f.model.create).toHaveBeenCalledTimes(2);
    expect(f.model.close).toHaveBeenCalledTimes(2);
    expect(f.workspace.getSnapshot().tabs).toHaveLength(2);
    f.model.create.mockClear();
    f.model.close.mockImplementationOnce(async () => {
      f.retire();
    });
    await expect(f.actions.reloadAll()).rejects.toThrow('TERMINAL_SESSION_RETIRED');
    expect(f.model.create).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});
it('joins a pending batch on unload and rejects a duplicate batch', async () => {
  const f = fixture();
  try {
    const batch = f.actions.reloadAll();
    await expect(f.actions.reloadAll()).rejects.toThrow('TERMINAL_SESSION_BUSY');
    await batch;
    const next = f.actions.reloadAll();
    const result = expect(next).rejects.toThrow();
    await f.actions.close();
    await result;
  } finally {
    await f.close();
  }
});
