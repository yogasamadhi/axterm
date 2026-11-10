import { randomUUID } from 'node:crypto';
import { RemoteError } from '@axterm/plugin-api';
import { expect, it, vi } from 'vitest';
import { terminalSessionSchema } from '@axterm/plugin-api/terminals';
import { connectionSchema } from '@axterm/plugin-api/connections';
import { AiWorkspaceService } from '../../packages/plugins/ai/src/application/ai-workspace-service.ts';
import { workspaceExecutionFacts } from '../../packages/plugins/ai/src/adapters/workspace-command.ts';
function fixture(kind: 'local' | 'ssh' | 'serial' = 'local') {
  const id = randomUUID();
  const connectionId = randomUUID();
  const now = new Date().toISOString();
  const terminal = terminalSessionSchema.parse({
    id,
    kind,
    title: 'Selected',
    state: 'ready',
    createdAt: now,
    ...(kind === 'ssh' ? { connectionId } : {}),
  });
  const connection = connectionSchema.parse({
    id: connectionId,
    hostId: randomUUID(),
    state: 'ready',
    reconnectAttempt: 0,
    nextReconnectAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const target = { hostname: 'selected.example', port: 22, username: 'operator', generation: 1 };
  const local = vi.fn(async () => ({ stdout: 'local', stderr: '', exitCode: 0 }));
  const remote = vi.fn(async () => ({ stdout: 'remote', stderr: '', exitCode: 0 }));
  const terminalPort = {
    get: () => structuredClone(terminal),
    workingDirectory: () => '/selected dir',
  };
  const connectionPort = {
    get: () => structuredClone(connection),
    executionTarget: () => ({ ...target }),
    exec: remote,
  };
  const workspace = new AiWorkspaceService(
    terminalPort,
    connectionPort,
    { facts: workspaceExecutionFacts, execute: local },
    { localHome: '/controlled-home', remoteWorkspace: '/controlled-profile/workspace' },
  );
  return {
    workspace,
    terminal,
    target,
    connection,
    local,
    remote,
    id,
    terminalPort,
    connectionPort,
  };
}
it('binds and executes the reviewed local directory through the selected command port', async () => {
  const f = fixture();
  const bound = await f.workspace.bind(f.id, { command: 'pwd' });
  expect(bound.workspace.commandDirectory).toBe('/selected dir');
  expect(await f.workspace.execute(f.id, bound)).toMatchObject({
    execution: 'local',
    stdout: 'local',
  });
  expect(f.local).toHaveBeenCalledWith('pwd', '/selected dir', expect.anything());
  expect(f.remote).not.toHaveBeenCalled();
});
it('pins SSH identity and reconnect generation before command execution', async () => {
  const f = fixture('ssh');
  const bound = await f.workspace.bind(f.id, { command: 'pwd' });
  f.target.generation++;
  await expect(f.workspace.execute(f.id, bound)).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
  expect(f.remote).not.toHaveBeenCalled();
  expect(f.local).not.toHaveBeenCalled();
});
it('executes only on the captured SSH target and quotes its command directory', async () => {
  const f = fixture('ssh');
  const bound = await f.workspace.bind(f.id, { command: 'pwd' });
  expect(await f.workspace.execute(f.id, bound)).toMatchObject({
    execution: 'ssh',
    stdout: 'remote',
  });
  expect(f.remote).toHaveBeenCalledWith(f.terminal.connectionId, {
    command: "cd -- '/selected dir' && (\npwd\n)",
    maxBytes: 128 * 1024,
    signal: expect.anything(),
  });
  expect(f.local).not.toHaveBeenCalled();
});
it('rejects closed terminals, foreign targets and unsupported session kinds without effects', async () => {
  const f = fixture();
  const bound = await f.workspace.bind(f.id, { command: 'pwd' });
  f.terminal.state = 'closed';
  await expect(f.workspace.execute(f.id, bound)).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
  });
  expect(f.local).not.toHaveBeenCalled();
  const serial = fixture('serial');
  const unsupported = await serial.workspace.bind(serial.id, { command: 'pwd' });
  await expect(serial.workspace.execute(serial.id, unsupported)).rejects.toMatchObject({
    code: 'CAPABILITY_UNAVAILABLE',
  });
  expect(serial.local).not.toHaveBeenCalled();
});

it('maps only public target retirement to a precondition and preserves unknown owner failures without fallback IO', async () => {
  for (const stage of ['terminal', 'directory', 'connection', 'identity'] as const) {
    for (const reason of ['not-found', 'closed', 'stale', 'unavailable'] as const) {
      const f = fixture('ssh');
      const failure = new RemoteError(
        stage === 'terminal' || stage === 'directory' ? 'terminals/failure' : 'connections/failure',
        'Target unavailable',
        { reason },
      );
      const reject = () => {
        throw failure;
      };
      if (stage === 'terminal') vi.spyOn(f.terminalPort, 'get').mockImplementation(reject);
      else if (stage === 'directory')
        vi.spyOn(f.terminalPort, 'workingDirectory').mockImplementation(reject);
      else if (stage === 'connection') vi.spyOn(f.connectionPort, 'get').mockImplementation(reject);
      else vi.spyOn(f.connectionPort, 'executionTarget').mockImplementation(reject);
      if (reason === 'unavailable') await expect(f.workspace.resolve(f.id)).rejects.toBe(failure);
      else await expect(f.workspace.resolve(f.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(f.local).not.toHaveBeenCalled();
      expect(f.remote).not.toHaveBeenCalled();
    }
  }
});
