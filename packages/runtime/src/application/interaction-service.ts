import { randomUUID } from 'node:crypto';
import type { Interaction } from '@workspace/contracts';
import { ApplicationError } from './errors';
import type { RealtimeHub } from './realtime-hub';

interface PendingInteraction {
  metadata: Interaction;
  resolve(value: { accepted: boolean; remember: boolean; values: Record<string, string> }): void;
  timer: ReturnType<typeof setTimeout>;
}

export class InteractionService {
  private readonly pending = new Map<string, PendingInteraction>();
  constructor(private readonly realtime: RealtimeHub) {}

  request(
    input: Omit<Interaction, 'id' | 'createdAt'>,
    timeoutMs = 120_000,
  ): Promise<{ accepted: boolean; remember: boolean; values: Record<string, string> }> {
    const metadata: Interaction = {
      id: randomUUID(),
      ...input,
      createdAt: new Date().toISOString(),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(metadata.id);
        this.realtime.publish('interaction.expired', { id: metadata.id });
        reject(new ApplicationError('INVALID_STATE', 'Interaction expired', 409));
      }, timeoutMs);
      timer.unref();
      this.pending.set(metadata.id, { metadata, resolve, timer });
      this.realtime.publish('interaction.required', metadata);
    });
  }

  list(): Interaction[] {
    return [...this.pending.values()].map(({ metadata }) => ({ ...metadata }));
  }
  resourceCount(): number {
    return this.pending.size;
  }

  respond(
    id: string,
    value: { accepted: boolean; remember: boolean; values: Record<string, string> },
  ): void {
    const pending = this.pending.get(id);
    if (!pending) throw new ApplicationError('NOT_FOUND', 'Interaction not found', 404);
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(value);
    this.realtime.publish('interaction.resolved', { id, accepted: value.accepted });
  }

  cancel(id: string): void {
    this.respond(id, { accepted: false, remember: false, values: {} });
  }

  close(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ accepted: false, remember: false, values: {} });
      this.pending.delete(id);
    }
  }
}
