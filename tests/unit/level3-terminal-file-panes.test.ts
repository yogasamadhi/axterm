import { expect, it, vi } from 'vitest';
import { TerminalFilePanes } from '../../packages/plugins/terminals/src/client/files/owner.ts';
function fixture() {
  let state = {
    generation: 'g1',
    sessions: Array.from({ length: 5 }, (_, i) => ({ id: 't' + i })),
  };
  const abort = new AbortController();
  const original = {
    prepareTerminalPane: vi.fn(async () => {}),
    releaseTerminalPane: vi.fn(async () => {}),
  };
  let service = original;
  const owner = new TerminalFilePanes(
    () => state,
    () => service,
    abort.signal,
  );
  return {
    owner,
    abort,
    original,
    replace: () => {
      service = {
        prepareTerminalPane: vi.fn(async () => {}),
        releaseTerminalPane: vi.fn(async () => {}),
      };
      return service;
    },
    generation: (generation: string) => {
      state = { ...state, generation };
    },
  };
}
it('admits once, bounds live handles and rejects unknown terminals or stale generations', async () => {
  const f = fixture();
  await Promise.all([f.owner.prepare('t0', 'g1'), f.owner.prepare('t0', 'g1')]);
  expect(f.original.prepareTerminalPane).toHaveBeenCalledTimes(1);
  for (let i = 1; i < 4; i++) await f.owner.prepare('t' + i, 'g1');
  await expect(f.owner.prepare('t4', 'g1')).rejects.toThrow('CAPACITY');
  await expect(f.owner.prepare('forged', 'g1')).rejects.toThrow('RETIRED');
  await expect(f.owner.release('t0', 'g2')).rejects.toThrow('RETIRED');
  await f.owner.close();
  expect(f.original.releaseTerminalPane).toHaveBeenCalledTimes(4);
});
it('waits for actual admission and closes the original selected owner after withdrawal', async () => {
  const f = fixture(),
    pending = Promise.withResolvers<void>();
  f.original.prepareTerminalPane.mockImplementation(() => pending.promise);
  const prepare = f.owner.prepare('t0', 'g1');
  await Promise.resolve();
  const replacement = f.replace();
  let closed = false;
  const close = f.owner.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(f.original.releaseTerminalPane).not.toHaveBeenCalled();
  pending.resolve();
  await expect(prepare).rejects.toThrow('RETIRED');
  await close;
  expect(f.original.releaseTerminalPane).toHaveBeenCalledTimes(1);
  expect(replacement.releaseTerminalPane).not.toHaveBeenCalled();
});
it('fences a generation change during admission and joins the captured owner before allowing reuse', async () => {
  const f = fixture(),
    pending = Promise.withResolvers<void>();
  f.original.prepareTerminalPane.mockImplementationOnce(() => pending.promise);
  const first = f.owner.prepare('t0', 'g1'),
    duplicate = f.owner.prepare('t0', 'g1');
  await Promise.resolve();
  f.generation('g2');
  pending.resolve();
  await expect(first).rejects.toThrow('RETIRED');
  await expect(duplicate).rejects.toThrow('RETIRED');
  const replacement = f.replace();
  await f.owner.prepare('t0', 'g2');
  expect(replacement.prepareTerminalPane).toHaveBeenCalledWith('t0', 'g2');
  expect(replacement.releaseTerminalPane).not.toHaveBeenCalled();
  await f.owner.close();
});
it('retains failed release responsibility, refuses reuse and never calls a replacement owner to fake cleanup', async () => {
  const f = fixture();
  await f.owner.prepare('t0', 'g1');
  f.original.releaseTerminalPane.mockRejectedValueOnce(Error('unknown native cleanup'));
  await expect(f.owner.release('t0', 'g1')).rejects.toThrow('unknown native cleanup');
  const replacement = f.replace();
  await expect(f.owner.prepare('t0', 'g1')).rejects.toThrow('RETIRED');
  await expect(f.owner.close()).rejects.toThrow('UNDRAINED');
  expect(replacement.releaseTerminalPane).not.toHaveBeenCalled();
  expect(f.original.releaseTerminalPane).toHaveBeenCalledTimes(1);
});
it('cleans failed admission and refuses new work after abort', async () => {
  const f = fixture();
  f.original.prepareTerminalPane.mockRejectedValueOnce(Error('missing Files facet'));
  await expect(f.owner.prepare('t0', 'g1')).rejects.toThrow('missing Files facet');
  expect(f.original.releaseTerminalPane).toHaveBeenCalledWith('t0', 'g1');
  f.abort.abort();
  await expect(f.owner.prepare('t1', 'g1')).rejects.toThrow('RETIRED');
  await f.owner.close();
});
