import { expect, it, vi } from 'vitest';
import {
  createProcessInspector,
  type ProcessInspectorInternals,
} from '../../packages/infra/subprocess-local/src/process-inspector.ts';
function fixture() {
  const started = 'Mon Nov  9 00:00:00 2026';
  let table = `10 1 Ss ${started}\n11 10 Z+ ${started}\n12 11 R+ ${started}\n13 10 X ${started}\n14 10 ? ${started}\n`;
  const exec = vi.fn(() => table),
    kill = vi.fn();
  const unused = () => {
    throw Error('Unexpected filesystem access');
  };
  const internals: ProcessInspectorInternals = {
    exec,
    kill,
    readFile: unused,
    readDir: unused,
    readLink: unused,
    stat: unused,
    open: unused,
    read: unused,
    close: unused,
  };
  return {
    started,
    exec,
    kill,
    inspector: createProcessInspector('darwin', 'arm64', internals),
    setTable(value: string) {
      table = value;
    },
  };
}
it('excludes exited rows from liveness while retaining their live descendants and exact signal fences', () => {
  const f = fixture(),
    snapshot = f.inspector.snapshot();
  expect(f.exec).toHaveBeenCalledWith('/bin/ps', ['-axo', 'pid=,ppid=,stat=,lstart=']);
  expect(snapshot.complete).toBe(true);
  expect(snapshot.tree(10).map((member) => member.pid)).toEqual([12, 11, 13, 14, 10]);
  expect(snapshot.alive({ pid: 11, started: f.started })).toBe(false);
  expect(snapshot.alive({ pid: 13, started: f.started })).toBe(false);
  expect(snapshot.alive({ pid: 12, started: f.started })).toBe(true);
  expect(snapshot.alive({ pid: 14, started: f.started })).toBe(true);
  expect(f.exec).toHaveBeenCalledTimes(1);
  f.inspector.signalProcess({ pid: 11, started: f.started }, 'SIGKILL');
  f.inspector.signalProcess({ pid: 12, started: 'reused pid' }, 'SIGKILL');
  expect(f.kill).not.toHaveBeenCalled();
  f.inspector.signalProcess({ pid: 12, started: f.started }, 'SIGTERM');
  expect(f.kill).toHaveBeenCalledExactlyOnceWith(12, 'SIGTERM');
  f.setTable(`12 11 Z ${f.started}\n`);
  expect(f.inspector.isAlive({ pid: 12, started: f.started })).toBe(false);
  f.inspector.signalProcess({ pid: 12, started: f.started }, 'SIGKILL');
  expect(f.kill).toHaveBeenCalledOnce();
  expect(snapshot.alive({ pid: 12, started: f.started })).toBe(true);
});
it('does not certify incomplete tables or turn process inspection errors into an empty range', () => {
  const f = fixture();
  f.setTable(`10 1 S ${f.started}\nmalformed row\n`);
  expect(f.inspector.snapshot().complete).toBe(false);
  f.exec.mockImplementation(() => {
    throw Error('OS_INSPECTION_UNAVAILABLE');
  });
  expect(() => f.inspector.snapshot()).toThrow('OS_INSPECTION_UNAVAILABLE');
  expect(() => f.inspector.isAlive({ pid: 10, started: f.started })).toThrow(
    'OS_INSPECTION_UNAVAILABLE',
  );
  expect(() => f.inspector.signalProcess({ pid: 10, started: f.started }, 'SIGKILL')).toThrow(
    'OS_INSPECTION_UNAVAILABLE',
  );
  expect(f.kill).not.toHaveBeenCalled();
});
