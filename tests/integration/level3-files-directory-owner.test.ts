import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import type { FileGrant } from '@axterm/plugin-api/files';
import { LocalDirectoryGrantOwner } from '../../packages/plugins/files/src/client/ui/local-directory-grant-owner.ts';
import {
  filterFileEntries,
  sortFileEntries,
} from '../../packages/plugins/files/src/client/ui/file-list-model.ts';
const grant = (grantId: string): FileGrant => ({
  grantId,
  kind: 'directory',
  name: 'Fixture',
  permissions: ['read', 'write'],
  createdAt: new Date().toISOString(),
});
it('keeps the newest selection and revokes a delayed superseded grant', async () => {
  const first = Promise.withResolvers<FileGrant | undefined>(),
    second = Promise.withResolvers<FileGrant | undefined>();
  const create = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    revoke = vi.fn(async () => {});
  const owner = new LocalDirectoryGrantOwner({ create, revoke }, () => 'generation');
  const older = owner.select({ kind: 'home-directory' }),
    newer = owner.select({ kind: 'open-directory' });
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  second.resolve(grant('new'));
  expect((await newer)?.grantId).toBe('new');
  first.resolve(grant('old'));
  expect(await older).toBeUndefined();
  expect(owner.current()?.grantId).toBe('new');
  expect(revoke).toHaveBeenCalledExactlyOnceWith('old', 'generation');
  await owner.dispose();
  expect(revoke).toHaveBeenLastCalledWith('new', 'generation');
  expect(owner.resourceCount()).toBe(0);
});
it('cancels and joins a late selection and its actual revocation before disposal completes', async () => {
  const selected = Promise.withResolvers<FileGrant | undefined>(),
    released = Promise.withResolvers<void>();
  const create = vi.fn((_input, _generation: string, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      return selected.promise;
    }),
    revoke = vi.fn(() => released.promise);
  const owner = new LocalDirectoryGrantOwner({ create, revoke }, () => 'generation');
  const selection = owner.select({ kind: 'open-directory' });
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  let disposed = false;
  const closing = owner.dispose().then(() => {
    disposed = true;
  });
  expect(create.mock.calls[0]![2].aborted).toBe(true);
  expect(owner.current()).toBeUndefined();
  expect(disposed).toBe(false);
  selected.resolve(grant('late'));
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('late', 'generation'));
  expect(disposed).toBe(false);
  released.resolve();
  await selection;
  await closing;
  expect(owner.resourceCount()).toBe(0);
  await expect(owner.select({ kind: 'open-directory' })).rejects.toThrow('CLOSED');
});
it('fences a generation change and keeps uncertain failed revocation ownership', async () => {
  let generation = randomUUID();
  const next = Promise.withResolvers<FileGrant | undefined>();
  const create = vi.fn(() => next.promise),
    revoke = vi.fn(async () => {
      throw Error('UNCERTAIN_REVOCATION');
    });
  const owner = new LocalDirectoryGrantOwner(
    { create, revoke },
    () => generation,
    grant('initial'),
  );
  const selecting = owner.select({ kind: 'open-directory' });
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  generation = randomUUID();
  expect(owner.current()).toBeUndefined();
  next.resolve(grant('late-generation'));
  await expect(selecting).rejects.toThrow('GENERATION_CHANGED');
  await expect(owner.dispose()).rejects.toThrow('UNDRAINED');
  expect(owner.resourceCount()).toBe(2);
});
it('retires definite same-generation absent authorities while keeping same-id late replies from revoking the live scope', async () => {
  const first = Promise.withResolvers<FileGrant | undefined>(),
    second = Promise.withResolvers<FileGrant | undefined>();
  const create = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    revoke = vi.fn(async () => {
      throw new RemoteError('files/failure', 'ABSENT', { reason: 'not-found' });
    });
  const owner = new LocalDirectoryGrantOwner({ create, revoke }, () => 'generation');
  const older = owner.select({ kind: 'home-directory' }),
    newer = owner.select({ kind: 'open-directory' });
  second.resolve(grant('same'));
  await newer;
  first.resolve(grant('same'));
  await older;
  expect(revoke).not.toHaveBeenCalled();
  await owner.dispose();
  expect(revoke).toHaveBeenCalledOnce();
  expect(owner.resourceCount()).toBe(0);
});
it('bounds unresolved picker requests and does not create work when cancelled or not ready', async () => {
  const done = Promise.withResolvers<FileGrant | undefined>(),
    create = vi.fn(() => done.promise),
    revoke = vi.fn(async () => {});
  const owner = new LocalDirectoryGrantOwner({ create, revoke }, () => 'generation');
  const one = owner.select({ kind: 'open-directory' }),
    two = owner.select({ kind: 'home-directory' });
  await expect(owner.select({ kind: 'downloads-directory' })).rejects.toThrow('CAPACITY');
  done.resolve(undefined);
  await Promise.all([one, two]);
  await owner.dispose();
  const unavailable = new LocalDirectoryGrantOwner({ create, revoke }, () => undefined);
  await expect(unavailable.select({ kind: 'open-directory' })).rejects.toThrow('NOT_READY');
  await unavailable.dispose();
});
it('retains directory-first sorting, hidden filtering, column order and immutable input facts', () => {
  const entries = [
    { name: 'b.txt', path: 'b.txt', type: 'file' as const, size: 2 },
    { name: 'A.txt', path: 'A.txt', type: 'file' as const, size: 1 },
    { name: '.hidden', path: '.hidden', type: 'file' as const, size: 0 },
    { name: 'folder', path: 'folder', type: 'directory' as const, size: 0 },
  ];
  expect(
    sortFileEntries(entries, { property: 'size', direction: 'desc' }).map((x) => x.name),
  ).toEqual(['folder', 'b.txt', 'A.txt', '.hidden']);
  expect(filterFileEntries(entries, false, 'TXT').map((x) => x.name)).toEqual(['b.txt', 'A.txt']);
  expect(entries[0]?.name).toBe('b.txt');
});

