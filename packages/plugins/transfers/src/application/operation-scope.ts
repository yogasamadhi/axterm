/** Stop pending opens immediately; permit only a short current-operation cleanup after admission. */
export function transferOperationScope(signal: AbortSignal): {
  signal: AbortSignal;
  opened(): void;
  release(): void;
} {
  const abort = new AbortController();
  let opening = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (opening) abort.abort();
    else timer ??= setTimeout(() => abort.abort(), 1000);
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  return {
    signal: abort.signal,
    opened: () => {
      opening = false;
    },
    release: () => {
      signal.removeEventListener('abort', cancel);
      clearTimeout(timer);
      abort.abort();
    },
  };
}
