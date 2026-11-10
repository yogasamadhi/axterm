import { expect, it, vi } from 'vitest';
import { WorkspaceStore, paneCount } from '../../packages/plugins/workspace/src/client/store.ts';
import { workspacePresentationSchema } from '@axterm/plugin-api/configuration';
const modes = ['c1', 'c2', 'r2', 'c3', 'r3', 'c2x2', 'c1r2', 'r1c2'] as const;
function fixture() {
  const store = new WorkspaceStore(),
    close = vi.fn(async () => {});
  for (const id of ['one', 'two', 'three', 'four'])
    store.registerTab({ id, kind: 'terminal', title: id }, close);
  store.selectTab('one');
  return { store, close };
}
it('keeps each owner across all eight layouts and normalizes assignment when panes shrink', async () => {
  const { store, close } = fixture();
  for (const mode of modes) {
    store.arrange.setLayout(mode);
    const count = paneCount(mode);
    store.arrange.moveToPane('four', count - 1);
    expect(store.getSnapshot().arrangement?.paneTabIds[count - 1]).toBe('four');
    expect(store.getSnapshot().activeTabId).toBe('four');
    expect(store.getSnapshot().arrangement?.focusedPane).toBe(count - 1);
    expect(workspacePresentationSchema.safeParse(store.getPresentation()).success).toBe(true);
    expect(store.getSnapshot().tabs).toHaveLength(4);
  }
  store.arrange.setLayout('c1');
  expect(store.getSnapshot().tabs.every((tab) => tab.paneIndex === 0)).toBe(true);
  expect(() => store.arrange.moveToPane('one', 4)).toThrow('PANE_UNAVAILABLE');
  expect(close).not.toHaveBeenCalled();
  await store.dispose();
});
it('restores pinning, explicit title, display order, pane selection and maximization only onto live registrations', async () => {
  const { store, close } = fixture();
  store.arrange.setLayout('c2x2');
  store.arrange.moveToPane('two', 1);
  store.arrange.moveToPane('three', 2);
  store.arrange.moveToPane('four', 3);
  store.arrange.pinTab('one');
  store.arrange.renameTab('two', 'Renamed');
  store.arrange.moveTab('four', 'three');
  store.arrange.resizePane('x', 55);
  store.arrange.maximizePane(2);
  const saved = workspacePresentationSchema.parse(store.getPresentation());
  const restored = new WorkspaceStore();
  restored.restorePresentation(saved);
  expect(restored.getSnapshot().tabs).toEqual([]);
  for (const id of ['four', 'three', 'two', 'one'])
    restored.registerTab({ id, kind: 'terminal', title: 'Backend ' + id }, close);
  expect(restored.getSnapshot().tabs.map((tab) => tab.id)).toEqual(['one', 'two', 'four', 'three']);
  expect(restored.getSnapshot().tabs.find((tab) => tab.id === 'two')?.title).toBe('Renamed');
  expect(restored.getSnapshot().arrangement).toEqual(saved.layout);
  expect(restored.getSnapshot().activeTabId).toBe('four');
  expect(Object.isFrozen(restored.getSnapshot().arrangement?.paneTabIds)).toBe(true);
  expect(close).not.toHaveBeenCalled();
  await restored.dispose();
  await store.dispose();
});
it('batch close is scoped to the selected pane, includes pins, and retains a failed owner for explicit retry', async () => {
  const { store, close } = fixture();
  store.arrange.pinTab('one');
  store.arrange.setLayout('c2');
  store.arrange.moveToPane('one', 1);
  store.arrange.focusPane(0);
  let fail = true;
  store.registerTab({ id: 'failed', kind: 'terminal', title: 'Failed' }, async () => {
    if (fail) throw Error('cleanup failed');
  });
  await expect(store.arrange.closeTabs('all', 'two')).rejects.toThrow('cleanup failed');
  expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual(['one', 'failed']);
  expect(close).toHaveBeenCalledTimes(3);
  fail = false;
  await store.arrange.closeTabs('all', 'failed');
  expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual(['one']);
  expect(workspacePresentationSchema.safeParse(store.getPresentation()).success).toBe(true);
  await store.arrange.closeTabs('all', 'one');
  expect(store.getSnapshot().tabs).toEqual([]);
  await store.dispose();
});
it('rejects saved pane references that cannot belong to the saved layout', () => {
  const { store } = fixture(),
    saved = store.getPresentation();
  expect(
    workspacePresentationSchema.safeParse({
      ...saved,
      layout: { mode: 'c2', paneTabIds: ['one', 'one'], focusedPane: 1 },
    }).success,
  ).toBe(false);
  expect(
    workspacePresentationSchema.safeParse({
      ...saved,
      layout: { mode: 'c1', paneTabIds: ['one'], focusedPane: 3 },
    }).success,
  ).toBe(false);
  expect(
    workspacePresentationSchema.safeParse({
      ...saved,
      layout: { mode: 'c1', paneTabIds: ['unknown'], focusedPane: 0 },
    }).success,
  ).toBe(false);
  void store.dispose();
});

