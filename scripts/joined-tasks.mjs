/**
 * Bound independent filesystem work and join every admitted task before reporting failure.
 * @template T
 * @param {readonly T[]} values
 * @param {number} concurrency
 * @param {(value: T, index: number) => unknown | PromiseLike<unknown>} perform
 * @returns {Promise<void>}
 */
export async function forEachJoined(values, concurrency, perform) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error('Invalid task concurrency');
  let next = 0;
  let failed = false;
  let failure;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (!failed) {
        const index = next++;
        if (index >= values.length) return;
        try {
          await perform(values[index], index);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    }),
  );
  if (failed) throw failure;
}
