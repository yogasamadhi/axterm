import type { AiPanelActions } from './panel-actions.ts';
import {
  piModelsFileSchema,
  type PiCatalogProvider,
  type AiModel,
  type AiProvider,
} from '@axterm/plugin-api/ai';

type Client = AiPanelActions;
type Catalog = PiCatalogProvider[];

export async function importPiModels(
  client: Client,
  text: string,
  fallbackKey: string,
  catalog: Catalog,
): Promise<AiProvider[]> {
  if (text.length > 256 * 1024) throw new Error('Pi configuration exceeded limit');
  const config = piModelsFileSchema.parse(JSON.parse(text));
  // Validate every provider before creating any credential or persistent resource.
  const entries = Object.entries(config.providers).map(([id, value]) => {
    const builtin = catalog.find((provider) => provider.id === id);
    const baseUrl = value.baseUrl ?? builtin?.baseUrl;
    const models = value.models.length ? value.models : (builtin?.models ?? []);
    const key = value.apiKey ?? fallbackKey;
    if (!baseUrl || !models.length || !key || (!value.api && !builtin))
      throw new Error('Incomplete Pi provider');
    for (const model of models)
      if (!model.api && !value.api && !builtin?.models.some((entry) => entry.id === model.id))
        throw new Error('Pi model API is required');
    return { id, value, baseUrl, models, key };
  });
  const providers: AiProvider[] = [];
  const models: AiModel[] = [];
  const refs: string[] = [];
  let providerAttemptUncertain = false;
  try {
    for (const entry of entries) {
      const key = await client.createCredential({
        kind: 'aiApiKey',
        label: `${entry.id} API Key`,
        secret: entry.key,
      });
      refs.push(key.ref);
      const headerCredentialRefs: Record<string, string> = {};
      for (const [name, secret] of Object.entries(entry.value.headers ?? {})) {
        const header = await client.createCredential({
          kind: 'aiApiKey',
          label: `${entry.id} ${name}`,
          secret,
        });
        refs.push(header.ref);
        headerCredentialRefs[name] = header.ref;
      }
      const api = entry.value.api ?? entry.models[0]?.api;
      providerAttemptUncertain = true;
      const provider = await client.createAiProvider({
        name: entry.id,
        baseUrl: entry.baseUrl,
        credentialRef: key.ref,
        enabled: true,
        protocol:
          api === 'anthropic-messages'
            ? 'anthropic'
            : api === 'openai-responses'
              ? 'openai-responses'
              : 'openai-chat',
        pi: {
          id: entry.id,
          ...(entry.value.api ? { api: entry.value.api } : {}),
          models: entry.value.models,
          modelOverrides: entry.value.modelOverrides,
          headerCredentialRefs,
        },
      });
      providers.push(provider);
      providerAttemptUncertain = false;
      for (const model of entry.models)
        models.push(
          await client.createAiModel({
            providerId: provider.id,
            name: model.name ?? model.id,
            model: model.id,
            capabilities: ['chat', 'tools'],
          }),
        );
    }
    return providers;
  } catch (error) {
    // Preserve credentials when compensation fails, so a surviving provider is never broken.
    const cleanup = await Promise.allSettled(models.map((model) => client.deleteAiModel(model)));
    const removed = await Promise.allSettled(
      providers.map((provider) => client.deleteAiProvider(provider)),
    );
    if (
      !providerAttemptUncertain &&
      cleanup.every((item) => item.status === 'fulfilled') &&
      removed.every((item) => item.status === 'fulfilled')
    )
      await Promise.allSettled(refs.map((ref) => client.deleteCredential(ref)));
    throw error;
  }
}
