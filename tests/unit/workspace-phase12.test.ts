import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionSchema, DEFAULT_TERMINAL_BEHAVIOR } from '../../packages/contracts/src';
import { parseQuickConnect } from '../../packages/shared/src';

vi.mock('../../apps/desktop/src/renderer/src/components/terminal-view', () => ({
  TerminalView: () => null,
}));

import {
  paneCount,
  paneTabsInDisplayOrder,
  useWorkspace,
  type PersistedWorkspaceLayout,
  type TerminalTab,
  type WorkspaceLayoutMode,
} from '../../apps/desktop/src/renderer/src/stores/workspace';

const tabs: TerminalTab[] = [
  { id: 'a', title: 'Alpha', kind: 'local', disconnected: false, pinned: false },
  {
    id: 'b',
    title: 'Beta',
    kind: 'ssh',
    hostId: 'host-b',
    connectionId: 'connection-b',
    disconnected: false,
    pinned: false,
  },
  { id: 'c', title: 'Gamma', kind: 'local', disconnected: false, pinned: false },
  { id: 'd', title: 'Delta', kind: 'local', disconnected: false, pinned: false },
];

function persistedTabs(source: TerminalTab[]) {
  return source.map(({ disconnected: _disconnected, pinned = false, ...tab }) => ({
    ...tab,
    pinned,
  }));
}

function resetWorkspace(overrides: Partial<ReturnType<typeof useWorkspace.getState>> = {}) {
  useWorkspace.setState(
    {
      ...useWorkspace.getInitialState(),
      tabs: tabs.map((tab) => ({ ...tab })),
      activeTerminalId: 'a',
      contentSurface: 'terminal',
      ...overrides,
    },
    true,
  );
}

