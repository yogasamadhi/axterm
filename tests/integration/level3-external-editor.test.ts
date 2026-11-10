import { Context } from '@deepseek-ai/cordis';
import { mkdtemp, writeFile, readFile, rename, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { RemoteError } from '@axterm/plugin-api';
import {
  ShellFileGrantCapabilities,
  type NativeClient,
  type NativeMethod,
} from '@axterm/infra-desktop-native';
import DesktopFileGrants from '@axterm/infra-desktop-native/files';
import type { FileOperationReceipt, WriteRemoteText } from '@axterm/plugin-api/files';
import type { FileCommands } from '../../packages/plugins/files/src/ports/commands.ts';
import { GrantedStreamingFiles } from '../../packages/plugins/files/src/adapters/streaming-files.ts';
import { ExternalEditorApplication } from '../../packages/plugins/files/src/application/external-editor.ts';
import { ExternalEditorsProjection } from '../../packages/plugins/files/src/client/external-editors-projection.ts';
const signal = () => new AbortController().signal;
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'axterm-external-editor-')),
    generation = randomUUID(),
    ctx = new Context();
  const shell = new ShellFileGrantCapabilities(generation, undefined, join(home, 'copies'));
  const handlers = shell.handlers();
  ctx.provide('runtimeIdentity', { generation, mode: 'desktop' } as Context['runtimeIdentity']);
  ctx.provide('desktopNative', {
    generation,
    signal: signal(),
    call: (method: NativeMethod, input: unknown, owned: AbortSignal = signal()) =>
      (handlers[method as keyof typeof handlers] as (input: never, signal: AbortSignal) => unknown)(
        input as never,
        owned,
      ),
  } as unknown as NativeClient);
  const grants = ctx.plugin(DesktopFileGrants);
  await grants;
  const local = new GrantedStreamingFiles(() => ctx.fileGrants);
  const opened: { grantId: string; path: string }[] = [];
  const open = vi.fn(async (grantId: string, path: string) => {
    opened.push({ grantId, path });
  });
  ctx.provide('fileApplications', { open, reveal: async () => {} });
  let content = 'initial\n',
    revision = 'one';
  const remote = {
    readText: vi.fn(async () => ({
      path: '/note.txt',
      content,
      revision,
      lineEnding: 'lf' as const,
    })),
    saveExternalText: vi.fn(async (_target: unknown, input: WriteRemoteText) => {
      if (input.overwriteRevision !== revision)
        throw new RemoteError('files/failure', 'CONFLICT', { reason: 'conflict' });
      content = input.content;
      revision = randomUUID();
      return { path: input.path, content, revision, lineEnding: input.lineEnding };
    }),
  };
  const receipts = new Map<string, Promise<FileOperationReceipt>>();
  let cursor = 0;
  const commands: FileCommands = {
    execute: (id, operation, _input, perform, owned) => {
      let result = receipts.get(id);
      if (!result) {
        result = perform(owned).then((changedCount) => ({
          id,
          operation,
          cursor: ++cursor,
          changedCount,
        }));
        receipts.set(id, result);
      }
      return result;
    },
    close: async () => {},
  };
  const app = new ExternalEditorApplication(ctx, local, remote, commands);
  const input = {
    generation,
    target: { protocol: 'sftp' as const, connectionId: randomUUID() },
    path: '/note.txt',
  };
  const path = async () => {
    const entry = opened.at(-1)!;
    const authority = await shell.registry.authorize(entry.grantId, 'read');
    return join(authority.rootPath, entry.path);
  };
  return {
    home,
    generation,
    ctx,
    shell,
    grants,
    local,
    app,
    input,
    opened,
    open,
    remote,
    path,
    changeRemote: () => {
      revision = 'foreign';
    },
    cleanup: async () => {
      await app.close().catch(() => {});
      await local.close();
      await ctx.fiber.dispose();
      await shell.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
it('supports actual managed copies, atomic editor replacement, explicit revision-safe upload and idempotent receipts', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    const receipt = await f.app.create(id, f.input, signal());
    expect(await f.app.create(id, f.input, signal())).toEqual(receipt);
    expect(f.open).toHaveBeenCalledTimes(1);
    const path = await f.path();
    expect(await readFile(path, 'utf8')).toBe('initial\n');
    expect(await f.app.snapshot(signal())).toMatchObject({ sessions: [{ id, state: 'watching' }] });
    await writeFile(path + '.tmp', 'edited\n');
    await rename(path + '.tmp', path);
    expect(await f.app.snapshot(signal())).toMatchObject({ sessions: [{ state: 'changed' }] });
    expect(f.remote.saveExternalText).not.toHaveBeenCalled();
    const key = randomUUID();
    await f.app.push(f.generation, key, id, signal());
    await f.app.push(f.generation, key, id, signal());
    expect(f.remote.saveExternalText).toHaveBeenCalledTimes(1);
    expect(await f.app.snapshot(signal())).toMatchObject({ sessions: [{ state: 'saved' }] });
    await writeFile(path, 'second');
    f.changeRemote();
    await expect(f.app.push(f.generation, randomUUID(), id, signal())).rejects.toMatchObject({
      details: { reason: 'conflict' },
    });
    expect(await f.app.snapshot(signal())).toMatchObject({ sessions: [{ state: 'conflict' }] });
    expect(await readFile(path, 'utf8')).toBe('second');
    expect(JSON.stringify(await f.app.snapshot(signal()))).not.toContain(f.home);
    expect(JSON.stringify(await f.app.snapshot(signal()))).not.toContain('second');
    await f.app.remove(f.generation, randomUUID(), id, signal());
    expect(await f.app.snapshot(signal())).toEqual({ sessions: [] });
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.local.resourceCount()).toBe(0);
  } finally {
    await f.cleanup();
  }
});
it('retains an uncertain accepted launch for inspection and explicit close, never automatic relaunch', async () => {
  const f = await fixture();
  try {
    f.open.mockImplementationOnce(async () => {
      throw new RemoteError('files/failure', 'UNCERTAIN', { reason: 'uncertain' });
    });
    const id = randomUUID();
    await expect(f.app.create(id, f.input, signal())).rejects.toMatchObject({
      details: { reason: 'uncertain' },
    });
    await expect(f.app.create(id, f.input, signal())).rejects.toMatchObject({
      details: { reason: 'uncertain' },
    });
    expect(f.open).toHaveBeenCalledTimes(1);
    const snapshot = await f.app.snapshot(signal());
    expect(snapshot).toMatchObject({ sessions: [{ id, state: 'error', reason: 'uncertain' }] });
    expect(f.app.resourceCount()).toBe(1);
    await f.app.remove(f.generation, randomUUID(), id, signal());
    expect(f.app.resourceCount()).toBe(0);
  } finally {
    await f.cleanup();
  }
});
it('bounds admission, rejects stale generations, binary/growing copies and links without remote upload', async () => {
  const f = await fixture();
  try {
    expect(() =>
      f.app.create(randomUUID(), { ...f.input, generation: randomUUID() }, signal()),
    ).toThrow();
    for (let i = 0; i < 8; i++) await f.app.create(randomUUID(), f.input, signal());
    await expect(f.app.create(randomUUID(), f.input, signal())).rejects.toMatchObject({
      details: { reason: 'capacity' },
    });
    const id = (await f.app.snapshot(signal())).sessions.at(-1)!.id,
      path = await f.path();
    await rm(path);
    await symlink('/etc/hosts', path);
    await expect(f.app.push(f.generation, randomUUID(), id, signal())).rejects.toMatchObject({
      details: { reason: expect.any(String) },
    });
    expect(f.remote.saveExternalText).not.toHaveBeenCalled();
    await rm(path);
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1, 97));
    expect(await f.app.snapshot(signal())).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ id, state: 'error', reason: 'capacity' }),
      ]),
    });
    await writeFile(path, Buffer.from([0, 1]));
    expect(await f.app.snapshot(signal())).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({ id, state: 'error', reason: 'invalid-input' }),
      ]),
    });
  } finally {
    await f.cleanup();
  }
});
it('retains failed cleanup ownership and reports disposal failure', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    await f.app.create(id, f.input, signal());
    const original = f.ctx.fileImports.discard;
    f.ctx.fileImports.discard = async () => {
      throw Error('CONTROLLED_DISCARD_FAILURE');
    };
    await expect(f.app.remove(f.generation, randomUUID(), id, signal())).rejects.toThrow();
    expect(f.app.resourceCount()).toBeGreaterThan(0);
    f.ctx.fileImports.discard = original;
    await f.app.remove(f.generation, randomUUID(), id, signal());
  } finally {
    await f.cleanup();
  }
});
it('replaces validated complete external-edit baselines and rejects body-bearing malformed frames', () => {
  const projection = new ExternalEditorsProjection(),
    generation = randomUUID();
  const accept = (cursor: number, text: string, mode: 'baseline' | 'replace') => {
    projection.accept({ type: 'begin', generation, cursor, mode });
    projection.accept({ type: 'chunk', offset: 0, text, final: true });
    return projection.accept({ type: 'commit', cursor });
  };
  expect(accept(0, JSON.stringify({ sessions: [] }), 'baseline')).toEqual({
    generation,
    cursor: 0,
    sessions: [],
  });
  expect(accept(1, JSON.stringify({ sessions: [] }), 'replace')).toEqual({
    generation,
    cursor: 1,
    sessions: [],
  });
  expect(() =>
    accept(2, JSON.stringify({ sessions: [], content: 'PRIVATE' }), 'replace'),
  ).toThrow();
  projection.reset();
  expect(accept(0, JSON.stringify({ sessions: [] }), 'baseline')?.cursor).toBe(0);
});

