import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { forEachJoined } from '../../scripts/joined-tasks.mjs';
it('stops admission after a failure and waits for every actual filesystem task before rejecting', async () => {
  const late = Promise.withResolvers<void>(),
    first = Promise.withResolvers<void>();
  const admitted: number[] = [];
  let active = 0,
    maximum = 0;
  const failure = new Error('controlled copy failure');
  const task = forEachJoined([0, 1, 2, 3], 2, async (value) => {
    admitted.push(value);
    maximum = Math.max(maximum, ++active);
    try {
      if (value === 0) {
        await first.promise;
        throw failure;
      }
      await late.promise;
    } finally {
      active--;
    }
  });
  let settled = false;
  const rejected = expect(task).rejects.toBe(failure);
  void task.catch(() => {
    settled = true;
  });
  first.resolve();
  await setImmediate();
  expect(settled).toBe(false);
  expect(admitted).toEqual([0, 1]);
  expect(active).toBe(1);
  late.resolve();
  await rejected;
  expect(active).toBe(0);
  expect(maximum).toBe(2);
  expect(admitted).toEqual([0, 1]);
});