describe('Phase 12 quick connect parsing', () => {
  it('requires exactly one persistent host or ephemeral target at the REST boundary', () => {
    const hostId = '11111111-1111-4111-8111-111111111111';
    expect(createConnectionSchema.safeParse({ hostId }).success).toBe(true);
    expect(
      createConnectionSchema.safeParse({
        target: { hostname: 'host.example.com', username: 'operator' },
      }).success,
    ).toBe(true);
    expect(createConnectionSchema.safeParse({}).success).toBe(false);
    expect(
      createConnectionSchema.safeParse({
        hostId,
        target: { hostname: 'host.example.com', username: 'operator' },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['host.example.com', { hostname: 'host.example.com', port: 22 }],
    [
      'operator@host.example.com:2202',
      { hostname: 'host.example.com', port: 2202, username: 'operator' },
    ],
    [
      ' ssh://release%20operator@host.example.com:2222 ',
      { hostname: 'host.example.com', port: 2222, username: 'release operator' },
    ],
    [
      'ssh://operator:p%40ss@host.example.com:2222',
      {
        hostname: 'host.example.com',
        port: 2222,
        username: 'operator',
        temporarySecret: 'p@ss',
      },
    ],
  ])('parses %s', (input, expected) => {
    expect(parseQuickConnect(input)).toMatchObject({ protocol: 'ssh', ...expected });
  });

  it('recognizes non-SSH protocols for the application capability gate', () => {
    expect(parseQuickConnect('https://host.example.com/path')).toMatchObject({
      protocol: 'https',
      url: 'https://host.example.com/path',
    });
  });

  it.each([
    '',
    '   ',
    'ssh://',
    'ssh://host.example.com:0',
    'ssh://host.example.com:65536',
    'operator@host.example.com:not-a-port',
  ])('rejects invalid target %j', (input) => {
    expect(parseQuickConnect(input)).toBeNull();
  });
});

describe('Phase 12 workspace pane state', () => {
  beforeEach(() => resetWorkspace());

  it('keeps terminal selection independent from the contextual activity panel', () => {
    useWorkspace.getState().setSection('files');

    let state = useWorkspace.getState();
    expect(state.section).toBe('files');
    expect(state.contentSurface).toBe('terminal');
    expect(state.activeTerminalId).toBe('a');

    useWorkspace.getState().showSection();
    state = useWorkspace.getState();
    expect(state.contentSurface).toBe('section');
    expect(state.activeTerminalId).toBe('a');

    useWorkspace.getState().setActiveTerminal('b');
    state = useWorkspace.getState();
    expect(state.contentSurface).toBe('terminal');
    expect(state.activeTerminalId).toBe('b');
  });

  it('keeps Terminal/File Manager and SSH/SFTP as modes of their owning session tab', () => {
    useWorkspace.getState().setTerminalSessionMode('a', 'files');
    let state = useWorkspace.getState();
    expect(state).toMatchObject({
      activeTerminalId: 'a',
      contentSurface: 'terminal',
      terminalSessionModes: { a: 'files' },
    });

    useWorkspace.getState().setTerminalSessionMode('b', 'files');
    state = useWorkspace.getState();
    expect(state.activeTerminalId).toBe('b');
    expect(state.terminalSessionModes).toMatchObject({ a: 'files', b: 'files' });

    useWorkspace.getState().setTerminalSessionMode('b', 'terminal');
    expect(useWorkspace.getState().terminalSessionModes.b).toBe('terminal');

    useWorkspace.getState().setTerminalSessionMode('a', 'files');
    useWorkspace.getState().closeTerminal('a');
    expect(useWorkspace.getState().terminalSessionModes.a).toBeUndefined();
  });

  it('returns to the selected section after the final terminal closes', () => {
    resetWorkspace({ tabs: [tabs[0]!], paneTerminalIds: ['a'] });
    useWorkspace.getState().closeTerminal('a');

    expect(useWorkspace.getState()).toMatchObject({
      tabs: [],
      activeTerminalId: undefined,
      contentSurface: 'section',
    });
  });

  it('maps every supported layout to one through four stable pane positions', () => {
    const expected: Record<WorkspaceLayoutMode, number> = {
      c1: 1,
      c2: 2,
      r2: 2,
      c3: 3,
      r3: 3,
      c2x2: 4,
      c1r2: 3,
      r1c2: 3,
    };

    for (const [layout, count] of Object.entries(expected) as Array<
      [WorkspaceLayoutMode, number]
    >) {
      expect(paneCount(layout)).toBe(count);
      useWorkspace.getState().setLayoutMode(layout);
      const state = useWorkspace.getState();
      expect(state.paneTerminalIds).toHaveLength(count);
      expect(state.paneTerminalIds.filter(Boolean)).toEqual(['a']);
      expect(state.paneTerminalIds).toContain(state.activeTerminalId);
      expect(state.split).toBe(layout !== 'c1');
    }
  });

  it('keeps the current session and creates empty panes when a layout expands', () => {
    useWorkspace.getState().setLayoutMode('c1');
    useWorkspace.getState().setLayoutMode('c2x2');

    expect(useWorkspace.getState().paneTerminalIds).toEqual(['a', null, null, null]);
    expect(useWorkspace.getState().tabs).toHaveLength(4);
  });

  it('merges every pane batch when toggleSplit collapses and expands back with an empty pane', () => {
    useWorkspace.getState().setLayoutMode('c2');
    useWorkspace.getState().moveTerminalToPane('b', 1);
    useWorkspace.getState().moveTerminalToPane('c', 1);
    useWorkspace.getState().setActiveTerminal('c');

    useWorkspace.getState().toggleSplit();
    let state = useWorkspace.getState();
    expect(state.layoutMode).toBe('c1');
    expect(state.focusedPane).toBe(0);
    expect(state.activeTerminalId).toBe('c');
    expect(state.paneTerminalIds).toEqual(['c']);
    expect(state.tabs.every((tab) => tab.paneIndex === 0)).toBe(true);

    useWorkspace.getState().toggleSplit();
    state = useWorkspace.getState();
    expect(state.layoutMode).toBe('c2');
    expect(state.paneTerminalIds).toEqual(['c', null]);
    expect(state.tabs.every((tab) => tab.paneIndex === 0)).toBe(true);
  });

  it('swaps an already visible terminal instead of duplicating it', () => {
    useWorkspace.getState().setLayoutMode('c2x2');
    useWorkspace.getState().setPaneTerminal(1, 'b');
    useWorkspace.getState().setPaneTerminal(2, 'c');
    useWorkspace.getState().setPaneTerminal(3, 'd');
    expect(useWorkspace.getState().paneTerminalIds).toEqual(['a', 'b', 'c', 'd']);

    useWorkspace.getState().setPaneTerminal(0, 'c');
    expect(useWorkspace.getState().paneTerminalIds).toEqual(['c', 'b', null, 'd']);
    expect(useWorkspace.getState().activeTerminalId).toBe('c');
    expect(useWorkspace.getState().focusedPane).toBe(0);

    useWorkspace.getState().swapPanes(1, 3);
    expect(useWorkspace.getState().paneTerminalIds).toEqual(['c', 'd', null, 'b']);
    expect(useWorkspace.getState().tabs.find((tab) => tab.id === 'b')?.paneIndex).toBe(3);
    expect(useWorkspace.getState().tabs.find((tab) => tab.id === 'd')?.paneIndex).toBe(1);
  });

  it('fills only a closed assigned pane and keeps focus and active session coherent', () => {
    useWorkspace.getState().setLayoutMode('c3');
    useWorkspace.getState().setPaneTerminal(1, 'b');
    useWorkspace.getState().setPaneTerminal(2, 'c');
    useWorkspace.getState().moveTerminal('d', 'b', true);
    useWorkspace.getState().setActiveTerminal('b');
    useWorkspace.getState().focusPane(1);
    expect(useWorkspace.getState().activeTerminalId).toBe('b');

    useWorkspace.getState().closeTerminal('b');
    let state = useWorkspace.getState();
    expect(state.paneTerminalIds).toEqual(['a', 'd', 'c']);
    expect(state.focusedPane).toBe(1);
    expect(state.activeTerminalId).toBe('d');

    useWorkspace.getState().closeTerminal('c');
    state = useWorkspace.getState();
    expect(state.paneTerminalIds).toEqual(['a', 'd', null]);
    expect(state.focusedPane).toBe(1);
    expect(state.activeTerminalId).toBe('d');

    useWorkspace.getState().closeTerminal('d');
    state = useWorkspace.getState();
    expect(state.paneTerminalIds).toEqual(['a', null, null]);
    expect(state.focusedPane).toBe(1);
    expect(state.activeTerminalId).toBe('a');
  });

  it('does not fill an empty pane when an unassigned tab closes', () => {
    useWorkspace.getState().setLayoutMode('c2x2');
    useWorkspace.getState().closeTerminal('b');

    expect(useWorkspace.getState().paneTerminalIds).toEqual(['a', null, null, null]);
  });

  it('restores a legacy split layout and marks restored sessions disconnected', () => {
    const legacyLayout: PersistedWorkspaceLayout = {
      section: 'commands',
      sidebarOpen: false,
      split: true,
      tabs: persistedTabs(tabs.slice(0, 3)),
      activeTerminalId: 'b',
      secondaryTerminalId: 'a',
    };

    useWorkspace.getState().restoreLayout(legacyLayout);
    const state = useWorkspace.getState();
    expect(state.section).toBe('commands');
    expect(state.sidebarOpen).toBe(false);
    expect(state.layoutMode).toBe('c2');
    expect(state.split).toBe(true);
    expect(state.paneTerminalIds).toEqual(['b', 'a']);
    expect(state.activeTerminalId).toBe('b');
    expect(state.contentSurface).toBe('terminal');
    expect(state.tabs.every((tab) => tab.disconnected)).toBe(true);
  });

  it('reattaches only terminal ids that still belong to the current Runtime generation', () => {
    const layout: PersistedWorkspaceLayout = {
      section: 'hosts',
      contentSurface: 'terminal',
      sidebarOpen: true,
      split: false,
      tabs: persistedTabs(tabs.slice(0, 2)).map((tab) =>
        tab.id === 'b'
          ? {
              ...tab,
              behavior: {
                ...DEFAULT_TERMINAL_BEHAVIOR,
                pasteProtection: false,
                osc52Enabled: true,
                osc52ReadPolicy: 'allow' as const,
                osc52WritePolicy: 'deny' as const,
              },
            }
          : tab,
      ),
      activeTerminalId: 'b',
      secondaryTerminalId: null,
      layoutMode: 'c1',
      paneTerminalIds: ['b'],
      focusedPane: 0,
    };

    useWorkspace.getState().restoreLayout(layout, new Set(['b', 'not-in-layout']));
    const state = useWorkspace.getState();
    expect(state.tabs.find((tab) => tab.id === 'a')?.disconnected).toBe(true);
    expect(state.tabs.find((tab) => tab.id === 'b')?.disconnected).toBe(false);
    expect(state.tabs.find((tab) => tab.id === 'b')?.behavior).toEqual({
      ...DEFAULT_TERMINAL_BEHAVIOR,
      pasteProtection: false,
      osc52Enabled: true,
      osc52ReadPolicy: 'allow',
      osc52WritePolicy: 'deny',
    });
    expect(state.contentSurface).toBe('terminal');
  });

  it('restores the new layout, removes invalid or duplicate pane ids, and bounds focus', () => {
    const layout: PersistedWorkspaceLayout = {
      section: 'hosts',
      contentSurface: 'section',
      sidebarOpen: true,
      split: true,
      tabs: persistedTabs(
        tabs.map((tab) => ({
          ...tab,
          paneIndex: tab.id === 'b' || tab.id === 'a' ? 3 : 0,
        })),
      ),
      activeTerminalId: 'a',
      secondaryTerminalId: 'c',
      layoutMode: 'c2x2',
      paneTerminalIds: ['c', null, 'c', 'b'],
      focusedPane: 99,
    };

    useWorkspace.getState().restoreLayout(layout);
    const state = useWorkspace.getState();
    expect(state.paneTerminalIds).toEqual(['c', null, null, 'a']);
    expect(state.paneTerminalIds.filter(Boolean)).toEqual(['c', 'a']);
    expect(state.focusedPane).toBe(3);
    expect(state.contentSurface).toBe('section');
    expect(state.secondaryTerminalId).toBeUndefined();
    expect(state.tabs.find((tab) => tab.id === 'b')).toMatchObject({
      pinned: false,
      disconnected: true,
      connectionId: 'connection-b',
    });
  });

  it('keeps the workspace layout but disconnects every tab on generation change', () => {
    useWorkspace.getState().setLayoutMode('c1r2');
    useWorkspace.getState().focusPane(2);
    const before = useWorkspace.getState();

    useWorkspace.getState().clearForGeneration();
    const after = useWorkspace.getState();
    expect(after.tabs.every((tab) => tab.disconnected)).toBe(true);
    expect(after.layoutMode).toBe(before.layoutMode);
    expect(after.paneTerminalIds).toEqual(before.paneTerminalIds);
    expect(after.focusedPane).toBe(before.focusedPane);
    expect(after.activeTerminalId).toBe(before.activeTerminalId);
  });

  it('moves tabs between pane batches and keeps each pane active id independent', () => {
    useWorkspace.getState().setLayoutMode('c2x2');
    useWorkspace.getState().moveTerminalToPane('b', 1);
    useWorkspace.getState().moveTerminalToPane('c', 1);

    let state = useWorkspace.getState();
    expect(state.tabs.filter((tab) => tab.paneIndex === 1).map((tab) => tab.id)).toEqual([
      'b',
      'c',
    ]);
    expect(state.paneTerminalIds).toEqual(['a', 'c', null, null]);

    useWorkspace.getState().setActiveTerminal('b');
    state = useWorkspace.getState();
    expect(state.focusedPane).toBe(1);
    expect(state.activeTerminalId).toBe('b');
    expect(state.paneTerminalIds).toEqual(['a', 'b', null, null]);
  });

  it('renders a stable pinned-first pane batch without changing canonical tab order', () => {
    useWorkspace.getState().setLayoutMode('c2');
    useWorkspace.getState().moveTerminalToPane('c', 1);
    useWorkspace.getState().moveTerminalToPane('d', 1);
    useWorkspace.getState().pinTerminal('d');

    const state = useWorkspace.getState();
    expect(state.tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(paneTabsInDisplayOrder(state.tabs, 0).map((tab) => tab.id)).toEqual(['a', 'b']);
    expect(paneTabsInDisplayOrder(state.tabs, 1).map((tab) => tab.id)).toEqual(['d', 'c']);
  });

  it('inserts duplicates beside their source and replaces reloads in place', () => {
    useWorkspace.getState().setLayoutMode('c2');
    useWorkspace.getState().moveTerminalToPane('b', 1);
    useWorkspace.getState().pinTerminal('b');
    useWorkspace.getState().insertTerminalAfter('b', {
      id: 'copy',
      title: 'Beta',
      kind: 'ssh',
      connectionId: 'connection-b',
      disconnected: false,
      pinned: true,
    });

    let state = useWorkspace.getState();
    expect(state.tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'copy', 'c', 'd']);
    expect(state.tabs.find((tab) => tab.id === 'copy')).toMatchObject({
      title: 'Beta',
      paneIndex: 1,
      pinned: true,
    });
    expect(state.paneTerminalIds).toEqual(['a', 'copy']);

    useWorkspace.getState().replaceTerminal('copy', {
      id: 'reloaded',
      title: 'must not replace the visible title',
      kind: 'ssh',
      hostId: 'host-b',
      connectionId: 'connection-b-new',
      disconnected: false,
      pinned: false,
      paneIndex: 0,
    });
    state = useWorkspace.getState();
    expect(state.tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'reloaded', 'c', 'd']);
    expect(state.tabs[2]).toMatchObject({
      id: 'reloaded',
      title: 'Beta',
      kind: 'ssh',
      hostId: 'host-b',
      connectionId: 'connection-b-new',
      paneIndex: 1,
      pinned: true,
    });
    expect(state.paneTerminalIds).toEqual(['a', 'reloaded']);
    expect(state.activeTerminalId).toBe('reloaded');
  });
});

describe('Phase 12 pinned tabs', () => {
  beforeEach(() => resetWorkspace());

  it('changes only the pin flag and derives stable pinned-first display order', () => {
    useWorkspace.getState().pinTerminal('b');
    expect(useWorkspace.getState().tabs.map(({ id, pinned }) => [id, pinned])).toEqual([
      ['a', false],
      ['b', true],
      ['c', false],
      ['d', false],
    ]);
    expect(paneTabsInDisplayOrder(useWorkspace.getState().tabs, 0).map((tab) => tab.id)).toEqual([
      'b',
      'a',
      'c',
      'd',
    ]);

    useWorkspace.getState().pinTerminal('d');
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(paneTabsInDisplayOrder(useWorkspace.getState().tabs, 0).map((tab) => tab.id)).toEqual([
      'b',
      'd',
      'a',
      'c',
    ]);

    useWorkspace.getState().pinTerminal('b');
    expect(useWorkspace.getState().tabs.map(({ id, pinned }) => [id, pinned])).toEqual([
      ['a', false],
      ['b', false],
      ['c', false],
      ['d', true],
    ]);
    expect(paneTabsInDisplayOrder(useWorkspace.getState().tabs, 0).map((tab) => tab.id)).toEqual([
      'd',
      'a',
      'b',
      'c',
    ]);
  });
});

describe('Phase 16 file workspace layout', () => {
  beforeEach(() => resetWorkspace());

  it('retains the selected pane mode and bounds keyboard or pointer resizing', () => {
    useWorkspace.getState().setFileManagerView('local');
    useWorkspace.getState().setFileManagerSplitPercent(10);
    expect(useWorkspace.getState()).toMatchObject({
      fileManagerView: 'local',
      fileManagerSplitPercent: 25,
    });
    useWorkspace.getState().setFileManagerView('split');
    useWorkspace.getState().setFileManagerSplitPercent(82);
    expect(useWorkspace.getState()).toMatchObject({
      fileManagerView: 'split',
      fileManagerSplitPercent: 75,
    });
  });
});
