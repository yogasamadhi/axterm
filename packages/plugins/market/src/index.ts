import { Remote, RemoteError, TypertRemoteService } from '@axterm/plugin-api';
import type {} from '@axterm/plugin-api/host';
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import {
  marketFailureSchema,
  type MarketQuery,
  type MarketPage,
  type MarketUpdate,
  type MarketConfigurationReceipt,
} from '@axterm/plugin-api/market';
import { MarketApplication, MarketError, marketDomainForProfile } from './application.ts';
import { MarketObservation } from './observation.ts';
export const inject = ['storage', 'storageDomain', 'pluginManager', 'runtimeIdentity'];
export class MarketController extends TypertRemoteService {
  private readonly observations: MarketObservation;
  private closing?: Promise<void>;
  constructor(
    ctx: Context,
    private readonly app: MarketApplication,
  ) {
    super(ctx, 'marketController', { namespace: 'market' });
    this.observations = new MarketObservation(async () => app.snapshot());
    ctx.effect(() => () => this.close());
  }
  @Remote({ mode: 'stream' }) watchMarket(signal: AbortSignal): AsyncIterable<MarketUpdate> {
    return this.observations.watch(signal);
  }
  @Remote configureMarket(
    id: string,
    generation: string,
    revision: number,
    urls: readonly string[],
    signal: AbortSignal,
  ): Promise<MarketConfigurationReceipt> {
    return this.call(() => {
      signal.throwIfAborted();
      return this.app.configure(id, generation, revision, urls);
    });
  }
  @Remote getMarketConfigurationOutcome(
    id: string,
    signal: AbortSignal,
  ): Promise<MarketConfigurationReceipt | undefined> {
    return this.call(() => {
      signal.throwIfAborted();
      return this.app.outcome(id);
    });
  }
  @Remote searchMarket(query: MarketQuery, signal: AbortSignal): Promise<MarketPage> {
    return this.call(() => this.app.search(query, signal));
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      const results = await Promise.allSettled([this.observations.close(), this.app.close()]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })());
  }
  private async call<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      if (this.closing) throw new MarketError('closed');
      return await fn();
    } catch (error) {
      const parsed = marketFailureSchema.safeParse((error as { reason?: unknown } | null)?.reason);
      throw new RemoteError('market/failure', 'Market is unavailable', {
        reason: parsed.success
          ? parsed.data
          : error instanceof z.ZodError
            ? 'invalid-input'
            : 'unavailable',
      });
    }
  }
}
export async function apply(ctx: Context): Promise<void> {
  const profileName = ctx.runtimeIdentity.profileName;
  if (!profileName) throw new Error('PROFILE_IDENTITY_REQUIRED');
  const domain = await ctx.storage.domain.open(marketDomainForProfile(profileName));
  try {
    new MarketController(
      ctx,
      new MarketApplication(
        domain,
        ctx.runtimeIdentity.generation,
        ctx.runtimeIdentity.appVersion,
        () => ctx.pluginManager.list(),
      ),
    );
  } catch (error) {
    await domain.close();
    throw error;
  }
}
