import { useEffect, useRef, useState } from 'react';

/** Serializes each row's mutation, reports errors and refreshes current capabilities. */
export function useTransferActions(onChanged: () => Promise<unknown>) {
  const owned = useRef(new Set<string>());
  const mounted = useRef(true);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = (id: string, action: () => Promise<unknown>) => {
    if (owned.current.has(id)) return;
    owned.current.add(id);
    setPending(new Set(owned.current));
    setFailed(false);
    void (async () => {
      try {
        await action();
      } catch {
        if (mounted.current) setFailed(true);
      } finally {
        await onChanged().catch(() => {
          if (mounted.current) setFailed(true);
        });
        owned.current.delete(id);
        if (mounted.current) setPending(new Set(owned.current));
      }
    })();
  };
  return { run, pending, failed };
}
