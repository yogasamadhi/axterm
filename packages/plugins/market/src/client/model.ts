import type { Context } from '@deepseek-ai/cordis';
import type {} from '@axterm/plugin-market/remote';
import { RemoteSnapshotStream } from '@axterm/infra-gateway/client';
import {
  marketUrlsSchema,
  type MarketBaseline,
  type MarketPage,
  type MarketUpdate,
  type MarketQuery,
} from '@axterm/plugin-api/market';
export type MarketState =
  | { readonly status: 'connecting' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly baseline: MarketBaseline; readonly page?: MarketPage };
export class MarketModel {
  private state: MarketState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private readonly tasks = new Set<Promise<unknown>>();
  private stream: RemoteSnapshotStream<MarketUpdate, MarketUpdate>;
  private cursor = -1;
  private closing?: Promise<void>;
  private retrying: Promise<void> | undefined;
  private searchController?: AbortController;
  private pending: { id: string; generation: string; revision: number; urls: string[] } | undefined;
  private configuring = false;
  private query?: MarketQuery;
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
    this.stream.start();
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    if (this.closing) throw new Error('MARKET_CLOSED');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: MarketState) {
    if (this.closing) return;
    this.state = value;
    for (const listener of this.listeners) listener();
  }
  private open() {
    return new RemoteSnapshotStream(
      this.ctx.remote.$stream({
        name: 'market.facts',
        open: (signal) => this.ctx.remote.market.watchMarket(signal),
        ended: () => new Error('MARKET_ENDED'),
      }),
      {
        name: 'market.facts',
        isSnapshot: (value): value is MarketUpdate => value.type === 'baseline',
        replace: (value) => this.accept(value, true),
        update: (value) => this.accept(value, false),
        failed: () => this.publish({ status: 'error' }),
      },
    );
  }
  private accept(value: MarketUpdate, replacing: boolean) {
    if (
      !Number.isSafeInteger(value.cursor) ||
      value.cursor < 0 ||
      (!replacing &&
        (this.state.status !== 'ready' ||
          value.snapshot.generation !== this.state.baseline.generation ||
          value.cursor !== this.cursor + 1))
    )
      throw new Error('MARKET_INVALID_BASELINE');
    this.cursor = value.cursor;
    const previous = this.state;
    this.publish({
      status: 'ready',
      baseline: value.snapshot,
      ...(!replacing &&
      previous.status === 'ready' &&
      previous.page &&
      previous.baseline.revision === value.snapshot.revision &&
      value.snapshot.indexes.some(
        (index) => index.url === previous.page!.url && index.fetchedAt === previous.page!.fetchedAt,
      )
        ? { page: previous.page }
        : {}),
    });
  }
  private own<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }
  configure(input: readonly string[]): Promise<void> {
    if (this.closing || this.configuring || this.state.status !== 'ready')
      return Promise.reject(new Error('MARKET_UNAVAILABLE'));
    let urls: string[];
    try {
      urls = marketUrlsSchema.parse(input);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.pending && JSON.stringify(this.pending.urls) !== JSON.stringify(urls))
      return Promise.reject(new Error('MARKET_PENDING_CONFIGURATION'));
    this.configuring = true;
    const request = (this.pending ??= {
      id: crypto.randomUUID(),
      generation: this.state.baseline.generation,
      revision: this.state.baseline.revision,
      urls,
    });
    return this.own(
      (async () => {
        const result = await this.ctx.remote.market
          .configureMarket(
            request.id,
            request.generation,
            request.revision,
            request.urls,
            this.lifetime.signal,
          )
          .catch(() => undefined);
        if (result?.ok) {
          if (result.value.id !== request.id || result.value.generation !== request.generation)
            throw new Error('MARKET_RECEIPT_MISMATCH');
          this.pending = undefined;
          return;
        }
        if (result && !result.ok) {
          this.pending = undefined;
          throw result.error;
        }
        const outcome = await this.ctx.remote.market.getMarketConfigurationOutcome(
          request.id,
          this.lifetime.signal,
        );
        if (
          outcome.ok &&
          outcome.value?.id === request.id &&
          outcome.value.generation === request.generation
        ) {
          this.pending = undefined;
          return;
        }
        throw new Error('MARKET_RESULT_UNKNOWN');
      })().finally(() => {
        this.configuring = false;
      }),
    );
  }
  search(query: MarketQuery): Promise<void> {
    if (this.closing || this.state.status !== 'ready')
      return Promise.reject(new Error('MARKET_UNAVAILABLE'));
    this.searchController?.abort();
    const controller = new AbortController();
    this.searchController = controller;
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal]),
      generation = this.state.baseline.generation,
      revision = this.state.baseline.revision;
    return this.own(
      (async () => {
        const result = await this.ctx.remote.market.searchMarket(query, signal);
        signal.throwIfAborted();
        if (!result.ok) throw result.error;
        if (
          this.state.status === 'ready' &&
          this.state.baseline.generation === generation &&
          this.state.baseline.revision === revision
        ) {
          this.query = { ...query };
          this.publish({ ...this.state, page: result.value });
        }
      })(),
    );
  }
  next(): Promise<void> {
    if (
      this.state.status !== 'ready' ||
      !this.state.page ||
      this.state.page.nextOffset === null ||
      !this.query
    )
      return Promise.reject(new Error('MARKET_NO_PAGE'));
    return this.search({
      ...this.query,
      offset: this.state.page.nextOffset,
      fetchedAt: this.state.page.fetchedAt,
      refresh: false,
    });
  }
  retry(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('MARKET_CLOSED'));
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      if (!this.closing) {
        this.stream = this.open();
        this.stream.start();
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await this.stream.dispose();
      await Promise.allSettled([...this.tasks]);
      await this.retrying;
      this.listeners.clear();
    })());
  }
}
