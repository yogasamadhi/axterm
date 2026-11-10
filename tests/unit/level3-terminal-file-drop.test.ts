import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FileGrant, FileGrantActions, FileTransferActions } from '@axterm/plugin-api/files';
import { transferSchema } from '@axterm/plugin-api/transfers';
import {
  TerminalFileDropOwner,
  type TerminalDropTarget,
  type TerminalDropState,
} from '../../packages/plugins/terminals/src/client/drop/owner.ts';
import {
  quoteTerminalDroppedPaths,
  terminalDroppedFilesError,
} from '../../packages/plugins/terminals/src/client/drop/model.ts';
function fixture(behavior: TerminalDropTarget['behavior'] = 'ask', kind = 'local') {
  let current: TerminalDropTarget | undefined = {
    id: randomUUID(),
    generation: randomUUID(),
    kind,
    cwd: '/srv/app',
    behavior,
    ...(kind === 'ssh' ? { connectionId: randomUUID() } : {}),
  };
  const records: TerminalDropState[] = [],
    notify = vi.fn(),
    send = vi.fn(() => true),
    grants: FileGrant[] = [];
  const grant = (name: string, kind: FileGrant['kind'] = 'file'): FileGrant => {
    const value = {
      grantId: randomUUID(),
      kind,
      name,
      permissions: ['read' as const],
      createdAt: new Date().toISOString(),
    };
    grants.push(value);
    return value;
  };
  const importing = vi.fn<NonNullable<FileGrantActions['importFileInGeneration']>>(async (file) =>
    grant(file.name),
  );
  const revoke = vi.fn<NonNullable<FileGrantActions['revokeInGeneration']>>(async () => {});
  const prepare = vi.fn<NonNullable<FileGrantActions['prepareInputPathsInGeneration']>>(
    async (ids) => ids.map((id) => '/controlled/' + grants.find((g) => g.grantId === id)!.name),
  );
  const files: FileGrantActions = {
    importFile: async () => {
      throw Error('NO_UNFENCED_IMPORT');
    },
    importFileInGeneration: importing,
    prepareInputPathsInGeneration: prepare,
    create: async () => undefined,
    createInGeneration: async () => grant('native-directory', 'directory'),
    revoke: async () => {
      throw Error('NO_UNFENCED_REVOKE');
    },
    revokeInGeneration: revoke,
  };
  const create = vi.fn<FileTransferActions['create']>(async (_g, _k, input) =>
      transferSchema.parse({
        id: randomUUID(),
        connectionId:
          input.direction === 'remote-copy' ? input.target.connectionId : input.target.connectionId,
        direction: input.direction,
        state: 'queued',
        bytesTransferred: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ),
    release = vi.fn<FileTransferActions['release']>(async () => {}),
    handoff = { create, release };
  const owner = new TerminalFileDropOwner({
    target: () => current,
    files,
    handoff: () => handoff,
    send,
    notify,
    changed: (value) => records.push(value),
  });
  return {
    owner,
    files,
    importing,
    revoke,
    prepare,
    create,
    release,
    send,
    notify,
    records,
    grants,
    get current() {
      return current;
    },
    set current(value: TerminalDropTarget | undefined) {
      current = value;
    },
  };
}
it('preserves file bounds and shell quoting without an execution delimiter', () => {
  const value = quoteTerminalDroppedPaths(['/tmp/a"$`\\b', '/tmp/中文 folder']);
  expect(value).toBe('"/tmp/a\\"\\$\\`\\\\b" "/tmp/中文 folder" ');
  expect(value).not.toMatch(/[\r\n]/u);
  expect(() => quoteTerminalDroppedPaths(['/tmp/bad\nline'])).toThrow();
  expect(terminalDroppedFilesError([new File(['x'], 'bad"name')])).toBe('UNSAFE_FILE_NAME');
  expect(
    terminalDroppedFilesError(Array.from({ length: 33 }, (_, i) => new File([], i + '.txt'))),
  ).toBe('TOO_MANY_FILES');
});
it('asks once, inserts through the captured binary producer and hands temporary file lifetime to Files Host', async () => {
  const f = fixture();
  await f.owner.files([new File(['body'], 'safe.txt')]);
  expect(f.records.at(-1)).toMatchObject({
    phase: 'asking',
    names: ['safe.txt'],
    canUpload: false,
  });
  expect(f.send).not.toHaveBeenCalled();
  await f.owner.select('path-insert');
  expect(f.prepare).toHaveBeenCalledWith(
    [f.grants[0]!.grantId],
    f.current!.generation,
    expect.any(AbortSignal),
  );
  expect(f.send).toHaveBeenCalledWith('"/controlled/safe.txt" ');
  expect(f.revoke).not.toHaveBeenCalled();
  await f.owner.close();
  expect(f.revoke).not.toHaveBeenCalled();
});
it('cancels reviewed grants and releases native directory authority after input without touching original files', async () => {
  const f = fixture();
  await f.owner.files([new File(['body'], 'cancel.txt')]);
  await f.owner.cancel();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.revoke).toHaveBeenCalledWith(f.grants[0]!.grantId, f.current!.generation);
  await f.owner.directories([randomUUID()]);
  expect(f.send).toHaveBeenCalledWith('"/controlled/native-directory" ');
  expect(f.revoke).toHaveBeenCalledTimes(2);
  await f.owner.close();
});
it('delegates uploads and grant cleanup to the existing handoff owner using the captured SSH directory', async () => {
  const f = fixture('upload', 'ssh');
  await f.owner.files([new File(['body'], 'read me.txt')]);
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.create.mock.calls[0]).toEqual([
    f.current!.generation,
    expect.any(String),
    {
      direction: 'upload',
      target: { protocol: 'sftp', connectionId: f.current!.connectionId },
      grantId: f.grants[0]!.grantId,
      remotePath: '/srv/app/read me.txt',
      recursive: false,
      conflict: 'skip',
    },
  ]);
  expect(f.release).toHaveBeenCalledWith(f.grants[0]!.grantId, f.current!.generation);
  expect(f.revoke).not.toHaveBeenCalled();
  await f.owner.close();
});
it('does not resubmit unknown uploads and leaves their grant drain with the canonical handoff owner', async () => {
  const f = fixture('upload', 'ssh');
  f.create.mockRejectedValueOnce(Error('lost ack'));
  await f.owner.files([new File(['body'], 'unknown.txt')]);
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledOnce();
  expect(f.revoke).not.toHaveBeenCalled();
  expect(f.notify).toHaveBeenCalledWith('createUploadError');
  await f.owner.close();
});
it('rejects late path results after a target/generation change and retains failed cleanup for actual close retry', async () => {
  const f = fixture('path-insert'),
    read = Promise.withResolvers<readonly string[]>();
  f.prepare.mockImplementationOnce(() => read.promise);
  const task = f.owner.files([new File(['body'], 'late.txt')]);
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
  f.current = { ...f.current!, generation: randomUUID() };
  f.revoke.mockRejectedValueOnce(Error('old generation'));
  read.resolve(['/old/late.txt']);
  await task;
  expect(f.send).not.toHaveBeenCalled();
  expect(f.revoke).toHaveBeenCalledOnce();
  await f.owner.close();
  expect(f.revoke).toHaveBeenCalledTimes(2);
});
it('joins an actual late import before revoking its grant on close and never sends to a retired view', async () => {
  const f = fixture('path-insert'),
    read = Promise.withResolvers<FileGrant>();
  f.importing.mockImplementationOnce(() => read.promise);
  const task = f.owner.files([new File(['body'], 'late.txt')]);
  await vi.waitFor(() => expect(f.importing).toHaveBeenCalledOnce());
  let closed = false;
  const close = f.owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  read.resolve({
    grantId: randomUUID(),
    kind: 'file',
    name: 'late.txt',
    permissions: ['read'],
    createdAt: new Date().toISOString(),
  });
  await task;
  await close;
  expect(f.revoke).toHaveBeenCalledOnce();
  expect(f.send).not.toHaveBeenCalled();
});

it('attempts every grant cleanup even when one authority cannot yet release', async () => {
  const f = fixture();
  await f.owner.files([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]);
  f.revoke.mockRejectedValueOnce(Error('a held')).mockRejectedValueOnce(Error('b held'));
  await expect(f.owner.cancel()).rejects.toThrow('UNDRAINED');
  f.revoke.mockImplementation(async (id) => {
    if (id === f.grants[0]!.grantId) throw Error('still held');
  });
  await expect(f.owner.close()).rejects.toThrow('UNDRAINED');
  expect(f.revoke).toHaveBeenCalledTimes(4);
  expect(f.revoke.mock.calls[3]![0]).toBe(f.grants[1]!.grantId);
});
