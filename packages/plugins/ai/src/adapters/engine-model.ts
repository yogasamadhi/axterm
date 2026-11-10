// ADR-072: all Agent execution goes through the selected Engine service.
import { randomUUID } from 'node:crypto';
import {
  EngineError,
  engineRunInputSchema,
  type EngineEvent,
  type EngineExecutionOptions,
  type EngineRunOutcome,
  type EngineSessionHandle,
} from '@axterm/engine-api';
import type { EnginesService } from '@axterm/engine-api/host';
import type { ModelProvider, ModelRequest, ModelEvent } from '../ports/model-provider.ts';
/** One rendezvous slot. The Engine acknowledges an event only after its application consumer advances. */
export class EngineModelProvider implements ModelProvider {
  private readonly options: EngineExecutionOptions | undefined;
  private readonly lifetime = new AbortController();
  private readonly openings = new Set<Promise<EngineSessionHandle>>();
  private readonly sessions = new Set<EngineSessionHandle>();
  private failedDrain = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly engines: EnginesService,
    private readonly engineId: string,
    private readonly providerId: string,
    options?: EngineExecutionOptions,
  ) {
    // Application construction captures the chosen binding before asynchronous allocation.
    // Registry admission still performs the authoritative bounded JSON validation/freezing.
    try {
      this.options = options === undefined ? undefined : structuredClone(options);
    } catch {
      throw new EngineError('invalid');
    }
  }
  resourceCount(): number {
    return this.openings.size + this.sessions.size + (this.failedDrain ? 1 : 0);
  }
  close(): Promise<void> {
    this.lifetime.abort();
    return (this.closing ??= (async () => {
      const opened = await Promise.allSettled([...this.openings]);
      const sessions = new Set([
        ...this.sessions,
        ...opened.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
      ]);
      const results = await Promise.allSettled(
        [...sessions].map(async (session) => {
          await session.close();
          this.sessions.delete(session);
        }),
      );
      if (
        this.failedDrain ||
        results.some((result) => result.status === 'rejected') ||
        opened.some(
          (result) =>
            result.status === 'rejected' &&
            result.reason instanceof EngineError &&
            result.reason.code === 'drain-failed',
        )
      ) {
        this.failedDrain = true;
        throw new EngineError('drain-failed');
      }
    })());
  }
  async *stream(input: ModelRequest): AsyncGenerator<ModelEvent> {
    if (this.lifetime.signal.aborted) throw new EngineError('closed');
    if (this.resourceCount() >= 64) throw new EngineError('capacity');
    input = { ...input, signal: AbortSignal.any([input.signal, this.lifetime.signal]) };
    if (input.signal.aborted) throw new EngineError('cancelled');
    const descriptor = this.engines.list().find((item) => item.id === this.engineId);
    if (!descriptor) throw new EngineError('missing');
    if (descriptor.state !== 'ready') throw new EngineError('closed');
    if (
      !descriptor.capabilities.cancellation ||
      ((!!input.executeCommand || !!input.executePluginManagement) &&
        !descriptor.capabilities.tools)
    )
      throw new EngineError('unsupported');
    const executionId = randomUUID();
    const opening = this.engines.openSession(
      this.engineId,
      { sessionId: executionId },
      input.signal,
    );
    this.openings.add(opening);
    let session: EngineSessionHandle;
    try {
      session = await opening;
    } catch (error) {
      if (error instanceof EngineError && error.code === 'drain-failed') this.failedDrain = true;
      throw error;
    } finally {
      this.openings.delete(opening);
    }
    this.sessions.add(session);
    let pending: { event: EngineEvent; accept(): void; reject(error: unknown): void } | undefined;
    let inflight: typeof pending;
    let wake: (() => void) | undefined;
    let ended = false;
    let outcome: EngineRunOutcome | undefined;
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        const slot = pending;
        pending = undefined;
        slot?.reject(new EngineError('cancelled'));
        inflight?.reject(new EngineError('cancelled'));
        wake?.();
        try {
          await session.close();
          this.sessions.delete(session);
        } catch {
          this.failedDrain = true;
          throw new EngineError('drain-failed');
        }
      })());
    const abort = () => {
      void close().catch(() => {});
    };
    try {
      if (input.signal.aborted) throw new EngineError('cancelled');
      input.signal.addEventListener('abort', abort, { once: true });
      if (input.signal.aborted) abort();
      const handle = session.run(
        engineRunInputSchema.parse({
          runId: executionId,
          providerId: this.providerId,
          model: input.model,
          system: input.system,
          prompt: input.prompt,
          context: input.context,
          tools: !!input.executeCommand || !!input.executePluginManagement,
          toolNames: input.executePluginManagement ? ['plugins.manage'] : [],
          ...(input.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: input.maxOutputTokens }),
          ...(input.requireComplete === undefined
            ? {}
            : { requireComplete: input.requireComplete }),
          ...(input.allowCommandProposal === undefined
            ? {}
            : { allowCommandProposal: input.allowCommandProposal }),
        }),
        {
          event: async (event) => {
            if (input.signal.aborted) throw new EngineError('cancelled');
            if (closing) throw new EngineError('closed');
            if (pending) throw new EngineError('backpressure');
            await new Promise<void>((accept, reject) => {
              pending = { event, accept, reject };
              wake?.();
            });
          },
          ...(input.executeCommand || input.executePluginManagement
            ? {
                tool: async (request, signal) => {
                  signal.throwIfAborted();
                  if (input.signal.aborted) throw new EngineError('cancelled');
                  if (request.name === 'plugins.manage' && input.executePluginManagement)
                    return input.executePluginManagement(
                      request.arguments,
                      request.callId,
                      AbortSignal.any([signal, input.signal]),
                    );
                  if (
                    !input.executeCommand ||
                    request.name !== 'workspace.exec' ||
                    Object.keys(request.arguments).length !== 1 ||
                    typeof request.arguments.command !== 'string'
                  )
                    throw new EngineError('tool-unavailable');
                  return input.executeCommand!(
                    request.arguments.command,
                    request.callId,
                    AbortSignal.any([signal, input.signal]),
                  );
                },
              }
            : {}),
        },
        this.options,
      );
      const settlement = handle.done.then((value) => {
        outcome = value;
        ended = true;
        wake?.();
      });
      void settlement.catch(() => {
        outcome = { status: 'failed', code: 'provider-failed' };
        ended = true;
        wake?.();
      });
      while (true) {
        if (input.signal.aborted) throw new EngineError('cancelled');
        if (pending) {
          const slot = pending;
          pending = undefined;
          inflight = slot;
          try {
            yield slot.event;
          } finally {
            slot.accept();
            inflight = undefined;
          }
          continue;
        }
        if (ended) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (pending || ended || input.signal.aborted) resolve();
        });
        wake = undefined;
      }
      await settlement;
      if (!outcome || outcome.status !== 'completed')
        throw new EngineError(
          outcome?.status === 'cancelled' ? 'cancelled' : (outcome?.code ?? 'provider-failed'),
        );
    } finally {
      input.signal.removeEventListener('abort', abort);
      await close();
    }
  }
}
