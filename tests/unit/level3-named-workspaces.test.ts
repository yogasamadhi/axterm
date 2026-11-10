import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type {
  ConfigurationClientActions,
  SettingsBaseline,
  WorkspacePresentation,
} from '@axterm/plugin-api/configuration';
import { WorkspaceStore } from '../../packages/plugins/workspace/src/client/store.ts';
import { SessionDescriptions } from '../../packages/plugins/workspace/src/client/session-descriptions.ts';
import { NamedWorkspaces } from '../../packages/plugins/workspace/src/client/named-workspaces.ts';
function fixture() {
  const generation = randomUUID(),
    listeners = new Set<() => void>(),
    workspace = new WorkspaceStore(),
    sources = new SessionDescriptions();
  let baseline = {
    generation,
    cursor: 0,
    settings: { version: 1, workspace: { namedWorkspaces: [], activeWorkspaceId: null } },
  } as unknown as SettingsBaseline;
  const writes = new Map<string, unknown>();
  const write = vi.fn(
    async (key: string, input: Record<string, unknown>, ifMatch: string, selected: string) => {
      if (selected !== generation || ifMatch !== '"v' + baseline.settings.version + '"')
        throw Error('reference changed');
      if (writes.has(key)) throw Error('unexpected replay');
      writes.set(key, input);
      baseline = {
        ...baseline,
        cursor: baseline.cursor + 1,
        settings: {
          ...baseline.settings,
          version: baseline.settings.version + 1,
          workspace: { ...baseline.settings.workspace, ...structuredClone(input) },
        },
      };
      for (const listener of listeners) listener();
      return { version: baseline.settings.version, cursor: baseline.cursor };
    },
  );
  const configuration = {
    getSnapshot: () => ({ status: 'ready', baseline }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setWorkspacePreferences: write,
  } as unknown as ConfigurationClientActions;
  const calls = {
    restore: vi.fn(async () => {
      const id = randomUUID();
      workspace.registerTab({ id, kind: 'terminal', title: 'Recreated' }, async () => {});
      return id;
    }),
    resume: vi.fn(),
    close: vi.fn(async () => {}),
  };
  sources.register('terminal', {
    isReady: (selected) => selected === generation,
    subscribe: () => () => {},
    describe: (id) => ({ id, kind: 'local', title: 'Current', pinned: false, paneIndex: 0 }),
    restore: calls.restore,
  });
  const owner = new NamedWorkspaces(workspace, configuration, sources, async () => calls.resume);
  const register = (id = randomUUID()) =>
    workspace.registerTab({ id, kind: 'terminal', title: 'Current' }, calls.close);
  return { owner, workspace, sources, register, calls, write, baseline: () => baseline };
}
it('saves canonical descriptions and pane presentation, confirms overwrite and reuses living sessions', async () => {
  const f = fixture();
  try {
    const first = f.register(),
      id = f.workspace.getSnapshot().tabs[0]!.id;
    first.activate();
    f.workspace.arrange.setLayout('c2');
    await f.owner.save('Review');
    const saved = f.owner.list()[0]!;
    expect(saved.layout.tabs[0]!.kind).toBe('local');
    expect(saved.presentation!.layout!.mode).toBe('c2');
    await expect(f.owner.save('review')).rejects.toThrow('WORKSPACE_OVERWRITE_REQUIRED');
    await f.owner.load(saved.id);
    expect(f.calls.restore).not.toHaveBeenCalled();
    expect(f.workspace.getSnapshot().activeTabId).toBe(id);
    await f.owner.remove(saved.id, saved.updatedAt);
    expect(f.owner.list()).toHaveLength(0);
    expect(f.calls.resume).toHaveBeenCalled();
  } finally {
    await f.owner.close();
    f.sources.close();
    await f.workspace.dispose();
  }
});
it('closes only obsolete registered tabs, recreates missing sessions through their selected owner and remaps IDs', async () => {
  const f = fixture();
  try {
    const first = f.register();
    first.activate();
    await f.owner.save('Cold');
    const saved = f.owner.list()[0]!;
    await f.workspace.closeTab(saved.layout.tabs[0]!.id);
    const other = f.register();
    other.activate();
    await f.owner.load(saved.id);
    expect(f.calls.restore).toHaveBeenCalledOnce();
    expect(f.workspace.getSnapshot().tabs).toHaveLength(1);
    expect(f.workspace.getSnapshot().activeTabId).not.toBe(saved.layout.tabs[0]!.id);
    expect(f.owner.active()).toBe(saved.id);
  } finally {
    await f.owner.close();
    f.sources.close();
    await f.workspace.dispose();
  }
});
it('rejects missing, duplicate and withdrawn description owners without silently dropping sessions', async () => {
  const f = fixture();
  try {
    expect(() =>
      f.sources.register('terminal', {
        isReady: () => true,
        subscribe: () => () => {},
        describe: () => undefined,
        restore: async () => '',
      }),
    ).toThrow();
    f.workspace.registerTab(
      { id: randomUUID(), kind: 'unsupported', title: 'Unsupported' },
      async () => {},
    );
    await expect(f.owner.save('Complete')).rejects.toThrow('WORKSPACE_SOURCE_UNAVAILABLE');
    expect(f.owner.list()).toHaveLength(0);
    f.sources.close();
    expect(() =>
      f.sources.describe({ id: randomUUID(), kind: 'terminal', title: 'Closed' }),
    ).toThrow();
  } finally {
    await f.owner.close();
    await f.workspace.dispose();
  }
});
it('restores a selected presentation in an already-edited workspace without creating application IO', async () => {
  const f = fixture();
  try {
    const tab = f.register();
    tab.activate();
    f.workspace.arrange.setLayout('c2');
    const presentation: WorkspacePresentation = f.workspace.getPresentation();
    f.workspace.arrange.setLayout('r3');
    f.workspace.replacePresentation(presentation);
    expect(f.workspace.getSnapshot().arrangement!.mode).toBe('c2');
    expect(f.calls.restore).not.toHaveBeenCalled();
  } finally {
    await f.owner.close();
    f.sources.close();
    await f.workspace.dispose();
  }
});
it('normalizes older layouts with implicit empty panes before starting any session', async () => {
  const { legacyPresentation } =
    await import('../../packages/plugins/workspace/src/client/named-workspaces.ts');
  const f = fixture();
  try {
    f.register().activate();
    await f.owner.save('Legacy');
    const saved = structuredClone(f.owner.list()[0]!);
    delete saved.presentation;
    saved.layout.layoutMode = 'c3';
    saved.layout.paneTerminalIds = [];
    saved.layout.focusedPane = 3;
    expect(legacyPresentation(saved).layout?.paneTabIds).toHaveLength(3);
    expect(legacyPresentation(saved).layout?.focusedPane).toBe(2);
  } finally {
    await f.owner.close();
    f.sources.close();
    await f.workspace.dispose();
  }
});
it('keeps the named presentation and portable terminal visual references equivalent', async () => {
  const { terminalVisualSettingsSchema } = await import('@axterm/plugin-api/terminals');
  const f = fixture();
  try {
    const tab = f.register();
    tab.activate();
    tab.present?.({ terminalVisual: terminalVisualSettingsSchema.parse({}) });
    await f.owner.save('Visual');
    const saved = f.owner.list()[0]!;
    expect(saved.presentation?.tabs[0]?.terminalVisual).toEqual(saved.layout.tabs[0]?.visual);
  } finally {
    await f.owner.close();
    f.sources.close();
    await f.workspace.dispose();
  }
});
