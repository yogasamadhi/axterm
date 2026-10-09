import { useQueryClient } from '@tanstack/react-query';
import type { createRuntimeClient } from '@workspace/client';
import type { AiRun } from '@workspace/contracts';
import { useEffect, useState } from 'react';

/** Pi owns model streaming; this hook only presents the Runtime's public SSE events. */
export function useAiRunStream(client: ReturnType<typeof createRuntimeClient>, runId?: string) {
  const queryClient = useQueryClient();
  const [run, setRun] = useState<AiRun>();
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    void client
      .streamAiRun(
        runId,
        (event) => {
          if (controller.signal.aborted) return;
          if (event.type === 'snapshot' || event.type === 'state') {
            setRun('run' in event.data ? event.data.run : event.data);
            void queryClient.invalidateQueries({ queryKey: ['ai-tool-calls'] });
            void queryClient.invalidateQueries({ queryKey: ['ai-approvals'] });
          } else if (event.type === 'tool') {
            void queryClient.invalidateQueries({ queryKey: ['ai-tool-calls'] });
            void queryClient.invalidateQueries({ queryKey: ['ai-approvals'] });
          } else if (event.type === 'delta')
            setRun((current) => {
              if (current?.id !== runId) return current;
              const result = ((current.result ?? '') + event.data.text).slice(0, 2 * 1024 * 1024);
              return { ...current, result };
            });
        },
        controller.signal,
      )
      .catch(() => undefined)
      .finally(() => {
        if (controller.signal.aborted) return;
        void queryClient.invalidateQueries({ queryKey: ['ai-runs'] });
        void queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
        void queryClient.invalidateQueries({ queryKey: ['ai-conversation'] });
      });
    return () => controller.abort();
  }, [client, queryClient, runId]);
  return run?.id === runId ? run : undefined;
}
