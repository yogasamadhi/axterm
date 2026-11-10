import { randomUUID } from 'node:crypto';
import { expect, it, vi, afterEach } from 'vitest';
import {
  workspacePresentationSchema,
  type ConfigurationClientActions,
  type SettingsBaseline,
  type WorkspacePresentation,
  type WorkspacePresentationRecord,
} from '@axterm/plugin-api/configuration';
import { WorkspaceStore } from '../../packages/plugins/workspace/src/client/store.ts';
import {
  WorkspacePresentationOwner,
  PresentationStatusStore,
} from '../../packages/plugins/workspace/src/client/presentation.ts';
afterEach(() => vi.unstubAllGlobals());
const documentFor = (id: string, title = 'Explicit title'): WorkspacePresentation => ({
  section: 'sessions',
  sidebarOpen: false,
  activeTabId: id,
  tabs: [{ id, kind: 'terminal', caption: title, title }],
});
function fixture(
  record?: WorkspacePresentationRecord,
  coldRestore?: boolean,
  legacyAi = false,
  legacySplit = false,
) {
  vi.stubGlobal('window', new EventTarget());
  const generation = randomUUID(),
    key = 'a'.repeat(32) + '_desktop_0',
    listeners = new Set<() => void>();
  let state: ReturnType<ConfigurationClientActions['getSnapshot']> = {
    status: 'ready',
    baseline: {
      generation,
      cursor: 0,
      settings: {
        workspace: {
          importRevision: 0,
          restoreLayout: coldRestore ?? false,
          ...(legacyAi || legacySplit
            ? {
                aiInspectorOpen: legacyAi,
                layout: {
                  section: 'hosts',
                  sidebarOpen: false,
                  layoutMode: legacySplit ? 'c1' : 'c2',
                  split: legacySplit,
                  focusedPane: 0,
                },
              }
            : {}),
          presentations: record
            ? {
                [key]: {
                  ...record,
                  generation: coldRestore === undefined ? generation : record.generation,
                },
              }
            : {},
        },
        version: 1,
      } as unknown as SettingsBaseline['settings'],
    },
  };
  const actions = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    bindWorkspacePresentation: vi.fn(async () => ({
      key,
      importRevision: 0,
      generation: state.status === 'ready' ? state.baseline.generation : generation,
    })),
    saveWorkspacePresentation: vi.fn(
      async (commandId: string, _slot: string, input: WorkspacePresentation, version: number) => {
        if (state.status !== 'ready') throw Error('not ready');
        state = {
          status: 'ready',
          baseline: {
            ...state.baseline,
            cursor: state.baseline.cursor + 1,
            settings: {
              ...state.baseline.settings,
              workspace: {
                ...state.baseline.settings.workspace,
                presentations: {
                  [key]: {
                    version: version + 1,
                    generation,
                    lastCommandId: commandId,
                    presentation: input,
                  },
                },
              },
            },
          },
        };
        for (const listener of [...listeners]) listener();
        return { version: version + 1, settingsVersion: 2, cursor: state.baseline.cursor };
      },
    ),
  };
  const workspace = new WorkspaceStore();
  workspace.registerNavigation({ id: 'sessions', label: 'Sessions', icon: null });
  const status = new PresentationStatusStore(),
    owner = new WorkspacePresentationOwner(
      workspace,
      actions as unknown as ConfigurationClientActions,
      'desktop_0',
      status,
    );
  return {
    workspace,
    status,
    owner,
    actions,
    listeners,
    generation,
    importSettings: () => {
      if (state.status === 'ready')
        state = {
          status: 'ready',
          baseline: {
            ...state.baseline,
            settings: {
              ...state.baseline.settings,
              workspace: {
                ...state.baseline.settings.workspace,
                importRevision: 1,
                presentations: {},
              },
            },
          },
        };
      for (const listener of listeners) listener();
    },
    retire: () => {
      if (state.status === 'ready')
        state = { status: 'ready', baseline: { ...state.baseline, generation: randomUUID() } };
      for (const listener of listeners) listener();
    },
  };
}
it('restores selection and explicit titles only onto owned live registrations and leaves business defaults separate', async () => {
  const id = randomUUID(),
    f = fixture({
      version: 2,
      generation: randomUUID(),
      lastCommandId: randomUUID(),
      presentation: documentFor(id),
    });
  await vi.waitFor(() => expect(f.status.getSnapshot()).toBe('ready'));
  expect(f.workspace.getSnapshot().tabs).toEqual([]);
  expect(f.actions.saveWorkspacePresentation).not.toHaveBeenCalled();
  const tab = f.workspace.registerTab(
    { id, kind: 'terminal', title: 'Backend default' },
    async () => {},
  );
  expect(f.workspace.getSnapshot().activeTabId).toBe(id);
  expect(f.workspace.getSnapshot().tabs[0]?.title).toBe('Explicit title');
  tab.update({ id, kind: 'terminal', title: 'Updated backend default' });
  expect(f.workspace.getSnapshot().tabs[0]?.title).toBe('Explicit title');
  tab.present?.({ title: 'User renamed' });
  await vi.waitFor(() => expect(f.actions.saveWorkspacePresentation).toHaveBeenCalledOnce());
  expect(f.actions.saveWorkspacePresentation.mock.calls[0]?.[2].tabs[0]?.title).toBe(
    'User renamed',
  );
  await f.owner.close();
  await f.workspace.dispose();
  expect(f.listeners.size).toBe(0);
});
it('retains an unknown save with the same key and precondition, and coalesces only the latest later UI change', async () => {
  const f = fixture(),
    id = randomUUID();
  await vi.waitFor(() => expect(f.status.getSnapshot()).toBe('ready'));
  const tab = f.workspace.registerTab({ id, kind: 'terminal', title: 'Local' }, async () => {});
  f.actions.saveWorkspacePresentation.mockRejectedValueOnce(Error('lost response'));
  tab.activate();
  await vi.waitFor(() => expect(f.status.getSnapshot()).toBe('error'));
  const original = f.actions.saveWorkspacePresentation.mock.calls[0];
  tab.present?.({ title: 'Latest' });
  expect(f.actions.saveWorkspacePresentation).toHaveBeenCalledOnce();
  await f.owner.retry();
  expect(f.actions.saveWorkspacePresentation.mock.calls[1]).toEqual(original);
  expect(f.actions.saveWorkspacePresentation).toHaveBeenCalledTimes(3);
  expect(f.actions.saveWorkspacePresentation.mock.calls[2]?.[2].tabs[0]?.title).toBe('Latest');
  await f.owner.close();
  await f.workspace.dispose();
});
it('joins pending persistence on withdrawal and does not erase presentation when registrations subsequently withdraw', async () => {
  const f = fixture(),
    pending = Promise.withResolvers<{ version: number; settingsVersion: number; cursor: number }>();
  await vi.waitFor(() => expect(f.status.getSnapshot()).toBe('ready'));
  f.actions.saveWorkspacePresentation.mockImplementationOnce(() => pending.promise);
  f.workspace
    .registerTab({ id: randomUUID(), kind: 'terminal', title: 'Local' }, async () => {})
    .activate();
  await vi.waitFor(() => expect(f.actions.saveWorkspacePresentation).toHaveBeenCalledOnce());
  let closed = false;
  const closing = f.owner.close().then(() => {
    closed = true;
  });
  expect(closed).toBe(false);
  pending.resolve({ version: 1, settingsVersion: 2, cursor: 1 });
  await closing;
  await f.workspace.dispose();
  expect(f.actions.saveWorkspacePresentation).toHaveBeenCalledOnce();
  expect(f.listeners.size).toBe(0);
});
it('accepts a late owned fact after a lost response without retrying the write or leaving a false error', async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.status.getSnapshot()).toBe('ready'));
  const publish = f.actions.saveWorkspacePresentation.getMockImplementation()!;
  f.actions.saveWorkspacePresentation.mockRejectedValueOnce(Error('lost response'));
  f.workspace
    .registerTab({ id: randomUUID(), kind: 'terminal', title: 'Local' }, async () => {})
    .activate();
  await vi.waitFor(() => expect(f.status.getSnapshot()).toBe('error'));
  await publish(...f.actions.saveWorkspacePresentation.mock.calls[0]!);
  expect(f.status.getSnapshot()).toBe('ready');
  expect(f.actions.saveWorkspacePresentation).toHaveBeenCalledOnce();
  await f.owner.close();
  await f.workspace.dispose();
});
it('bounds persisted UI metadata, rejects executable/authorization fields, and supports plugin-owned non-UUID tab references', () => {
  expect(workspacePresentationSchema.parse(documentFor('plugin:example')).tabs[0]?.id).toBe(
    'plugin:example',
  );
  expect(
    workspacePresentationSchema.safeParse({ ...documentFor('one'), credentialRef: 'no' }).success,
  ).toBe(false);
  expect(
    workspacePresentationSchema.safeParse({
      ...documentFor('one'),
      tabs: [...documentFor('one').tabs, ...documentFor('one').tabs],
    }).success,
  ).toBe(false);
});
it('retires an uncertain old-generation save instead of replaying it into a replacement Host', async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.status.getSnapshot()).toBe('ready'));
  f.actions.saveWorkspacePresentation.mockRejectedValueOnce(Error('unknown old save'));
  f.workspace
    .registerTab({ id: randomUUID(), kind: 'terminal', title: 'Old view' }, async () => {})
    .activate();
  await vi.waitFor(() => expect(f.status.getSnapshot()).toBe('error'));
  f.retire();
  await vi.waitFor(() => expect(f.status.getSnapshot()).toBe('ready'));
  expect(f.actions.bindWorkspacePresentation).toHaveBeenCalledTimes(2);
  expect(f.actions.saveWorkspacePresentation).toHaveBeenCalledOnce();
  await f.owner.close();
  await f.workspace.dispose();
});

