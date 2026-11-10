import { createTerminalSchema } from '@axterm/plugin-api/terminals';
import { expect, it, vi, afterEach } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import {
  connectionHistoryPageSchema,
  createHostSchema,
  hostSchema,
  bookmarkSchema,
  createBookmarkSchema,
  createSshBookmarkSchema,
  type CatalogBaseline,
  type CatalogReceipt,
} from '@axterm/plugin-api/catalog';
import type {
  CatalogModel,
  CatalogState,
} from '../../packages/plugins/catalog/src/client/index.ts';
import type {
  ConnectionWorkspaceUi,
  TerminalWorkspaceUi,
  FilesWorkspaceUi,
} from '@axterm/ui/workspace';
import { CatalogTreeActions } from '../../packages/plugins/catalog/src/client/ui/tree/tree-actions.ts';
import { BookmarkTreeUiStore } from '../../packages/plugins/catalog/src/client/ui/tree/tree-ui.tsx';
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  let generation = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const host = hostSchema.parse({
    ...createHostSchema.parse({
      name: 'SSH source',
      hostname: 'example.test',
      username: 'operator',
      credentialRef: 'cred_shared',
      startup: {
        directory: '/srv',
        environment: { SAFE: 'yes' },
        loginScripts: [],
        runScripts: [],
      },
    }),
    id: crypto.randomUUID(),
    version: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const bookmark = bookmarkSchema.parse({
    ...createBookmarkSchema.parse({
      protocol: 'ssh',
      hostId: host.id,
      title: host.name,
      quickCommands: [{ name: 'List', command: 'ls' }],
    }),
    id: crypto.randomUUID(),
    position: 0,
    version: 3,
    connectionDisplay: 'operator@example.test:22',
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const facts = {
    generation,
    cursor: 1,
    hosts: [host],
    bookmarks: { revision: 1, etag: '"bookmark-tree-v1"', groups: [], bookmarks: [bookmark] },
    connectionProfiles: [],
    hostGroups: [],
    history: connectionHistoryPageSchema.parse({
      revision: 1,
      etag: '"connection-history-v1"',
      sort: 'recent',
      limit: 25,
      total: 0,
      items: [],
      nextCursor: null,
    }),
  } as CatalogBaseline;
  const command = () =>
    vi.fn(async (..._args: unknown[]): Promise<CatalogReceipt> => ({
      ids: [crypto.randomUUID()],
      cursor: 2,
    }));
  const methods = {
    getSnapshot: () => ({ status: 'ready', baseline: { ...facts, generation } }) as CatalogState,
    createBookmarkGroup: command(),
    updateBookmarkGroup: command(),
    deleteBookmarkGroup: command(),
    moveBookmarkTreeNode: command(),
    deleteSshBookmark: command(),
    deleteSshBookmarkHost: command(),
    deleteBookmark: command(),
    createSshBookmark: command(),
    createBookmark: command(),
  };
  const connect = vi.fn(async (..._args: unknown[]) => 'connection'),
    terminal = vi.fn(async (..._args: unknown[]) => 'terminal');
  const actions = new CatalogTreeActions(
    methods as unknown as CatalogModel,
    { openSsh: connect } as unknown as ConnectionWorkspaceUi,
    { open: terminal } as unknown as TerminalWorkspaceUi,
  );
  return {
    actions,
    methods,
    host,
    bookmark,
    connect,
    terminal,
    changeGeneration: () => {
      generation = crypto.randomUUID();
    },
  };
}
it('captures group request and tree precondition once, retaining the same identity after a lost ACK', async () => {
  const f = fixture();
  f.methods.createBookmarkGroup.mockRejectedValueOnce(new Error('Lost ACK'));
  const input = { name: 'Group', color: null, description: 'Captured' };
  const task = f.actions.createGroup(null, input);
  input.description = 'Changed after click';
  await task;
  expect(f.actions.getSnapshot()).toMatchObject({ uncertain: true });
  await f.actions.retry();
  expect(f.methods.createBookmarkGroup.mock.calls[1]).toEqual(
    f.methods.createBookmarkGroup.mock.calls[0],
  );
  expect(f.methods.createBookmarkGroup.mock.calls[0]![1]).toEqual({
    name: 'Group',
    parentId: null,
    color: null,
    description: 'Captured',
  });
  await f.actions.close();
});
it('copies complete SSH metadata atomically and strips entity-only fields from strict create contracts', async () => {
  const f = fixture();
  expect(await f.actions.duplicate(f.bookmark, 'Copy')).toBe(true);
  const input = createSshBookmarkSchema.parse(f.methods.createSshBookmark.mock.calls[0]![1]);
  expect(input.host).toMatchObject({
    credentialRef: 'cred_shared',
    hostname: 'example.test',
    startup: f.host.startup,
  });
  expect(input.bookmark.quickCommands).toEqual(f.bookmark.quickCommands);
  expect(input.host).not.toHaveProperty('groupId');
  const timestamp = new Date().toISOString();
  const web = bookmarkSchema.parse({
    ...createBookmarkSchema.parse({
      protocol: 'web',
      hostId: null,
      title: 'Site',
      web: { url: 'https://example.test' },
    }),
    id: crypto.randomUUID(),
    version: 1,
    position: 1,
    connectionDisplay: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  expect(await f.actions.duplicate(web, 'Copy')).toBe(true);
  expect(createBookmarkSchema.parse(f.methods.createBookmark.mock.calls[0]![1]).web?.url).toBe(
    'https://example.test',
  );
  await f.actions.close();
});
it('captures SSH deletion ownership before caller mutation and uses Host/tree versions for atomic removal', async () => {
  const f = fixture();
  const pending = f.actions.remove(f.bookmark);
  f.bookmark.protocol = 'local';
  await pending;
  expect(f.methods.deleteSshBookmark).toHaveBeenCalledWith(
    expect.any(String),
    f.bookmark.id,
    '"v2"',
    '"bookmark-tree-v1"',
  );
  expect(f.methods.deleteBookmark).not.toHaveBeenCalled();
  await f.actions.close();
});
it('does not replay a failed network admission and joins its actual cancellation on unload', async () => {
  const f = fixture();
  const late = Promise.withResolvers<string>();
  f.connect.mockImplementationOnce(() => late.promise);
  const started = f.actions.connect(f.bookmark);
  await Promise.resolve();
  let closed = false;
  const stop = f.actions.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  const options = f.connect.mock.calls[0]![1] as { signal: AbortSignal };
  expect(options.signal.aborted).toBe(true);
  late.reject(new Error('Admission cancelled'));
  await Promise.all([started, stop]);
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(await f.actions.retry()).toBe(false);
});
it('retires uncertain fact retries after a generation change and allows a definite failure to be corrected', async () => {
  const f = fixture();
  f.methods.createBookmarkGroup.mockRejectedValueOnce(
    new RemoteError('catalog/failure', 'Invalid', { reason: 'invalid-input' }),
  );
  expect(await f.actions.createGroup(null, { name: '', color: null, description: '' })).toBe(false);
  expect(f.actions.getSnapshot().uncertain).toBe(false);
  f.methods.createBookmarkGroup.mockRejectedValueOnce(new Error('Lost ACK'));
  await f.actions.createGroup(null, { name: 'Retry', color: null, description: '' });
  f.changeGeneration();
  expect(await f.actions.retry()).toBe(false);
  expect(f.methods.createBookmarkGroup).toHaveBeenCalledTimes(2);
  await f.actions.close();
});
it('persists expansion preferences only, bounds restored values and releases subscriptions', () => {
  const writes = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: () => JSON.stringify({ state: { expandedGroupIds: ['one', 42, 'x'.repeat(129)] } }),
    setItem: (key: string, value: string) => writes.set(key, value),
  });
  const store = new BookmarkTreeUiStore();
  expect(store.getSnapshot().expandedGroupIds).toEqual(['one']);
  const notify = vi.fn();
  store.subscribe(notify);
  store.getSnapshot().setQuery('Transient query');
  store.getSnapshot().setSelectedSearchRowKey('bookmark:transient');
  store.getSnapshot().toggleGroup('two');
  expect(JSON.parse(writes.get('axterm-bookmark-tree-ui')!)).toEqual({
    state: { expandedGroupIds: ['one', 'two'] },
    version: 0,
  });
  expect(writes.values().next().value).not.toContain('Transient');
  store.close();
  const count = notify.mock.calls.length;
  store.getSnapshot().toggleGroup('three');
  expect(notify).toHaveBeenCalledTimes(count);
});

it('launches local, Telnet, serial and SSH through strict selected owner inputs without presentation-only fields', async () => {
  const f = fixture();
  f.terminal.mockImplementation(async (input) => {
    createTerminalSchema.parse(input);
    return 'terminal';
  });
  for (const protocol of ['local', 'telnet', 'serial'] as const)
    expect(await f.actions.connect({ ...f.bookmark, protocol, hostId: null })).toBe(true);
  f.connect.mockImplementation(async (_input, options) => {
    const { title, ...input } = (options as { terminal: { title?: string } }).terminal;
    expect(title).toBe(f.bookmark.title);
    createTerminalSchema.parse({
      kind: 'ssh',
      connectionId: crypto.randomUUID(),
      cols: 160,
      rows: 80,
      ...input,
    });
    return 'connection';
  });
  expect(await f.actions.connect(f.bookmark)).toBe(true);
  expect(f.terminal).toHaveBeenCalledTimes(3);
  await f.actions.close();
});

it('deletes a managed Host through the atomic destination command with captured preconditions', async () => {
  const f = fixture();
  await f.actions.removeHost(f.host);
  expect(f.methods.deleteSshBookmarkHost).toHaveBeenCalledWith(
    expect.any(String),
    f.host.id,
    '"v2"',
    '"bookmark-tree-v1"',
  );
  expect(f.methods.deleteBookmark).not.toHaveBeenCalled();
  await f.actions.close();
});
it('opens a terminal on a ready managed SSH connection without admitting another connection', async () => {
  const f = fixture(),
    id = crypto.randomUUID();
  await f.actions.connect(f.bookmark, undefined, id);
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.terminal).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'ssh', connectionId: id, bookmarkId: f.bookmark.id }),
    expect.any(AbortSignal),
    { title: f.bookmark.title },
  );
  await f.actions.close();
});
it('rejects a managed fact intent retired before its admission executes', async () => {
  const f = fixture();
  const pending = f.actions.removeHost(f.host);
  f.changeGeneration();
  expect(await pending).toBe(false);
  expect(f.methods.deleteSshBookmarkHost).not.toHaveBeenCalled();
  expect(f.actions.getSnapshot().uncertain).toBe(false);
  await f.actions.close();
});

it('dispatches FTP bookmarks to the selected Files owner and withdraws only that optional launcher', async () => {
  const f = fixture(),
    openFtp = vi.fn(async () => 'files:ftp'),
    off = f.actions.attachFiles({ openFtp } as unknown as FilesWorkspaceUi);
  const ftp = { ...f.bookmark, protocol: 'ftp' as const, hostId: null, title: 'FTP files' };
  expect(await f.actions.connect(ftp)).toBe(true);
  expect(openFtp).toHaveBeenCalledExactlyOnceWith(
    { bookmarkId: ftp.id },
    { title: 'FTP files', signal: expect.any(AbortSignal) },
  );
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.terminal).not.toHaveBeenCalled();
  off();
  expect(await f.actions.connect(ftp)).toBe(false);
  expect(openFtp).toHaveBeenCalledOnce();
  await f.actions.close();
});
