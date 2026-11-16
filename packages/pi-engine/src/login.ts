// Provider-owned login and refresh; only the desktop interaction and Vault are injected.
import { builtinModels } from '../../../vendor/pi/packages/ai/src/providers/all.ts';
import { registerBundledOAuthFlowLoaders } from '../../../vendor/pi/packages/ai/src/auth/oauth/load.ts';
import { anthropicOAuth } from '../../../vendor/pi/packages/ai/src/auth/oauth/anthropic.ts';
import { openaiCodexOAuth } from '../../../vendor/pi/packages/ai/src/auth/oauth/openai-codex.ts';
import { openaiChatGPTOAuth } from '../../../vendor/pi/packages/ai/src/auth/oauth/openai-chatgpt.ts';
import { githubCopilotOAuth } from '../../../vendor/pi/packages/ai/src/auth/oauth/github-copilot.ts';
import { openRouterOAuth } from '../../../vendor/pi/packages/ai/src/auth/oauth/openrouter.ts';
import { kimiCodingOAuth } from '../../../vendor/pi/packages/ai/src/auth/oauth/kimi-coding.ts';
import { metaOAuth } from '../../../vendor/pi/packages/ai/src/auth/oauth/meta.ts';
import { xaiOAuth } from '../../../vendor/pi/packages/ai/src/auth/oauth/xai.ts';
import { createRadiusOAuth } from '../../../vendor/pi/packages/ai/src/auth/oauth/radius.ts';
import type { PiCredentialStore, PiLoginInteraction, PiModelConfig } from './public.ts';

// Pi's default variable imports cannot survive a source-free single-file bundle.
registerBundledOAuthFlowLoaders({
  anthropic: () => anthropicOAuth,
  openaiCodex: () => openaiCodexOAuth,
  openaiChatGPT: () => openaiChatGPTOAuth,
  githubCopilot: () => githubCopilotOAuth,
  openrouter: () => openRouterOAuth,
  kimiCoding: () => kimiCodingOAuth,
  meta: () => metaOAuth,
  xai: () => xaiOAuth,
  radius: createRadiusOAuth,
});

export async function loginPiProvider(
  provider: string,
  method: 'api_key' | 'oauth',
  store: PiCredentialStore,
  interaction: PiLoginInteraction,
): Promise<PiModelConfig[]> {
  const models = builtinModels({ credentials: store });
  await models.login(provider, method, interaction, { agentName: 'Axterm' });
  interaction.signal.throwIfAborted();
  const refreshed = await models.refresh({
    providers: [provider],
    allowNetwork: true,
    signal: interaction.signal,
  });
  if (refreshed.aborted) interaction.signal.throwIfAborted();
  const available = await models.getAvailable(provider, { signal: interaction.signal });
  if (!available.length) throw new Error('Pi provider has no available chat models');
  return available
    .filter((model) => model.provider === provider)
    .slice(0, 500)
    .map(({ id, name, api, baseUrl, reasoning, input, contextWindow, maxTokens }) => ({
      id,
      name,
      api: api as PiModelConfig['api'],
      ...(baseUrl ? { baseUrl } : {}),
      reasoning,
      input: input.filter((type): type is 'text' | 'image' => type === 'text' || type === 'image'),
      contextWindow,
      maxTokens,
    }));
}
