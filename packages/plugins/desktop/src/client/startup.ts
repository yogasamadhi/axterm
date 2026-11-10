import type { Context } from '@deepseek-ai/cordis';
/** One non-secret claim, resolved through its original identity after an uncertain response. */
export class DesktopStartup {
  private readonly lifetime = new AbortController();
  private readonly key = crypto.randomUUID();
  private pending: Promise<'configured' | 'native' | 'claimed'> | undefined;
  private generation: string | undefined;
  constructor(
    private readonly ctx: Context,
    private readonly windowId: string,
  ) {}
  claim(generation: string, signal: AbortSignal): Promise<'configured' | 'native' | 'claimed'> {
    if (this.lifetime.signal.aborted) return Promise.reject(Error('DESKTOP_STARTUP_CLOSED'));
    if (this.generation && this.generation !== generation)
      return Promise.reject(Error('DESKTOP_STARTUP_RETIRED'));
    this.generation = generation;
    return (this.pending ??= this.run(generation, AbortSignal.any([this.lifetime.signal, signal])));
  }
  private async run(
    generation: string,
    signal: AbortSignal,
  ): Promise<'configured' | 'native' | 'claimed'> {
    const deadline = performance.now() + 10000;
    let attempted = false;
    while (performance.now() < deadline) {
      signal.throwIfAborted();
      const result = await this.ctx.remote.desktop.getConfiguredStartup(
        this.windowId,
        this.key,
        generation,
      );
      signal.throwIfAborted();
      if (!result.ok) throw result.error;
      if (result.value.generation !== generation) throw Error('DESKTOP_STARTUP_RETIRED');
      const phase = result.value.phase;
      if (phase === 'configured' || phase === 'native' || phase === 'claimed') return phase;
      if (phase === 'ready') {
        if (attempted) throw Error('DESKTOP_STARTUP_OUTCOME_UNKNOWN');
        attempted = true;
        try {
          const claim = await this.ctx.remote.desktop.claimConfiguredStartup(
            this.windowId,
            this.key,
            generation,
          );
          signal.throwIfAborted();
          if (!claim.ok) throw claim.error;
          if (
            claim.value.phase === 'configured' ||
            claim.value.phase === 'native' ||
            claim.value.phase === 'claimed'
          )
            return claim.value.phase;
        } catch {
          signal.throwIfAborted();
        }
      }
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(Error('DESKTOP_STARTUP_CANCELED'));
        };
        const timer = setTimeout(done, 50);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    throw Error('DESKTOP_STARTUP_UNAVAILABLE');
  }
  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([this.pending]);
  }
}
