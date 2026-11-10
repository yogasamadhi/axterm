import { randomUUID } from 'node:crypto';
import {
  connectionInteractionSchema,
  connectionInteractionResponseSchema,
  type Interaction,
} from '@axterm/plugin-api/connections';
import { ApplicationError } from './errors.ts';
import type { ConnectionEvents } from '../ports/events.ts';
interface Reply {
  accepted: boolean;
  remember: boolean;
  values: Record<string, string>;
}
interface PendingInteraction {
  metadata: Interaction;
  resolve(value: Reply): void;
  timer: ReturnType<typeof setTimeout>;
  detach(): void;
}
/** Generation-owned challenges. Answers go directly to the waiter and never to observers. */
export class InteractionService {
  private readonly pending = new Map<string, PendingInteraction>();
  private closed = false;
  constructor(private readonly realtime: ConnectionEvents) {}
  request(
    input: Omit<Interaction, 'id' | 'createdAt'>,
    timeoutMs = 120_000,
    signal?: AbortSignal,
  ): Promise<Reply> {
    if (this.closed)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Interactions are closed', 503);
    if (signal?.aborted) throw new ApplicationError('REQUEST_CANCELED', 'Interaction canceled');
    if (this.pending.size >= 64)
      throw new ApplicationError('CAPACITY_EXCEEDED', 'Interaction capacity exceeded', 503);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
      throw new ApplicationError('VALIDATION_ERROR', 'Invalid interaction timeout', 400);
    const parsed = connectionInteractionSchema.safeParse({
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    if (!parsed.success)
      throw new ApplicationError('VALIDATION_ERROR', 'Invalid interaction metadata', 400);
    const metadata: Interaction = parsed.data;
    return new Promise((resolve, reject) => {
      const aborted = () => {
        if (this.pending.has(metadata.id)) this.cancel(metadata.id);
      };
      const detach = () => signal?.removeEventListener('abort', aborted);
      const timer = setTimeout(() => {
        this.pending.delete(metadata.id);
        detach();
        this.realtime.publish('interaction.expired', { id: metadata.id });
        reject(new ApplicationError('INVALID_STATE', 'Interaction expired', 409));
      }, timeoutMs);
      timer.unref();
      this.pending.set(metadata.id, { metadata, resolve, timer, detach });
      signal?.addEventListener('abort', aborted, { once: true });
      this.realtime.publish('interaction.required', structuredClone(metadata));
    });
  }
  list(): Interaction[] {
    return [...this.pending.values()].map(({ metadata }) => structuredClone(metadata));
  }
  resourceCount(): number {
    return this.pending.size;
  }
  respond(id: string, input: Reply): void {
    const pending = this.pending.get(id);
    if (!pending) throw new ApplicationError('NOT_FOUND', 'Interaction not found', 404);
    const parsed = connectionInteractionResponseSchema.safeParse(input);
    if (
      !parsed.success ||
      Object.keys(parsed.data.values).some(
        (key) => !pending.metadata.fields.some((field) => field.id === key),
      )
    )
      throw new ApplicationError('VALIDATION_ERROR', 'Invalid interaction response', 400);
    clearTimeout(pending.timer);
    pending.detach();
    this.pending.delete(id);
    pending.resolve(parsed.data);
    this.realtime.publish('interaction.resolved', { id, accepted: parsed.data.accepted });
  }
  cancel(id: string): void {
    this.respond(id, { accepted: false, remember: false, values: {} });
  }
  cancelConnection(connectionId: string): void {
    for (const [id, pending] of this.pending)
      if (pending.metadata.connectionId === connectionId) this.cancel(id);
  }
  close(): void {
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }
}
