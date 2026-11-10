import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/plugin-api/host';
import type { ConnectionsApplication } from '@axterm/plugin-api/host';
import type { AiProvider } from '@axterm/plugin-api/ai';
import { encodeOpaqueCredentialRef } from '@axterm/plugin-api/credentials';
import { discoverLegacyModels } from '@axterm/engine-pi/discovery';
import { EngineError } from '@axterm/engine-api';
/** Only the private metadata GET operation is imported, never a Pi Provider or Agent API. */
export async function discoverOwnedModels(
  ctx: Context,
  provider: AiProvider,
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted();
  const credentialRef = provider.credentialRef;
  const baseUrl = provider.baseUrl;
  if (provider.engineId !== 'pi' || !credentialRef || !baseUrl)
    throw new EngineError('unsupported');
  const credential = await ctx.credentials.resolve(encodeOpaqueCredentialRef(credentialRef));
  signal.throwIfAborted();
  if (!credential) throw new EngineError('missing');
  const connections: ConnectionsApplication | undefined = ctx.reflect.get('connections');
  return discoverLegacyModels(
    { ...provider, baseUrl, credentialRef },
    credential.value,
    signal,
    connections,
  );
}
