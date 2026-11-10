import { expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../../packages/plugins/workspace/src/client/store.ts';
it('keeps tab/navigation registration ownership and immutable UI facts without closing native work on removal', async () => {
  const store = new WorkspaceStore();
  expect(store.getSnapshot().sidebarOpen).toBe(false);
  const close = vi.fn(async () => {});
  const nav = store.registerNavigation({ id: 'hosts', label: 'Connections', icon: null });
  const tab = store.registerTab({ id: 'one', kind: 'terminal', title: 'Local terminal' }, close);
  tab.activate();
  expect(store.getSnapshot().activeTabId).toBe('one');
  expect(Object.isFrozen(store.getSnapshot().tabs)).toBe(true);
  expect(() =>
    store.registerTab({ id: 'one', kind: 'other', title: 'Wrong owner' }, close),
  ).toThrow('CONFLICT');
  expect(() => tab.update({ id: 'other', kind: 'terminal', title: 'Wrong id' })).toThrow(
    'OWNER_CHANGED',
  );
  tab.update({ id: 'one', kind: 'terminal', title: 'Renamed' });
  expect(store.getSnapshot().tabs[0]?.title).toBe('Renamed');
  tab.dispose();
  nav();
  expect(close).not.toHaveBeenCalled();
  expect(store.getSnapshot().tabs).toEqual([]);
  await store.dispose();
});
it('joins an explicit close once, retains a failed close for retry and drains only invoked actions on UI unload', async () => {
  const store = new WorkspaceStore();
  const release = Promise.withResolvers<void>();
  const close = vi.fn(() => release.promise);
  store.registerTab({ id: 'one', kind: 'terminal', title: 'One' }, close).activate();
  const first = store.closeTab('one');
  const second = store.closeTab('one');
  expect(first).toBe(second);
  await Promise.resolve();
  expect(close).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot().tabs).toHaveLength(1);
  release.resolve();
  await first;
  expect(store.getSnapshot().tabs).toEqual([]);
  let reject = true;
  store.registerTab({ id: 'two', kind: 'terminal', title: 'Two' }, async () => {
    if (reject) throw new Error('native close failed');
  });
  await expect(store.closeTab('two')).rejects.toThrow();
  expect(store.getSnapshot().tabs).toHaveLength(1);
  reject = false;
  await store.closeTab('two');
  const actionDone = Promise.withResolvers<void>();
  const action = vi.fn(() => actionDone.promise);
  const off = store.registerAction('new-terminal', action);
  expect(action).not.toHaveBeenCalled();
  const invoked = store.invokeAction('new-terminal');
  await Promise.resolve();
  off();
  const disposed = store.dispose();
  actionDone.resolve();
  await invoked;
  await disposed;
  expect(action).toHaveBeenCalledTimes(1);
  expect(() => store.invokeAction('new-terminal')).toThrow('WORKSPACE_CLOSED');
});
it('returns from a domain section to session content when selecting or activating a tab', async () => {
  const store = new WorkspaceStore();
  store.registerNavigation({ id: 'sessions', label: 'Sessions', icon: null });
  const remove = store.registerNavigation({
    id: 'tunnels',
    label: 'Tunnels',
    icon: null,
    view: 'section',
  });
  const tab = store.registerTab({ id: 'one', kind: 'terminal', title: 'One' }, async () => {});
  store.selectSection('tunnels');
  store.selectTab('one');
  expect(store.getSnapshot().section).toBe('sessions');
  store.selectSection('tunnels');
  tab.activate();
  expect(store.getSnapshot().section).toBe('sessions');
  remove();
  await store.dispose();
});

it('keeps a full-page section while its side panel opens and closes, and revokes unloaded panels', async () => {
  const store = new WorkspaceStore();
  store.registerNavigation({ id: 'hosts', label: 'Connections', icon: null });
  store.registerNavigation({ id: 'setting', label: 'Settings', icon: null, view: 'section' });
  const removeAi = store.registerNavigation({ id: 'ai', label: 'AI', icon: null });
  store.selectSection('setting');
  store.selectSection('ai', { sidebar: true });
  expect(store.getSnapshot()).toMatchObject({
    section: 'setting',
    sidebarSection: 'ai',
    sidebarOpen: true,
  });
  store.toggleSidebar();
  expect(store.getSnapshot()).toMatchObject({ section: 'setting', sidebarOpen: false });
  store.selectSection('ai', { sidebar: true });
  removeAi();
  expect(store.getSnapshot()).toMatchObject({ section: 'setting', sidebarOpen: false });
  expect(store.getSnapshot().sidebarSection).toBeUndefined();
  expect(() => store.selectSection('setting', { sidebar: true })).toThrow(
    'WORKSPACE_SIDEBAR_SECTION_INVALID',
  );
  store.selectSection('hosts');
  expect(store.getSnapshot()).toMatchObject({ section: 'hosts', sidebarOpen: true });
  expect(store.getSnapshot().sidebarSection).toBeUndefined();
  await store.dispose();
});

it('returns from Settings to the prior workspace without opening a sidebar or restoring an unloaded owner', async () => {
  const store = new WorkspaceStore();
  store.registerNavigation({ id: 'hosts', label: 'Hosts', icon: null });
  store.registerNavigation({ id: 'setting', label: 'Settings', icon: null, view: 'section' });
  const removeAi = store.registerNavigation({ id: 'ai', label: 'AI', icon: null });
  store.selectSection('ai');
  store.toggleSidebar();
  store.selectSection('setting');
  store.closeSection();
  expect(store.getSnapshot()).toMatchObject({ section: 'ai', sidebarOpen: false });
  store.selectSection('hosts');
  store.selectSection('setting');
  store.closeSection();
  expect(store.getSnapshot()).toMatchObject({ section: 'hosts', sidebarOpen: true });
  store.selectSection('ai');
  store.selectSection('setting');
  removeAi();
  store.closeSection();
  expect(store.getSnapshot()).toMatchObject({ section: 'hosts', sidebarOpen: false });
  store.selectSection('setting');
  store.selectSection('hosts');
  store.closeSection();
  expect(store.getSnapshot()).toMatchObject({ section: 'hosts', sidebarOpen: true });
  await store.dispose();
});
