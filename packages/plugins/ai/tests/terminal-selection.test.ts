import { expect, it } from 'vitest';
import type { WorkspaceUi, WorkspaceSnapshot } from '@axterm/ui/workspace';
import { AiTerminalSelection } from '../src/client/ui/terminal-selection.ts';

it('shares explicit terminal choice, follows active tabs on demand and retires closed targets and listeners', () => {
  let state = {
    activeTabId: 'one',
    tabs: [
      { id: 'one', kind: 'terminal', title: 'Local' },
      { id: 'two', kind: 'terminal', title: 'SSH' },
      { id: 'ai', kind: 'ai', title: 'Assistant' },
    ],
  } as unknown as WorkspaceSnapshot;
  const listeners = new Set<() => void>();
  const workspace = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies Pick<WorkspaceUi, 'getSnapshot' | 'subscribe'>;
  const owner = new AiTerminalSelection(workspace);
  const values: (string | undefined)[] = [];
  const off = owner.subscribe(() => values.push(owner.getSnapshot().terminalId));
  const update = (patch: Partial<WorkspaceSnapshot>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  expect(owner.getSnapshot()).toEqual({ choice: '', terminalId: 'one' });
  owner.select('two');
  expect(owner.getSnapshot()).toEqual({ choice: 'two', terminalId: 'two' });
  update({ activeTabId: 'ai' });
  expect(owner.getSnapshot().terminalId).toBe('two');
  owner.select('ai');
  expect(owner.getSnapshot().terminalId).toBe('two');
  owner.select('');
  expect(owner.getSnapshot().terminalId).toBe('one');
  update({ activeTabId: 'two' });
  expect(owner.getSnapshot().terminalId).toBe('two');
  owner.select('one');
  update({ tabs: state.tabs.filter((tab) => tab.id !== 'one') });
  expect(owner.getSnapshot()).toEqual({ choice: '', terminalId: 'two' });
  update({ tabs: state.tabs.filter((tab) => tab.id !== 'two'), activeTabId: 'ai' });
  expect(owner.getSnapshot().terminalId).toBeUndefined();
  expect(values).toContain('two');
  off();
  owner.dispose();
  expect(listeners.size).toBe(0);
});
