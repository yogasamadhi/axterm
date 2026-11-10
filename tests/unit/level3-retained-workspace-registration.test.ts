import { expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../../packages/plugins/workspace/src/client/store.ts';
function fixture() {
  const store = new WorkspaceStore(),
    close = vi.fn(async () => {});
  const registrations = new Map(
    ['a', 'b', 'c', 'd'].map((id) => [
      id,
      store.registerTab({ id, kind: 'terminal', title: id.toUpperCase() }, close),
    ]),
  );
  registrations.get('a')!.activate();
  return { store, close, registrations };
}
it('retains before/after order, monotonic live numbers and explicit titles across updates of the same view owner', async () => {
  const { store, close, registrations } = fixture();
  store.arrange.moveTab('a', 'c', true);
  expect(store.getPresentation().tabs.map((tab) => tab.id)).toEqual(['b', 'c', 'a', 'd']);
  store.arrange.moveTab('a', 'b');
  expect(store.getPresentation().tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'c', 'd']);
  registrations.get('a')!.dispose();
  const next = store.registerTab({ id: 'next', kind: 'terminal', title: 'Next' }, close);
  expect(store.getSnapshot().tabs.map((tab) => tab.tabNumber)).toEqual([2, 3, 4, 5]);
  store.arrange.renameTab('b', '  Production  ');
  registrations
    .get('b')!
    .update({ id: 'b', kind: 'terminal', title: 'Replacement backend caption' });
  expect(store.getSnapshot().tabs[0]).toMatchObject({ id: 'b', title: 'Production', tabNumber: 2 });
  expect(() => store.arrange.renameTab('b', '   ')).toThrow();
  expect(store.getSnapshot().tabs[0]?.title).toBe('Production');
  next.dispose();
  expect(close).not.toHaveBeenCalled();
  await store.dispose();
});
it('keeps selected tabs independent from the shared activity sidebar and background registrations', async () => {
  const { store, close } = fixture();
  for (const id of ['hosts', 'files', 'tunnels', 'commands', 'ai']) {
    store.registerNavigation({ id, label: id, icon: null });
    store.selectSection(id);
    expect(store.getSnapshot()).toMatchObject({ section: id, sidebarOpen: true, activeTabId: 'a' });
  }
  store.registerNavigation({ id: 'settings', label: 'Settings', icon: null, view: 'section' });
  store.selectSection('settings');
  store.registerTab({ id: 'background', kind: 'terminal', title: 'Background' }, close);
  expect(store.getSnapshot()).toMatchObject({ section: 'settings', activeTabId: 'a' });
  store.selectSection('ai');
  store.toggleSidebar();
  expect(store.getSnapshot().sidebarOpen).toBe(false);
  expect(store.getSnapshot().activeTabId).toBe('a');
  store.selectTab('b');
  expect(store.getSnapshot()).toMatchObject({ section: 'ai', activeTabId: 'b' });
  expect(close).not.toHaveBeenCalled();
  await store.dispose();
});
it('fills only the withdrawn selected pane and keeps a surviving view and focus coherent', async () => {
  const { store } = fixture();
  store.arrange.setLayout('c3');
  store.arrange.moveToPane('b', 1);
  store.arrange.moveToPane('c', 2);
  store.arrange.moveTab('d', 'b', true);
  store.selectTab('b');
  await store.closeTab('b');
  expect(store.getSnapshot().arrangement).toMatchObject({
    paneTabIds: ['a', 'd', 'c'],
    focusedPane: 1,
  });
  expect(store.getSnapshot().activeTabId).toBe('d');
  await store.closeTab('c');
  expect(store.getSnapshot().arrangement).toMatchObject({
    paneTabIds: ['a', 'd', null],
    focusedPane: 1,
  });
  expect(store.getSnapshot().activeTabId).toBe('d');
  await store.closeTab('d');
  expect(store.getSnapshot().arrangement).toMatchObject({
    paneTabIds: ['a', null, null],
    focusedPane: 0,
  });
  expect(store.getSnapshot().activeTabId).toBe('a');
  await store.closeTab('a');
  expect(store.getSnapshot().tabs).toEqual([]);
  expect(store.getSnapshot().activeTabId).toBeUndefined();
  await store.dispose();
});
it('keeps canonical pin order through presentation restore and leaves unrelated empty panes empty on close', async () => {
  const { store, close } = fixture();
  store.arrange.setLayout('c2x2');
  store.arrange.pinTab('b');
  store.arrange.pinTab('d');
  expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual(['b', 'd', 'a', 'c']);
  expect(store.getPresentation().tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'c', 'd']);
  const saved = store.getPresentation(),
    restored = new WorkspaceStore();
  restored.restorePresentation(saved);
  for (const id of ['a', 'b', 'c', 'd'])
    restored.registerTab({ id, kind: 'terminal', title: id }, close);
  restored.arrange.pinTab('b');
  restored.arrange.pinTab('d');
  expect(restored.getSnapshot().tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'c', 'd']);
  await restored.closeTab('b');
  expect(restored.getSnapshot().arrangement?.paneTabIds).toEqual(['a', null, null, null]);
  await restored.dispose();
  await store.dispose();
});

