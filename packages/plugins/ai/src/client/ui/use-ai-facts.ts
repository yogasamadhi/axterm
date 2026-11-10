import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AiBaseline, AiRun } from '@axterm/plugin-api/ai';
import type { AiModel, AiState, AiRunModel } from '../index.ts';
import type { AiRunState } from '../run-model.ts';
function facts<K extends keyof AiBaseline>(model: AiModel, state: AiState, name: K) {
  const refetch = async () => {
    // Healthy facts already follow the canonical incremental stream. Only a failed observation needs reopening.
    if (model.getSnapshot().status === 'error') await model.retry();
    const current = model.getSnapshot();
    return { data: current.status === 'ready' ? current.baseline[name] : undefined };
  };
  return state.status === 'ready'
    ? {
        data: state.baseline[name],
        isSuccess: true as const,
        isPending: false,
        isError: false,
        refetch,
      }
    : {
        data: undefined,
        isSuccess: false as const,
        isPending: state.status === 'connecting',
        isError: state.status === 'error',
        refetch,
      };
}
export function useAiFacts(model: AiModel) {
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  return {
    providers: facts(model, state, 'providers'),
    models: facts(model, state, 'models'),
    runs: facts(model, state, 'runs'),
    conversations: facts(model, state, 'conversations'),
    approvals: facts(model, state, 'approvals'),
    engines: facts(model, state, 'engines'),
  };
}
interface SelectedRunReader {
  id: string;
  generation: string;
  reader: AiRunModel;
  active: boolean;
}
const noSubscribe = () => () => {};
const noSnapshot = () => undefined;
/** The hook owns only a reader identity and retry UI; visible bytes stay in AiRunModel. */
export function useSelectedRun(model: AiModel, id?: string) {
  const metadata = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const generation = metadata.status === 'ready' ? metadata.baseline.generation : undefined;
  const [selection, setSelection] = useState<SelectedRunReader>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stopped = false;
    let reader: AiRunModel | undefined;
    let identity: SelectedRunReader | undefined;
    void Promise.resolve()
      .then(() => {
        if (stopped) return;
        setFailed(false);
        if (!id || !generation) return;
        return model.openRun(id).then(async (value) => {
          reader = value;
          identity = { id, generation, reader: value, active: !stopped };
          if (stopped) await value.dispose();
          else setSelection(identity);
        });
      })
      .catch(() => {
        if (!stopped) setFailed(true);
      });
    return () => {
      stopped = true;
      if (identity) identity.active = false;
      void reader?.dispose().catch(() => {});
    };
  }, [model, id, generation, attempt]);
  const reader =
    selection &&
    selection.active &&
    selection.id === id &&
    selection.generation === generation &&
    generation
      ? selection.reader
      : undefined;
  const state = useSyncExternalStore<AiRunState | undefined>(
    reader?.subscribe ?? noSubscribe,
    reader?.getSnapshot ?? noSnapshot,
  );
  const value: AiRun | undefined = state
    ? { ...state.visible.run, result: state.visible.output }
    : undefined;
  return {
    value,
    tools: state?.visible.tools ?? [],
    approvals: state?.visible.approvals ?? [],
    unavailable: failed || state?.status === 'error',
    retry: () => setAttempt((current) => current + 1),
  };
}
