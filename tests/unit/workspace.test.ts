import { beforeEach, describe, expect, it } from 'vitest';
import {
  nextTabNumber,
  shouldActivateStartupSurface,
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
      persistedLayoutWritePolicy: 'active',
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

  it('registers a background startup terminal without replacing an open section', () => {
    useWorkspace.setState({
      section: 'settings',
      contentSurface: 'section',
      tabs: [],
      activeTerminalId: undefined,
      paneTerminalIds: [],
      focusedPane: 0,
    });
    useWorkspace.getState().addTerminal(tabs[0]!, { activateSurface: false });

    expect(useWorkspace.getState()).toMatchObject({
      section: 'settings',
      contentSurface: 'section',
      activeTerminalId: 'a',
    });
    expect(useWorkspace.getState().tabs.map(({ id }) => id)).toEqual(['a']);

    useWorkspace.getState().addTerminal(tabs[1]!);
    expect(useWorkspace.getState()).toMatchObject({
      contentSurface: 'terminal',
      activeTerminalId: 'b',
    });
  });

  it('only activates a delayed startup bookmark while the user is still on the host surface', () => {
    useWorkspace.setState({ section: 'hosts', contentSurface: 'section' });
    expect(shouldActivateStartupSurface(true)).toBe(true);

    useWorkspace.setState({ section: 'settings', contentSurface: 'section' });
    expect(shouldActivateStartupSurface(true)).toBe(false);
    expect(shouldActivateStartupSurface(false)).toBe(true);

    useWorkspace.setState({ contentSurface: 'terminal' });
    expect(shouldActivateStartupSurface(true)).toBe(true);
  });

  it('renames a tab without accepting an empty title', () => {
    useWorkspace.getState().renameTerminal('a', '  Production  ');
    expect(useWorkspace.getState().tabs[0]?.title).toBe('Production');

    useWorkspace.getState().renameTerminal('a', '   ');
    expect(useWorkspace.getState().tabs[0]?.title).toBe('Production');
  });

  it('protects imported workspace settings from current-session layout write-back', () => {
    useWorkspace.getState().beginConfigurationSettingsImport();
    expect(useWorkspace.getState().persistedLayoutWritePolicy).toBe('configuration-importing');

    useWorkspace.getState().cancelConfigurationSettingsImport();
    expect(useWorkspace.getState().persistedLayoutWritePolicy).toBe('active');

    useWorkspace.getState().beginConfigurationSettingsImport();
    useWorkspace.getState().completeConfigurationSettingsImport();
    expect(useWorkspace.getState().persistedLayoutWritePolicy).toBe('restart-required');

    useWorkspace.getState().cancelConfigurationSettingsImport();
    expect(useWorkspace.getState().persistedLayoutWritePolicy).toBe('restart-required');
  });

  it('protects an uncertain settings import until restart', () => {
    useWorkspace.getState().beginConfigurationSettingsImport();
    useWorkspace.getState().protectConfigurationSettingsImport();
    expect(useWorkspace.getState().persistedLayoutWritePolicy).toBe('restart-required');
  });
});
