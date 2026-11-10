import { expect, it, vi } from 'vitest';
import { LocalTerminalHandle } from '../../packages/infra/subprocess-local/src/terminal.ts';
import type { ProcessInspector } from '../../packages/infra/subprocess-local/src/process-inspector.ts';

function fixture(unkillable = false) {
  let rootAlive = true;
  let nextPid = 11;
  const members = new Set([11]);
  let exit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const signalProcess = vi.fn((identity: { pid: number }, _signal: 'SIGTERM' | 'SIGKILL') => {
    if (!members.has(identity.pid) || unkillable) return;
    members.delete(identity.pid);
    // A still-running startup shell can fork another child between inspection rounds.
    if (rootAlive) members.add(++nextPid);
  });
  const identity = (pid: number) => ({ pid, started: 'owned-start-' + pid });
  const inspector: ProcessInspector = {
    foregroundPgid: () => undefined,
    isStdinWaiting: () => false,
    isAlive: (value) => (value.pid === 10 ? rootAlive : members.has(value.pid)),
    signalGroup: vi.fn(),
    signalProcess,
    snapshot: () => {
      const observedRoot = rootAlive;
      const observedChildren = new Set(members);
      return {
        complete: true,
        tree: () => [...observedChildren].map(identity).concat(observedRoot ? [identity(10)] : []),
        session: () => [],
        alive: (value) => (value.pid === 10 ? observedRoot : observedChildren.has(value.pid)),
      };
    },
  };
  const kill = vi.fn(() => {
    rootAlive = false;
    exit?.({ exitCode: 0 });
  });
  const dataOff = vi.fn(),
    exitOff = vi.fn();
  const terminal = {
    pid: 10,
    onData: () => ({ dispose: dataOff }),
    onExit: (listener: typeof exit) => {
      exit = listener;
      return { dispose: exitOff };
    },
    kill,
    pause: vi.fn(),
    resume: vi.fn(),
  } as unknown as ConstructorParameters<typeof LocalTerminalHandle>[0];
  const handle = new LocalTerminalHandle(terminal, inspector, 5, 'darwin');
  return { handle, kill, signalProcess, members, dataOff, exitOff };
}
it('stops a still-forking shell before judging its last captured descendants and joins their actual exit', async () => {
  const f = fixture();
  await f.handle.terminate();
  expect(f.kill).toHaveBeenCalledOnce();
  expect(f.signalProcess.mock.calls.some(([identity]) => identity.pid > 11)).toBe(true);
  expect(f.members.size).toBe(0);
  expect(f.handle.running).toBe(false);
  expect(f.dataOff).toHaveBeenCalledOnce();
  expect(f.exitOff).toHaveBeenCalledOnce();
  await f.handle.terminate();
  expect(f.kill).toHaveBeenCalledOnce();
});
it('still fails actual surviving descendants after stopping the root and retains unsuccessful cleanup for retry', async () => {
  const f = fixture(true);
  await expect(f.handle.terminate()).rejects.toThrow('surviving pids: 11');
  expect(f.kill).toHaveBeenCalledOnce();
  expect(f.handle.running).toBe(false);
  expect(f.members.has(11)).toBe(true);
  expect(f.dataOff).not.toHaveBeenCalled();
  expect(f.exitOff).not.toHaveBeenCalled();
  await expect(f.handle.terminate()).rejects.toThrow('surviving pids: 11');
});
