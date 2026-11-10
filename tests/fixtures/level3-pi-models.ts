import { Context } from '@deepseek-ai/cordis';
import { aiProviderSchema, type AiProvider } from '@axterm/plugin-api/ai';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import type { ConnectionsApplication } from '@axterm/plugin-api/host';
import Engines from '../../packages/infra/engines/src/index.ts';
import { PiEngineProvider, piEngineConfigSchema } from '../../packages/engines/pi/src/index.ts';
import { AiModels } from '../../packages/plugins/ai/src/adapters/models.ts';
import { piMetadata } from '../../packages/plugins/ai/src/adapters/pi-metadata.ts';
import { ProxyService } from '../../packages/plugins/connections/src/application/proxy-service.ts';
import { TargetStreams } from '../../packages/plugins/connections/src/adapters/target-streams.ts';
import { TcpProxyConnector } from '../../packages/plugins/connections/src/adapters/proxy/tcp-proxy-connector.ts';
import type {
  ModelRequest,
  ModelEvent,
} from '../../packages/plugins/ai/src/ports/model-provider.ts';
import { MemoryCredentials } from '../support/level3-memory-credentials.ts';
export const piCatalog = piMetadata.catalog;
/** Test composition only: real application models, registry and pinned Provider own all execution. */
export class OwnedPiModelsFixture {
  private readonly provider: AiProvider;
  private readonly secrets: Record<string, string>;
  constructor(
    provider: AiProvider,
    apiKey: string,
    proxy: { url: string; username?: string; password?: string } | null,
    headers: Record<string, string> = {},
    private readonly testModel?: string,
  ) {
    const input = structuredClone(provider);
    const secrets: Record<string, string> = {};
    if (!input.credentialRef) throw Error('Fixture credential reference required');
    secrets[encodeOpaqueCredentialRef(input.credentialRef)] = apiKey;
    for (const [name, value] of Object.entries(headers)) {
      if (!input.pi) throw Error('Fixture headers require explicit Pi metadata');
      const ref =
        input.pi.headerCredentialRefs[name] ?? 'fixture-header-' + Object.keys(secrets).length;
      input.pi.headerCredentialRefs[name] = ref;
      secrets[encodeOpaqueCredentialRef(ref)] = value;
    }
    if (proxy) {
      input.proxy = {
        url: proxy.url,
        username: proxy.username ?? null,
        credentialRef: proxy.password ? 'fixture-proxy' : null,
      };
      if (proxy.password) secrets[encodeOpaqueCredentialRef('fixture-proxy')] = proxy.password;
    }
    this.provider = aiProviderSchema.parse(input);
    this.secrets = secrets;
  }
  private async open() {
    const ctx = new Context();
    let streams: TargetStreams | undefined;
    let models: AiModels | undefined;
    const close = async () => {
      try {
        await models?.close();
      } finally {
        try {
          await ctx.fiber.dispose();
        } finally {
          await streams?.close();
        }
      }
    };
    try {
      await ctx.plugin(MemoryCredentials, this.secrets);
      if (this.provider.proxy) {
        const proxy = new ProxyService({} as never, new TcpProxyConnector(), {
          resolveCredential: async (ref) => {
            const value = await ctx.credentials.resolve(encodeOpaqueCredentialRef(ref));
            if (!value) throw Error('Missing fixture credential');
            return value.value;
          },
          readGrantedText: async () => {
            throw Error('Unused fixture capability');
          },
          revokeGrant: async () => {},
        });
        streams = new TargetStreams({} as never, proxy);
        const owner = streams;
        ctx.provide('connections', {
          openStream: (input, signal) => owner.open(input, signal),
        } as ConnectionsApplication);
      }
      await ctx.plugin(Engines);
      ctx.engines.register('pi', new PiEngineProvider(ctx, piEngineConfigSchema.parse({})));
      models = new AiModels(ctx);
      return { model: await models.create(this.provider, this.testModel), close };
    } catch (error) {
      await close();
      throw error;
    }
  }
  async *stream(input: ModelRequest): AsyncGenerator<ModelEvent> {
    const fixture = await this.open();
    try {
      yield* fixture.model.stream(input);
    } finally {
      await fixture.close();
    }
  }
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const fixture = await this.open();
    try {
      return await fixture.model.listModels(signal);
    } finally {
      await fixture.close();
    }
  }
}
