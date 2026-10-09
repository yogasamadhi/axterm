import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalSession } from '@workspace/contracts';
import type { TerminalChannel } from '../ports/terminal-channel';
import { ProductDatabase } from '../adapters/sqlite/database';
import { ProductRepository } from '../adapters/sqlite/product-repository';
import { AiService } from './ai-service';
import { AiToolService } from './ai-tool-service';
import { AiWorkspaceService } from './ai-workspace-service';
import type { ConnectionService } from './connection-service';
import { RealtimeHub } from './realtime-hub';
import { TerminalService } from './terminal-service';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'axterm-ai-workspace-')));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const listeners = new Set<(data: Uint8Array) => void>();
  const writes = vi.fn();
  const channel: TerminalChannel = {
    cwd: home,
    write: writes,
    resize() {},
    signal() {},
    pause() {},
    resume() {},
    onData: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onExit: () => () => {},
    close: async () => {},
  };
  const terminals = new TerminalService({ open: () => channel });
  cleanup.push(() => terminals.closeAll());
  const local = terminals.createLocal({ cols: 80, rows: 24 });
  const exec = vi.fn(async (_input: unknown) => ({ stdout: 'REMOTE', stderr: '', exitCode: 0 }));
  const handle = vi.fn((_id: string) => ({ exec }));
  const connections = {
    get: (id: string) => ({ id, state: 'ready' }),
    exec: (id: string, input: unknown) => handle(id).exec(input),
  } as unknown as ConnectionService;
  const workspaces = new AiWorkspaceService(terminals, connections, home);
  const emit = (path: string) => {
    for (const listener of listeners) listener(Buffer.from(`\x1b]7;file://${encodeURI(path)}\x07`));
  };
  const remote: TerminalSession = {
    ...local,
    id: randomUUID(),
    kind: 'ssh',
    connectionId: randomUUID(),
  };
  terminals.registerExternal(remote, { ...channel, cwd: "/remote/space's dir" });
  return { home, terminals, local, remote, exec, handle, workspaces, emit, writes, connections };
}

