import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { remoteProfile, remoteValue } from './level3-remote-profile.ts';
import * as Ai from '../../packages/plugins/ai/src/client/index.ts';
import type { AiProviderProtocol, AiModelInput } from '@axterm/plugin-api/ai';
/** Actual default application Profile, authenticated models and application-local Vault. */
export async function aiRemoteProfile(home: string) {
  const profile = await remoteProfile(home, { application: true });
  try {
    await profile.client.plugin(Ai);
    await vi.waitFor(() => {
      if (profile.client.aiModel.getSnapshot().status !== 'ready')
        throw Error('AI baseline unavailable');
    });
    const model = profile.client.aiModel;
    return {
      ...profile,
      model,
      async selection(
        baseUrl: string,
        protocol: AiProviderProtocol = 'openai-chat',
        secret = 'APPLICATION_REMOTE_AI_CANARY',
        role = 'Terminal expert',
        capabilities: AiModelInput['capabilities'] = ['chat'],
      ) {
        const state = model.getSnapshot();
        if (state.status !== 'ready') throw Error('AI baseline unavailable');
        const credential = await remoteValue(
          profile.client.remote.configuration.createCredential(
            randomUUID(),
            state.baseline.generation,
            { kind: 'aiApiKey', label: 'Retained AI fixture', secret },
          ),
        );
        if (credential.status !== 'completed') throw Error('Credential outcome unavailable');
        const provider = await model.createProvider(randomUUID(), {
          engineId: 'pi',
          name: 'Retained provider',
          baseUrl,
          protocol,
          apiPath:
            protocol === 'openai-responses'
              ? '/responses'
              : protocol === 'anthropic'
                ? '/messages'
                : '/chat/completions',
          auth: protocol === 'anthropic' ? 'x-api-key' : 'bearer',
          credentialRef: credential.ref,
          role,
          proxy: null,
          timeoutMs: 10_000,
          enabled: true,
        });
        const selected = await model.createModel(randomUUID(), {
          providerId: provider.ids[0]!,
          name: 'Fixture',
          model: 'fixture-model',
          capabilities,
        });
        return { provider: await model.readProvider(provider.ids[0]!), modelId: selected.ids[0]! };
      },
    };
  } catch (error) {
    await profile.close();
    throw error;
  }
}
