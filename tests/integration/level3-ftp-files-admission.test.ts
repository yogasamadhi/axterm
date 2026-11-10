import { expect, it, vi } from 'vitest';
import type { ConnectionClientActions, FtpConnection } from '@axterm/plugin-api/connections';
import { FtpFilesAdmissions } from '../../packages/plugins/files/src/client/ui/ftp-admission.ts';
function fixture() {
  let generation = crypto.randomUUID(),
    items: FtpConnection[] = [];
  const listeners = new Set<() => void>(),
    now = new Date().toISOString(),
    connection: FtpConnection = {
      id: crypto.randomUUID(),
      bookmarkId: crypto.randomUUID(),
      name: 'FTP fixture',
      hostname: '127.0.0.1',
      port: 21,
      username: 'user',
      security: 'plain',
      encoding: 'utf-8',
      initialDirectory: '/uploads',
      state: 'ready',
      createdAt: now,
      updatedAt: now,
    };
  const actions = {
    getSnapshot: () => ({ status: 'ready', baseline: { generation, ftpConnections: items } }),
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    createFtpConnection: vi.fn(async () => {
      items = [connection];
      for (const fn of listeners) fn();
      return connection;
    }),
    closeFtpConnection: vi.fn(async () => {}),
    getFtpCommandOutcome: vi.fn(async () => ({ status: 'missing' })),
  } as unknown as ConnectionClientActions;
  const view = vi.fn(async () => 'files:owned'),
    owner = new FtpFilesAdmissions(actions, view, () => true);
  return {
    actions,
    connection,
    view,
    owner,
    listeners,
    replace() {
      generation = crypto.randomUUID();
      for (const fn of listeners) fn();
    },
    ready() {
      items = [connection];
      for (const fn of listeners) fn();
    },
  };
}
it('waits for accepted FTP facts and hands a visible titled directory view to its owner without disconnecting successful sessions', async () => {
  const f = fixture();
  expect(
    await f.owner.open({ bookmarkId: f.connection.bookmarkId }, { title: 'Release files' }),
  ).toBe('files:owned');
  expect(f.view).toHaveBeenCalledExactlyOnceWith(
    {
      kind: 'remote',
      target: { protocol: 'ftp', connectionId: f.connection.id },
      path: '/uploads',
      title: 'Release files',
    },
    expect.any(AbortSignal),
  );
  await f.owner.dispose();
  expect(f.actions.closeFtpConnection).not.toHaveBeenCalled();
  expect(f.listeners.size).toBe(0);
});
it('joins a canceled late admission and actual FTP close before reporting rollback complete', async () => {
  const f = fixture(),
    created = Promise.withResolvers<FtpConnection>(),
    drained = Promise.withResolvers<void>();
  vi.mocked(f.actions.createFtpConnection).mockImplementation(() => created.promise);
  vi.mocked(f.actions.closeFtpConnection).mockImplementation(() => drained.promise);
  const task = f.owner.open({ bookmarkId: f.connection.bookmarkId }),
    rejected = expect(task).rejects.toThrow();
  await vi.waitFor(() => expect(f.actions.createFtpConnection).toHaveBeenCalledOnce());
  let closed = false;
  const closing = f.owner.dispose().then(() => {
    closed = true;
  });
  created.resolve(f.connection);
  await vi.waitFor(() =>
    expect(f.actions.closeFtpConnection).toHaveBeenCalledExactlyOnceWith(f.connection.id),
  );
  expect(closed).toBe(false);
  expect(f.view).not.toHaveBeenCalled();
  drained.resolve();
  await rejected;
  await closing;
  expect(closed).toBe(true);
});
it('reconciles a lost reply using readonly outcome and never repeats FTP create', async () => {
  const f = fixture();
  vi.mocked(f.actions.createFtpConnection).mockRejectedValue(Error('LOST_ACK'));
  vi.mocked(f.actions.getFtpCommandOutcome).mockResolvedValue({
    status: 'accepted',
    id: f.connection.id,
  });
  await expect(f.owner.open({ bookmarkId: f.connection.bookmarkId })).rejects.toThrow('LOST_ACK');
  expect(f.actions.createFtpConnection).toHaveBeenCalledOnce();
  expect(f.actions.closeFtpConnection).toHaveBeenCalledExactlyOnceWith(f.connection.id);
  expect(f.view).not.toHaveBeenCalled();
  await f.owner.dispose();
});
it('retains unknown acceptance, blocks duplicate admissions and only retires it on generation replacement', async () => {
  const f = fixture();
  vi.mocked(f.actions.createFtpConnection).mockRejectedValue(Error('LOST_ACK'));
  await expect(f.owner.open({ bookmarkId: f.connection.bookmarkId })).rejects.toThrow();
  expect(f.owner.getSnapshot().unresolved).toBe(true);
  await expect(f.owner.open({ bookmarkId: f.connection.bookmarkId })).rejects.toThrow('CAPACITY');
  await expect(f.owner.reconcile()).rejects.toThrow('UNCERTAIN');
  expect(f.actions.createFtpConnection).toHaveBeenCalledOnce();
  f.replace();
  await f.owner.dispose();
  expect(f.actions.closeFtpConnection).not.toHaveBeenCalled();
});
it('retains failed view rollback and retries only exact cleanup after the native close recovers', async () => {
  const f = fixture();
  f.view.mockRejectedValue(Error('VIEW_UNAVAILABLE'));
  vi.mocked(f.actions.closeFtpConnection)
    .mockRejectedValueOnce(Error('FTP_NOT_DRAINED'))
    .mockResolvedValue();
  await expect(f.owner.open({ bookmarkId: f.connection.bookmarkId })).rejects.toThrow(
    'FTP_NOT_DRAINED',
  );
  expect(f.owner.getSnapshot().unresolved).toBe(true);
  await f.owner.reconcile();
  expect(f.actions.createFtpConnection).toHaveBeenCalledOnce();
  expect(f.actions.closeFtpConnection).toHaveBeenCalledTimes(2);
  await f.owner.dispose();
});
it('withdraws an observation even when subscribe publishes the ready baseline synchronously', async () => {
  const f = fixture(),
    off = vi.fn();
  vi.mocked(f.actions.createFtpConnection).mockResolvedValue(f.connection);
  f.actions.subscribe = (fn) => {
    f.ready();
    fn();
    return off;
  };
  await f.owner.open({ bookmarkId: f.connection.bookmarkId });
  expect(off).toHaveBeenCalledOnce();
  await f.owner.dispose();
});
