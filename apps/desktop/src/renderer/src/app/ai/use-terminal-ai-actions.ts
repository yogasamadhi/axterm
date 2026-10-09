import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { createRuntimeClient } from '@workspace/client';
import type { AiModel } from '@workspace/contracts';
import { useI18n } from '../../i18n/context';
import { LocalShellError } from '../shell-error';
import { buildTerminalExplainRequest } from '../terminal-ai-context';
import { waitForAiResult } from './wait-for-ai-result';

type Client = ReturnType<typeof createRuntimeClient>;
export interface TerminalAiDraft {
  nonce: string;
  prompt: string;
  modelId: string;
  terminalId: string;
}

export function useTerminalAiActions(
  client: Client,
  models: AiModel[] | undefined,
  onOpen: (draft: TerminalAiDraft) => void,
) {
  const { x } = useI18n();
  const xRef = useRef(x);
  const selectionRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => selectionRequest.current?.abort(), []);
  useLayoutEffect(() => {
    xRef.current = x;
  }, [x]);
  const requestAiCommandSuggestions = useCallback(
    async (prefix: string, terminalId: string, signal: AbortSignal): Promise<string> => {
      const model = models?.[0];
      if (!model) throw new LocalShellError(xRef.current('terminal.configureAiFirst'));
      if (signal.aborted) throw new DOMException('AI suggestion canceled', 'AbortError');
      const run = await client.startAi({
        modelId: model.id,
        useCase: 'generateCommand',
        prompt:
          'Return at most five shell commands that begin with the exact user prefix. ' +
          `Return only a JSON string array. User prefix: ${JSON.stringify(prefix)}`,
        context: '',
        terminalId,
      });
      return await waitForAiResult(client, run, signal, {
        timeout: xRef.current('app.aiSuggestionsTimeout'),
        failed: xRef.current('app.aiSuggestionsFailed', { detail: '' }),
      });
    },
    [models, client],
  );

  const explainTerminalSelection = useCallback(
    async (selection: string, terminalId: string) => {
      const model = models?.[0];
      if (!model) throw new LocalShellError(xRef.current('terminal.configureAiFirst'));
      const prepared = buildTerminalExplainRequest(
        selection,
        xRef.current('app.explainTerminalPrompt'),
      );
      selectionRequest.current?.abort();
      const controller = new AbortController();
      selectionRequest.current = controller;
      try {
        const preview = await client.previewAiContext(
          {
            modelId: model.id,
            useCase: 'explainOutput',
            prompt: prepared.prompt,
            context: '',
            includeConversationHistory: false,
            terminalId,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        onOpen({
          nonce: crypto.randomUUID(),
          prompt: preview.prompt,
          modelId: model.id,
          terminalId,
        });
      } finally {
        if (selectionRequest.current === controller) selectionRequest.current = undefined;
      }
    },
    [models, client, onOpen],
  );

  return { requestAiCommandSuggestions, explainTerminalSelection };
}