it('launches a configured editor as argv and joins its managed process before removing the copy', async () => {
  const f = await fixture();
  try {
    const finished = Promise.withResolvers<{ exitCode: number; signal: null }>(),
      drained = Promise.withResolvers<void>();
    const dispose = vi.fn(() => drained.promise),
      spawn = vi.fn((_spec: { argv: string[]; cwd: string; stdio: unknown }) => ({
        done: finished.promise,
        dispose,
      }));
    f.ctx.provide('configuration', {
      getSettings: () => ({ fileManager: { externalEditor: '/controlled/editor with spaces' } }),
    } as Context['configuration']);
    f.ctx.provide('subprocess', { spawn } as unknown as Context['subprocess']);
    const id = randomUUID();
    await f.app.create(id, f.input, signal());
    expect(f.open).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledOnce();
    const spec = spawn.mock.calls[0]![0] as { argv: string[]; cwd: string; stdio: unknown };
    expect(spec.argv).toEqual(['/controlled/editor with spaces', join(spec.cwd, 'note.txt')]);
    let closed = false;
    const closing = f.app.remove(f.generation, randomUUID(), id, signal()).then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(closed).toBe(false);
    expect(f.app.resourceCount()).toBeGreaterThan(0);
    finished.resolve({ exitCode: 0, signal: null });
    drained.resolve();
    await closing;
    expect((await f.app.snapshot(signal())).sessions).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
it('fails unload when accepted local copies cannot be released', async () => {
  const f = await fixture();
  try {
    await f.app.create(randomUUID(), f.input, signal());
    const original = f.ctx.fileImports.discard;
    f.ctx.fileImports.discard = async () => {
      throw Error('CONTROLLED_DISCARD_FAILURE');
    };
    await expect(f.app.close()).rejects.toMatchObject({ details: { reason: 'uncertain' } });
    expect(f.app.resourceCount()).toBeGreaterThan(0);
    f.ctx.fileImports.discard = original;
  } finally {
    await f.cleanup();
  }
});

it('keeps portable copy naming for unusual remote names and the existing one-hour editor lease', async () => {
  const f = await fixture();
  try {
    await f.app.create(randomUUID(), { ...f.input, path: '/remote:a"b\'?.txt' }, signal());
    const value = (await f.app.snapshot(signal())).sessions[0]!;
    expect(value.fileName).toBe('remote_a_b__.txt');
    expect(Date.parse(value.expiresAt) - Date.parse(value.createdAt)).toBeGreaterThan(3_590_000);
  } finally {
    await f.cleanup();
  }
});

it('preserves a UTF-8 BOM instead of marking an unchanged copy dirty or dropping it on upload', async () => {
  const f = await fixture();
  try {
    f.remote.readText.mockResolvedValueOnce({
      path: '/note.txt',
      content: '\uFEFFtext',
      revision: 'one',
      lineEnding: 'lf',
    });
    const id = randomUUID();
    await f.app.create(id, f.input, signal());
    expect((await f.app.snapshot(signal())).sessions[0]?.state).toBe('watching');
    await f.app.push(f.generation, randomUUID(), id, signal());
    expect(f.remote.saveExternalText.mock.calls[0]![1].content).toBe('\uFEFFtext');
  } finally {
    await f.cleanup();
  }
});
