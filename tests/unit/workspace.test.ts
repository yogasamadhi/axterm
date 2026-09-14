import { beforeEach, describe, expect, it } from 'vitest';
import {
  nextTabNumber,
  useWorkspace,
  type TerminalTab,
} from '../../apps/desktop/src/renderer/src/stores/workspace';

const tabs: TerminalTab[] = [
  { id: 'a', title: 'Alpha', kind: 'local', disconnected: false },
  { id: 'b', title: 'Beta', kind: 'ssh', disconnected: false },
  { id: 'c', title: 'Gamma', kind: 'local', disconnected: false },
];

describe('workspace terminal tabs', () => {
  beforeEach(() => {
    useWorkspace.setState({
      tabs: tabs.map((tab) => ({ ...tab })),
      activeTerminalId: 'a',
      secondaryTerminalId: undefined,
      split: false,
    });
  });

  it('moves tabs before or after the drop target', () => {
    useWorkspace.getState().moveTerminal('a', 'c', true);
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual(['b', 'c', 'a']);

    useWorkspace.getState().moveTerminal('a', 'b');
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'c']);
  });

  it('assigns stable monotonic tab numbers and preserves them during replacement', () => {
    useWorkspace.setState({ tabs: [], paneTerminalIds: [], focusedPane: 0 });
    useWorkspace.getState().addTerminal({ ...tabs[0]!, id: 'first' });
    useWorkspace.getState().addTerminal({ ...tabs[1]!, id: 'second' });
    expect(useWorkspace.getState().tabs.map((tab) => tab.tabNumber)).toEqual([1, 2]);

    useWorkspace.getState().closeTerminal('first');
    useWorkspace.getState().addTerminal({ ...tabs[2]!, id: 'third' });
    expect(useWorkspace.getState().tabs.map((tab) => tab.tabNumber)).toEqual([2, 3]);

    useWorkspace.getState().replaceTerminal('second', { ...tabs[1]!, id: 'replacement' });
    expect(useWorkspace.getState().tabs.map((tab) => [tab.id, tab.tabNumber])).toEqual([
      ['replacement', 2],
      ['third', 3],
    ]);
    expect(nextTabNumber(useWorkspace.getState().tabs)).toBe(4);
  });

  it('renames a tab without accepting an empty title', () => {
    useWorkspace.getState().renameTerminal('a', '  Production  ');
    expect(useWorkspace.getState().tabs[0]?.title).toBe('Production');

    useWorkspace.getState().renameTerminal('a', '   ');
    expect(useWorkspace.getState().tabs[0]?.title).toBe('Production');
  });
});