it('retains stale revocation and replacement-generation not-found as uncertain cleanup', async () => {
  for (const replacement of [false, true]) {
    let generation = 'original';
    const revoke = vi.fn(async () => {
      if (replacement) generation = 'replacement';
      throw new RemoteError('files/failure', 'UNCONFIRMED', {
        reason: replacement ? 'not-found' : 'stale',
      });
    });
    const owner = new LocalDirectoryGrantOwner(
      { create: vi.fn(), revoke },
      () => generation,
      grant('retained'),
    );
    await expect(owner.dispose()).rejects.toThrow('UNDRAINED');
    expect(revoke).toHaveBeenCalledExactlyOnceWith('retained', 'original');
    expect(owner.resourceCount()).toBe(1);
  }
});
it('never publishes an older selection after superseded initial-grant cleanup completes late', async () => {
  const cleanup = Promise.withResolvers<void>();
  const create = vi.fn().mockResolvedValueOnce(grant('old')).mockResolvedValueOnce(grant('new'));
  const revoke = vi.fn((id: string) => (id === 'initial' ? cleanup.promise : Promise.resolve()));
  const owner = new LocalDirectoryGrantOwner(
    { create, revoke },
    () => 'generation',
    grant('initial'),
  );
  const old = owner.select({ kind: 'home-directory' });
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith('initial', 'generation'));
  const current = await owner.select({ kind: 'open-directory' });
  expect(current?.grantId).toBe('new');
  expect(owner.current()?.grantId).toBe('new');
  cleanup.resolve();
  expect(await old).toBeUndefined();
  expect(owner.current()?.grantId).toBe('new');
  await owner.dispose();
  expect(revoke.mock.calls.map(([id]) => id)).toEqual(['initial', 'old', 'new']);
  expect(owner.resourceCount()).toBe(0);
});