describe('selected-terminal assistant workspace and execution', () => {
  it('does not pass Desktop Host and Runtime credentials into an approved shell', async () => {
    const f = await fixture();
    vi.stubEnv('AXTERM_RUNTIME_TOKEN', 'internal-auth-canary');
    vi.stubEnv('ELECTRON_TEST_TOKEN', 'host-auth-canary');
    const bound = await f.workspaces.bind(f.local.id, {
      command: 'printf "%s:%s" "${AXTERM_RUNTIME_TOKEN-unset}" "${ELECTRON_TEST_TOKEN-unset}"',
    });
    await expect(f.workspaces.execute(f.local.id, bound)).resolves.toMatchObject({
      stdout: 'unset:unset',
      exitCode: 0,
    });
  });
  it('follows shell directory changes while approved local execution retains its snapshot', async () => {
    const f = await fixture();
    const next = join(f.home, 'next');
    await mkdir(next);
    const bound = await f.workspaces.bind(f.local.id, {
      command: 'pwd; printf approved > marker; printf warning >&2; exit 7',
    });
    f.emit(next);
    expect(await f.workspaces.resolve(f.local.id)).toMatchObject({
      workspaceDirectory: next,
      execution: 'local',
    });
    expect(await f.workspaces.execute(f.local.id, bound)).toMatchObject({
      stdout: f.home + '\n',
      stderr: 'warning',
      exitCode: 7,
    });
    expect(await readFile(join(f.home, 'marker'), 'utf8')).toBe('approved');
    await expect(readFile(join(next, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.writes).not.toHaveBeenCalled();
  });
  it('uses local ~/.axterm for SSH metadata and routes only to the bound remote connection', async () => {
    const f = await fixture();
    const workspace = await f.workspaces.resolve(f.remote.id);
    expect(workspace).toMatchObject({
      workspaceDirectory: join(f.home, '.axterm'),
      commandDirectory: "/remote/space's dir",
      execution: 'ssh',
      connectionId: f.remote.connectionId,
    });
    const bound = await f.workspaces.bind(f.remote.id, { command: 'pwd; printf remote > marker' });
    await expect(f.workspaces.execute(f.remote.id, bound)).resolves.toMatchObject({
      stdout: 'REMOTE',
      execution: 'ssh',
    });
    expect(f.handle).toHaveBeenLastCalledWith(f.remote.connectionId);
    expect(f.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "cd -- '/remote/space'\\''s dir' && (\npwd; printf remote > marker\n)",
        maxBytes: 128 * 1024,
        signal: expect.any(AbortSignal),
      }),
    );
    await expect(readFile(join(f.home, '.axterm', 'marker'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    f.handle.mockImplementation(() => {
      throw new Error('connection closed');
    });
    await expect(f.workspaces.execute(f.remote.id, bound)).rejects.toThrow('connection closed');
    expect(f.writes).not.toHaveBeenCalled();
  });
  it('rejects closed or retargeted terminals, and caller-supplied execution directories', async () => {
    const f = await fixture();
    await expect(
      f.workspaces.bind(f.local.id, { command: 'pwd', workspace: { commandDirectory: '/' } }),
    ).rejects.toThrow();
    const bound = await f.workspaces.bind(f.local.id, { command: 'pwd' });
    await expect(f.workspaces.execute(f.remote.id, bound)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await f.terminals.close(f.local.id);
    await expect(f.workspaces.execute(f.local.id, bound)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });
  it('bounds output and cancels the owned shell and its subprocess group', async () => {
    const f = await fixture();
    const noisy = await f.workspaces.bind(f.local.id, { command: 'yes output' });
    await expect(f.workspaces.execute(f.local.id, noisy)).rejects.toThrow('output limit');
    const abort = new AbortController();
    const bound = await f.workspaces.bind(f.local.id, {
      command: 'sleep 1; printf leaked > late-marker',
    });
    const executing = f.workspaces.execute(f.local.id, bound, abort.signal);
    setTimeout(() => abort.abort(), 50);
    await expect(executing).rejects.toMatchObject({ code: 'REQUEST_CANCELED' });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(readFile(join(f.home, 'late-marker'))).rejects.toMatchObject({ code: 'ENOENT' });
    const background = await f.workspaces.bind(f.local.id, {
      command: '(sleep 1; printf leaked > background-marker) & printf done',
    });
    await expect(f.workspaces.execute(f.local.id, background)).resolves.toMatchObject({
      stdout: 'done',
      exitCode: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(readFile(join(f.home, 'background-marker'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('persists exact workspace approval, executes once and never writes to the foreground CLI', async () => {
    const f = await fixture();
    const database = await ProductDatabase.open();
    const repository = new ProductRepository(database);
    const tools = new AiToolService(
      repository,
      f.terminals,
      f.connections,
      {} as never,
      f.workspaces,
    );
    const ai = new AiService(repository, undefined, new RealtimeHub(), tools, f.workspaces);
    cleanup.push(async () => {
      await ai.close();
      database.close();
    });
    const input = {
      modelId: randomUUID(),
      useCase: 'chat' as const,
      mode: 'work' as const,
      prompt: 'command',
      context: '',
      terminalId: f.local.id,
      tool: {
        name: 'workspace.exec',
        target: f.local.id,
        args: { command: 'printf approved > marker' },
      },
    };
    const key = randomUUID();
    const run = await ai.start(input, key);
    expect(await ai.start(input, key)).toMatchObject({ id: run.id });
    const approval = ai.approvals()[0]!;
    expect(ai.toolCalls(run.id)[0]?.args).toMatchObject({
      workspace: { commandDirectory: f.home },
    });
    await expect(readFile(join(f.home, 'marker'))).rejects.toMatchObject({ code: 'ENOENT' });
    const next = join(f.home, 'changed');
    await mkdir(next);
    f.emit(next);
    await ai.decideApproval(approval.id, { decision: 'approve_once', argsHash: approval.argsHash });
    expect(await readFile(join(f.home, 'marker'), 'utf8')).toBe('approved');
    await expect(
      ai.decideApproval(approval.id, { decision: 'approve_once', argsHash: approval.argsHash }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(f.writes).not.toHaveBeenCalled();
  });
});
