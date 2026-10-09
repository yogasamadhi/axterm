import { aiProviderSchema, type AiProviderProtocol } from '../../packages/contracts/src';

export function piTestProvider(baseUrl: string, protocol: AiProviderProtocol = 'openai-chat') {
  return aiProviderSchema.parse({
    id: '787a6b2f-ac4b-4aba-93f1-34ff5c96ea4c',
    name: 'Fixture',
    version: 1,
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
    baseUrl,
    protocol,
    auth: protocol === 'anthropic' ? 'x-api-key' : 'bearer',
    apiPath:
      protocol === 'anthropic'
        ? '/messages'
        : protocol === 'openai-responses'
          ? '/responses'
          : '/chat/completions',
    credentialRef: 'vault-ref',
    enabled: true,
    timeoutMs: 1000,
  });
}

const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const anthropic = (value: { type: string } & Record<string, unknown>) =>
  `event: ${value.type}\n${data(value)}`;

export function piSseCommand(
  command: string,
  extra: Record<string, unknown> = {},
  finishReason = 'tool_calls',
) {
  return (
    data({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_workspace',
                type: 'function',
                function: {
                  name: 'workspace_exec',
                  arguments: JSON.stringify({ command, ...extra }),
                },
              },
            ],
          },
        },
      ],
    }) +
    data({ choices: [{ delta: {}, finish_reason: finishReason }] }) +
    'data: [DONE]\n\n'
  );
}

export function piSseFragmentedCommand(protocol: AiProviderProtocol, command: string) {
  const args = JSON.stringify({ command });
  const fragments = [args.slice(0, 8), args.slice(8)];
  if (protocol === 'anthropic')
    return (
      anthropic({ type: 'content_block_stop', index: 0 }) +
      anthropic({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tool_fixture', name: 'workspace_exec', input: {} },
      }) +
      fragments
        .map((partial_json) =>
          anthropic({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json },
          }),
        )
        .join('') +
      anthropic({ type: 'content_block_stop', index: 1 }) +
      anthropic({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 2 },
      }) +
      anthropic({ type: 'message_stop' })
    );
  if (protocol === 'openai-responses') {
    const item = {
      id: 'fc_fixture',
      type: 'function_call',
      call_id: 'call_fixture',
      name: 'workspace_exec',
      arguments: args,
    };
    return (
      data({
        type: 'response.output_item.added',
        output_index: 1,
        item: { ...item, arguments: '' },
      }) +
      fragments
        .map((delta) =>
          data({
            type: 'response.function_call_arguments.delta',
            output_index: 1,
            item_id: item.id,
            delta,
          }),
        )
        .join('') +
      data({ type: 'response.output_item.done', output_index: 1, item }) +
      piSseEnd(protocol)
    );
  }
  return (
    fragments
      .map((arguments_, index) =>
        data({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    ...(index === 0 ? { id: 'call_fixture', type: 'function' } : {}),
                    function: {
                      ...(index === 0 ? { name: 'workspace_exec' } : {}),
                      arguments: arguments_,
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .join('') +
    data({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }) +
    'data: [DONE]\n\n'
  );
}

export function piSseStart(protocol: AiProviderProtocol): string {
  if (protocol === 'anthropic')
    return (
      anthropic({
        type: 'message_start',
        message: {
          id: 'msg_fixture',
          model: 'fixture-model',
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      }) +
      anthropic({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })
    );
  if (protocol === 'openai-responses')
    return (
      data({ type: 'response.created', response: { id: 'resp_fixture' } }) +
      data({
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'item_fixture', type: 'message', role: 'assistant', content: [] },
      })
    );
  return '';
}
export function piSseText(protocol: AiProviderProtocol, text: string): string {
  if (protocol === 'anthropic')
    return anthropic({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    });
  if (protocol === 'openai-responses')
    return data({
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      item_id: 'item_fixture',
      delta: text,
    });
  return data({ choices: [{ delta: { content: text } }] });
}
export function piSseEnd(protocol: AiProviderProtocol): string {
  if (protocol === 'anthropic')
    return (
      anthropic({ type: 'content_block_stop', index: 0 }) +
      anthropic({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      }) +
      anthropic({ type: 'message_stop' })
    );
  if (protocol === 'openai-responses')
    return data({
      type: 'response.completed',
      response: {
        id: 'resp_fixture',
        status: 'completed',
        output: [],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    });
  return (
    data({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }) + 'data: [DONE]\n\n'
  );
}
export function piSseHidden(protocol: AiProviderProtocol): string {
  const text = 'HIDDEN_REASONING_CANARY';
  if (protocol === 'anthropic')
    return (
      anthropic({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'thinking', thinking: '' },
      }) +
      anthropic({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: text },
      }) +
      anthropic({ type: 'content_block_stop', index: 1 })
    );
  if (protocol === 'openai-responses')
    return (
      data({
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'reason_fixture', type: 'reasoning', summary: [] },
      }) + data({ type: 'response.reasoning_summary_text.delta', output_index: 1, delta: text })
    );
  return data({ choices: [{ delta: { reasoning_content: text } }] });
}
