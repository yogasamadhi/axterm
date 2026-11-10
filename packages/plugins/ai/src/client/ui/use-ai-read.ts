import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AiReadLease } from '../read-registry.ts';
import type { AiReadState } from '../read-resource.ts';
import type { AiPanelQueries, AiQueryKind, AiQueryValue } from '../panel-queries.ts';
const pending: AiReadState<never> = Object.freeze({
  data: undefined,
  isSuccess: false,
  isPending: true,
  isError: false,
});
const subscribePending = () => () => {};
const getPending = () => pending;
/** React holds a reader identity. Admission failure is recoverable within the feature. */
export function useAiRead<K extends AiQueryKind>(owner: AiPanelQueries, kind: K, id?: string) {
  const key = kind + ':' + (id ?? '');
  const [current, setCurrent] = useState<{ key: string; lease: AiReadLease<AiQueryValue<K>> }>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stopped = false;
    let lease: AiReadLease<AiQueryValue<K>> | undefined;
    queueMicrotask(() => {
      if (stopped) return;
      setFailed(false);
      try {
        lease = owner.open(kind, id);
      } catch {
        setFailed(true);
        setCurrent(undefined);
        return;
      }
      if (!lease) {
        setCurrent(undefined);
        return;
      }
      const owned = lease;
      setCurrent({ key, lease: owned });
    });
    return () => {
      stopped = true;
      void lease?.dispose().catch(() => {});
    };
  }, [owner, kind, id, key, attempt]);
  const resource = current?.key === key ? current.lease.resource : undefined;
  const state = useSyncExternalStore(
    resource?.subscribe ?? subscribePending,
    resource?.getSnapshot ?? getPending,
  );
  return {
    ...state,
    isError: failed || state.isError,
    isPending: !failed && state.isPending,
    refetch: () => {
      if (resource) return resource.refetch();
      setAttempt((value) => value + 1);
      return Promise.resolve(pending);
    },
  };
}
