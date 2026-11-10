import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { AiPanelActions } from './panel-actions.ts';
import type { ContextReviewOwner, ContextReviewState } from './context-review-owner.ts';
import { useI18n } from './i18n.tsx';
const initial: ContextReviewState = Object.freeze({
  preview: undefined,
  busy: false,
  error: undefined,
});
const subscribe = () => () => {};
const snapshot = () => initial;
const noPrepare = async () => {};
/** React owns only the selected review identity and the terminal target. */
export function useAiContextReview(
  client: Pick<AiPanelActions, 'createReviewOwner'>,
  terminalId: string | undefined,
) {
  const { x } = useI18n();
  const [owner, setOwner] = useState<ContextReviewOwner>();
  useEffect(() => {
    let owned: ContextReviewOwner | undefined;
    let stopped = false;
    queueMicrotask(() => {
      if (stopped) return;
      try {
        owned = client.createReviewOwner();
      } catch {
        setOwner(undefined);
        return;
      }
      setOwner(owned);
    });
    return () => {
      stopped = true;
      void owned?.dispose().catch(() => {});
    };
  }, [client]);
  useLayoutEffect(() => owner?.dismiss(), [terminalId, owner]);
  const state = useSyncExternalStore(owner?.subscribe ?? subscribe, owner?.getSnapshot ?? snapshot);
  return {
    preview: state.preview,
    busy: state.busy,
    error: state.error ? x(state.error) : '',
    dismiss: owner?.dismiss ?? (() => {}),
    prepare: owner?.prepare ?? noPrepare,
    send: owner?.send ?? noPrepare,
    sendDirect: owner?.sendDirect ?? noPrepare,
  };
}