it('bounds separator movement and prevents three-pane ratios from crossing', async () => {
  const { store } = fixture();
  store.arrange.setLayout('c3');
  store.arrange.resizePane('x', 999);
  expect(store.getSnapshot().arrangement?.ratios?.x).toBeCloseTo(56.67);
  store.arrange.resizePane('x2', -999);
  expect(store.getSnapshot().arrangement?.ratios?.x2).toBeCloseTo(66.67);
  expect(() => store.arrange.resizePane('x', NaN)).toThrow('PANE_RATIO_INVALID');
  expect(workspacePresentationSchema.safeParse(store.getPresentation()).success).toBe(true);
  await store.dispose();
});
it('swaps whole pane batches without reordering tabs, remounting owners or losing active focus and maximization', async () => {
  const { store, close } = fixture();
  store.arrange.setLayout('c2');
  store.arrange.moveToPane('two', 1);
  store.arrange.moveToPane('three', 1);
  store.arrange.pinTab('two');
  store.arrange.renameTab('three', 'Owned title');
  store.arrange.maximizePane(1);
  const before = store.getSnapshot();
  store.arrange.swapPanes(0, 1);
  const after = store.getSnapshot();
  expect(after.tabs.map((tab) => tab.id)).toEqual(before.tabs.map((tab) => tab.id));
  expect(after.tabs.map((tab) => [tab.id, tab.paneIndex])).toEqual(
    before.tabs.map((tab) => [tab.id, tab.paneIndex === 0 ? 1 : 0]),
  );
  expect(after.tabs.map((tab) => [tab.id, tab.tabNumber, tab.pinned, tab.title])).toEqual(
    before.tabs.map((tab) => [tab.id, tab.tabNumber, tab.pinned, tab.title]),
  );
  expect(after.activeTabId).toBe('three');
  expect(after.arrangement).toMatchObject({
    mode: 'c2',
    paneTabIds: ['three', 'one'],
    focusedPane: 0,
    maximizedPane: 0,
  });
  expect(before.arrangement?.paneTabIds).toEqual(['one', 'three']);
  expect(Object.isFrozen(after.arrangement?.paneTabIds)).toBe(true);
  expect(close).not.toHaveBeenCalled();
  store.arrange.swapPanes(1, 0);
  expect(store.getSnapshot()).toEqual(before);
  const revision = store.getPresentationRevision();
  store.arrange.swapPanes(1, 1);
  expect(store.getPresentationRevision()).toBe(revision);
  expect(() => store.arrange.swapPanes(1, 2)).toThrow('PANE_UNAVAILABLE');
  expect(store.getSnapshot()).toEqual(before);
  await store.dispose();
  expect(() => store.arrange.swapPanes(0, 1)).toThrow('WORKSPACE_CLOSED');
});
it('swaps an empty pane without creating a registration or replaying a close callback', async () => {
  const store = new WorkspaceStore(),
    close = vi.fn(async () => {});
  store.registerTab({ id: 'one', kind: 'terminal', title: 'One' }, close).activate();
  store.arrange.setLayout('c2');
  store.arrange.swapPanes(0, 1);
  expect(store.getSnapshot().arrangement).toMatchObject({
    paneTabIds: [null, 'one'],
    focusedPane: 1,
  });
  expect(store.getSnapshot().activeTabId).toBe('one');
  expect(store.getSnapshot().tabs).toHaveLength(1);
  expect(close).not.toHaveBeenCalled();
  await store.dispose();
});
