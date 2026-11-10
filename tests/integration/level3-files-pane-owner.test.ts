import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { FileDirectoryBaseline } from '@axterm/plugin-api/files';
import type { FileGrantsState } from '../../packages/plugins/files/src/client/index.ts';
import { FilePaneOwner } from '../../packages/plugins/files/src/client/ui/pane-owner.ts';
function fixture() {
  let generation: string = randomUUID();
  const listeners = new Set<() => void>();
  const created: {
    path: string;
    listeners: Set<() => void>;
    dispose: ReturnType<typeof vi.fn>;
    set: (path?: string, generationOverride?: string) => FileDirectoryBaseline;
  }[] = [];
  const files = {
    getSnapshot: (): FileGrantsState => ({
      status: 'ready',
      baseline: { generation, cursor: 0, grants: [] },
    }),
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    openDirectory: vi.fn((grantId: string, path: string) => {
      let state: { status: 'connecting' } | { status: 'ready'; baseline: FileDirectoryBaseline } = {
        status: 'connecting',
      };
      const updates = new Set<() => void>(),
        dispose = vi.fn(async () => {});
      const set = (nextPath = path, generationOverride = generation) => {
        const baseline = Object.freeze({
          generation: generationOverride,
          cursor: 0,
          grantId,
          path: nextPath,
          rootName: 'Fixture',
          entries: [],
          truncated: false,
        });
        state = { status: 'ready', baseline };
        for (const fn of updates) fn();
        return baseline;
      };
      created.push({ path, listeners: updates, dispose, set });
      return {
        getSnapshot: () => state,
        subscribe: (fn: () => void) => {
          updates.add(fn);
          return () => updates.delete(fn);
        },
        dispose,
      };
    }),
    openRemoteDirectory: vi.fn(() => {
      throw Error('UNUSED_REMOTE_FACTORY');
    }),
  };
  const owner = new FilePaneOwner(files);
  return {
    files,
    owner,
    created,
    replaceGeneration: () => {
      generation = randomUUID();
      for (const fn of listeners) fn();
    },
    listeners,
  };
}
it('publishes accepted model facts by reference and retires old observation before changing addresses', async () => {
  const f = fixture();
  try {
    await f.owner.navigate({ kind: 'local', grantId: 'fixture', path: 'first' });
    const initial = f.created[0]!;
    const baseline = initial.set();
    const state = f.owner.getSnapshot();
    expect(state.status === 'ready' && state.baseline).toBe(baseline);
    await f.owner.navigate({ kind: 'local', grantId: 'fixture', path: 'second' });
    expect(initial.dispose).toHaveBeenCalledOnce();
    expect(initial.listeners.size).toBe(0);
    initial.set();
    expect(f.owner.getSnapshot()).toMatchObject({
      status: 'connecting',
      source: { path: 'second' },
    });
    f.created[1]!.set();
    expect(f.owner.getSnapshot()).toMatchObject({ status: 'ready', source: { path: 'second' } });
  } finally {
    await f.owner.dispose();
  }
  expect(f.owner.resourceCount()).toBe(0);
  expect(f.listeners.size).toBe(0);
});
it('coalesces superseded navigation while joining the actual old observer disposal', async () => {
  const f = fixture();
  try {
    await f.owner.navigate({ kind: 'local', grantId: 'fixture', path: 'first' });
    const release = Promise.withResolvers<void>();
    f.created[0]!.dispose.mockImplementation(() => release.promise);
    const older = f.owner.navigate({ kind: 'local', grantId: 'fixture', path: 'obsolete' });
    await vi.waitFor(() => expect(f.created[0]!.dispose).toHaveBeenCalledOnce());
    const newer = f.owner.navigate({ kind: 'local', grantId: 'fixture', path: 'latest' });
    release.resolve();
    await Promise.all([older, newer]);
    expect(f.files.openDirectory.mock.calls.map((c) => c[1])).toEqual(['first', 'latest']);
  } finally {
    await f.owner.dispose();
  }
});
it('clears old generation facts and joins observers before permitting a fresh generation view', async () => {
  const f = fixture();
  try {
    await f.owner.navigate({ kind: 'local', grantId: 'fixture', path: '' });
    f.created[0]!.set();
    f.replaceGeneration();
    expect(f.owner.getSnapshot().status).toBe('empty');
    await vi.waitFor(() => expect(f.created[0]!.dispose).toHaveBeenCalledOnce());
    await f.owner.navigate({ kind: 'local', grantId: 'fresh', path: '' });
    f.created[1]!.set();
    expect(f.owner.getSnapshot()).toMatchObject({ status: 'ready', source: { grantId: 'fresh' } });
  } finally {
    await f.owner.dispose();
  }
});
it('rejects mismatched baseline addresses and retains ownership after failed observation cleanup', async () => {
  const f = fixture();
  await f.owner.navigate({ kind: 'local', grantId: 'fixture', path: '' });
  f.created[0]!.set('other');
  expect(f.owner.getSnapshot().status).toBe('error');
  f.created[0]!.dispose.mockRejectedValue(Error('CONTROLLED_DISPOSE_FAILURE'));
  await expect(f.owner.dispose()).rejects.toThrow('UNDRAINED');
  expect(f.owner.resourceCount()).toBe(1);
  expect(f.listeners.size).toBe(0);
  await expect(f.owner.navigate({ kind: 'local', grantId: 'fixture', path: '' })).rejects.toThrow(
    'CLOSED',
  );
});
it('prevents late navigation from reopening a view after close', async () => {
  const f = fixture();
  await f.owner.navigate({ kind: 'local', grantId: 'fixture', path: '' });
  const release = Promise.withResolvers<void>();
  f.created[0]!.dispose.mockImplementation(() => release.promise);
  const navigating = f.owner.navigate({ kind: 'local', grantId: 'fixture', path: 'late' });
  await vi.waitFor(() => expect(f.created[0]!.dispose).toHaveBeenCalledOnce());
  let disposed = false;
  const closing = f.owner.dispose().then(() => {
    disposed = true;
  });
  expect(disposed).toBe(false);
  release.resolve();
  await navigating;
  await closing;
  expect(f.files.openDirectory).toHaveBeenCalledOnce();
  expect(f.owner.resourceCount()).toBe(0);
});

it('still drains the model when subscription withdrawal fails', async () => {
  const f = fixture(),
    dispose = vi.fn(async () => {});
  f.files.openDirectory.mockImplementationOnce(() => ({
    getSnapshot: () => ({ status: 'connecting' }),
    subscribe: () => () => {
      throw Error('CONTROLLED_UNSUBSCRIBE_FAILURE');
    },
    dispose,
  }));
  await f.owner.navigate({ kind: 'local', grantId: 'fixture', path: '' });
  await expect(f.owner.dispose()).rejects.toThrow('UNDRAINED');
  expect(dispose).toHaveBeenCalledOnce();
  expect(f.owner.resourceCount()).toBe(1);
});

it('coalesces repeated clear requests while actual directory disposal is pending', async () => {
  const f = fixture();
  await f.owner.navigate({ kind: 'local', grantId: 'fixture', path: '' });
  const release = Promise.withResolvers<void>();
  f.created[0]!.dispose.mockImplementation(() => release.promise);
  const first = f.owner.clear();
  await vi.waitFor(() => expect(f.created[0]!.dispose).toHaveBeenCalledOnce());
  for (let i = 0; i < 100; i++) expect(f.owner.clear()).toBe(first);
  expect(f.owner.resourceCount()).toBe(2);
  release.resolve();
  await first;
  await f.owner.dispose();
  expect(f.owner.resourceCount()).toBe(0);
});
