/** One Desktop-owned cancellation barrier; no resources are released before the actual generator settles. */
export function ownDesktopIterator<T>(
  open: (signal: AbortSignal) => AsyncGenerator<T>,
  signals: readonly AbortSignal[],
  release: () => void,
): AsyncGenerator<T> {
  const local = new AbortController(),
    signal = AbortSignal.any([...signals, local.signal]);
  signal.throwIfAborted();
  const source = open(signal);
  let ending: Promise<IteratorResult<T>> | undefined,
    disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', aborted);
    release();
  };
  const finish = () => (ending ??= source.return(undefined).finally(cleanup));
  const aborted = () => {
    void finish().catch(() => {});
  };
  const iterator: AsyncGenerator<T> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(...args) {
      if (ending) return ending;
      try {
        const value = await source.next(...args);
        if (value.done) cleanup();
        return value;
      } catch (error) {
        cleanup();
        throw error;
      }
    },
    return() {
      local.abort();
      return finish();
    },
    throw(error) {
      local.abort();
      return finish().then(() => {
        throw error;
      });
    },
    async [Symbol.asyncDispose]() {
      local.abort();
      await finish();
    },
  };
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();
  return iterator;
}