it('fences stale autosave immediately when another window imports settings', async () => {
  const f = fixture();
  await vi.waitFor(() => expect(f.status.getSnapshot()).toBe('ready'));
  f.importSettings();
  expect(f.status.getSnapshot()).toBe('restart-required');
  f.workspace.registerTab(
    { id: randomUUID(), kind: 'terminal', title: 'Kept running' },
    async () => {},
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(f.actions.saveWorkspacePresentation).not.toHaveBeenCalled();
  await f.owner.retry();
  expect(f.status.getSnapshot()).toBe('restart-required');
  expect(f.actions.saveWorkspacePresentation).not.toHaveBeenCalled();
  await f.owner.close();
  await f.workspace.dispose();
});

it.each([false, true])('adopts only pure cold layout when restoreLayout is %s', async (enabled) => {
  const f = fixture(
    {
      version: 1,
      generation: randomUUID(),
      lastCommandId: randomUUID(),
      presentation: {
        ...documentFor(randomUUID()),
        layout: { mode: 'c2', paneTabIds: [null, null], focusedPane: 0 },
      },
    },
    enabled,
  );
  await vi.waitFor(() => expect(f.status.getSnapshot()).toBe('ready'));
  expect(f.workspace.getSnapshot().tabs).toEqual([]);
  expect(f.workspace.getSnapshot().arrangement?.mode).toBe(enabled ? 'c2' : 'c1');
  expect(f.actions.saveWorkspacePresentation).not.toHaveBeenCalled();
  await f.owner.close();
  await f.workspace.dispose();
});

it('restores a retained separate AI panel as the shared sidebar when its actual navigation owner registers late', async () => {
  const f = fixture(undefined, true, true);
  await vi.waitFor(() => expect(f.status.getSnapshot()).toBe('ready'));
  expect(f.workspace.getSnapshot().tabs).toEqual([]);
  f.workspace.registerNavigation({ id: 'ai', label: 'Assistant', icon: null });
  expect(f.workspace.getSnapshot()).toMatchObject({ section: 'ai', sidebarOpen: true, tabs: [] });
  expect(f.workspace.getSnapshot().arrangement).toMatchObject({
    mode: 'c2',
    paneTabIds: [null, null],
  });
  await f.owner.close();
  await f.workspace.dispose();
});

it('retains the legacy split opt-in as two empty owned panes without restoring old execution identities', async () => {
  const f = fixture(undefined, true, false, true);
  await vi.waitFor(() => expect(f.status.getSnapshot()).toBe('ready'));
  expect(f.workspace.getSnapshot().tabs).toEqual([]);
  expect(f.workspace.getSnapshot().arrangement).toMatchObject({
    mode: 'c2',
    paneTabIds: [null, null],
  });
  await f.owner.close();
  await f.workspace.dispose();
});
