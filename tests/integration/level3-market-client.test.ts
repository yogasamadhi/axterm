import type { Context } from '@deepseek-ai/cordis';
import { expect, it, vi } from 'vitest';
import type { RemoteResult } from '@axterm/plugin-api';
import type { MarketUpdate, MarketConfigurationReceipt } from '@axterm/plugin-api/market';
import {
  RemoteStream,
  type RemoteStreamOptions,
} from '../../packages/infra/gateway/src/client/remote-stream.ts';
import { MarketModel } from '../../packages/plugins/market/src/client/model.ts';
function fixture() {
  let generation = 'generation';
  const configure = vi.fn(
    async (
      id: string,
      gen: string,
      _revision: number,
      _urls: readonly string[],
      _signal: AbortSignal,
    ): Promise<RemoteResult<MarketConfigurationReceipt>> => ({
      ok: true,
      value: { id, generation: gen, revision: 1 },
    }),
  );
  const outcome = vi.fn(
    async (
      _id: string,
      _signal: AbortSignal,
    ): Promise<RemoteResult<MarketConfigurationReceipt | undefined>> => ({
      ok: true,
      value: undefined,
    }),
  );
  const watch = vi.fn(async function* (signal: AbortSignal) {
    yield {
      type: 'baseline',
      cursor: 0,
      snapshot: { generation, revision: 0, indexes: [] },
    } as MarketUpdate;
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
      if (signal.aborted) resolve();
    });
  });
  const model = new MarketModel({
    remote: {
      $stream: (options: RemoteStreamOptions<MarketUpdate>) =>
        new RemoteStream(
          { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } },
          options,
        ),
      market: {
        watchMarket: watch,
        configureMarket: configure,
        getMarketConfigurationOutcome: outcome,
      },
    },
  } as unknown as Context);
  return {
    model,
    configure,
    outcome,
    changeGeneration: () => {
      generation = 'replacement';
    },
  };
}
it('reconciles a lost configuration ACK with a readonly lookup and replaces reconnect baselines', async () => {
  const f = fixture();
  try {
    await expect.poll(() => f.model.getSnapshot().status).toBe('ready');
    let receipt: MarketConfigurationReceipt;
    f.configure.mockImplementation(async (id, generation) => {
      receipt = { id, generation, revision: 1 };
      throw new Error('Lost ACK');
    });
    f.outcome.mockImplementation(async () => ({ ok: true, value: receipt! }));
    await f.model.configure(['http://127.0.0.1:32101/index.json']);
    expect(f.configure).toHaveBeenCalledTimes(1);
    expect(f.outcome).toHaveBeenCalledTimes(1);
    f.changeGeneration();
    await f.model.retry();
    await expect
      .poll(() => f.model.getSnapshot())
      .toMatchObject({ status: 'ready', baseline: { generation: 'replacement', revision: 0 } });
  } finally {
    await f.model.close();
  }
});
it('retains unknown command identity for an explicit identical retry and refuses changed input', async () => {
  const f = fixture();
  try {
    await expect.poll(() => f.model.getSnapshot().status).toBe('ready');
    f.configure.mockRejectedValue(new Error('Lost request'));
    await expect(f.model.configure(['http://127.0.0.1:32101/index.json'])).rejects.toThrow(
      'MARKET_RESULT_UNKNOWN',
    );
    await expect(f.model.configure([])).rejects.toThrow('MARKET_PENDING_CONFIGURATION');
    await expect(f.model.configure(['http://127.0.0.1:32101/index.json'])).rejects.toThrow();
    expect(f.configure).toHaveBeenCalledTimes(2);
    expect(f.configure.mock.calls[0]?.[0]).toBe(f.configure.mock.calls[1]?.[0]);
  } finally {
    await f.model.close();
  }
});