it('applies a late restored navigation only at the captured revision and never overrides a later user selection', async () => {
  for (const userSelected of [false, true]) {
    const store = new WorkspaceStore();
    store.registerNavigation({ id: 'hosts', label: 'Hosts', icon: null });
    store.registerNavigation({ id: 'settings', label: 'Settings', icon: null, view: 'section' });
    store.restorePresentation({ section: 'ai', sidebarOpen: true, tabs: [], activeTabId: null });
    if (userSelected) store.selectSection('settings');
    store.registerNavigation({ id: 'ai', label: 'Assistant', icon: null });
    expect(store.getSnapshot().section).toBe(userSelected ? 'settings' : 'ai');
    expect(store.getSnapshot().tabs).toEqual([]);
    await store.dispose();
  }
});

it('moves an already visible view once, swaps its pane batches and expands a collapsed layout with empty panes', async () => {
  const { store, close } = fixture();
  store.arrange.setLayout('c2x2');
  store.arrange.moveToPane('b', 1);
  store.arrange.moveToPane('c', 2);
  store.arrange.moveToPane('d', 3);
  expect(store.getSnapshot().arrangement?.paneTabIds).toEqual(['a', 'b', 'c', 'd']);
  store.arrange.moveToPane('c', 0);
  expect(store.getSnapshot().arrangement?.paneTabIds).toEqual(['c', 'b', null, 'd']);
  store.arrange.swapPanes(1, 3);
  expect(store.getSnapshot().arrangement?.paneTabIds).toEqual(['c', 'd', null, 'b']);
  store.arrange.setLayout('c1');
  expect(store.getSnapshot().tabs.every((tab) => tab.paneIndex === 0)).toBe(true);
  expect(store.getSnapshot().arrangement?.paneTabIds).toEqual(['c']);
  store.arrange.setLayout('c2');
  expect(store.getSnapshot().arrangement?.paneTabIds).toEqual(['c', null]);
  expect(store.getSnapshot().tabs).toHaveLength(4);
  expect(close).not.toHaveBeenCalled();
  await store.dispose();
});
it('keeps owned layout, title, pin and focus across Host generation retirement without creating or closing work', async () => {
  const { store, close } = fixture();
  store.bindPresentationGeneration('generation-a');
  store.arrange.setLayout('c2');
  store.arrange.moveToPane('b', 1);
  store.arrange.renameTab('b', 'Retained title');
  store.arrange.pinTab('b');
  store.arrange.resizePane('x', 60);
  const before = store.getSnapshot();
  expect(store.bindPresentationGeneration('generation-b')).toBe(true);
  expect(store.getSnapshot()).toEqual(before);
  expect(close).not.toHaveBeenCalled();
  await store.dispose();
});
