import type { ConnectionInteractionResponseInput } from '@axterm/plugin-api/connections';
import type { ConnectionsModel } from '../index.ts';
/** Answers remain accepted commands, never metadata or reconnect work. */
export class InteractionResponses {
  private readonly pending = new Map<string, Promise<void>>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly model: Pick<ConnectionsModel, 'getSnapshot' | 'respondInteraction'>,
  ) {}
  respond(
    generation: string,
    id: string,
    input: ConnectionInteractionResponseInput,
  ): Promise<void> {
    if (this.closing) return Promise.reject(new Error('INTERACTION_UI_CLOSED'));
    const state = this.model.getSnapshot();
    if (
      state.status !== 'ready' ||
      state.baseline.generation !== generation ||
      !state.baseline.interactions.some((interaction) => interaction.id === id)
    )
      return Promise.reject(new Error('INTERACTION_UI_RETIRED'));
    if (this.pending.has(id)) return Promise.reject(new Error('INTERACTION_UI_PENDING'));
    if (this.pending.size >= 8) return Promise.reject(new Error('INTERACTION_UI_CAPACITY'));
    const snapshot = structuredClone(input);
    const task = Promise.resolve()
      .then(() => {
        const current = this.model.getSnapshot();
        if (
          current.status !== 'ready' ||
          current.baseline.generation !== generation ||
          !current.baseline.interactions.some((interaction) => interaction.id === id)
        )
          throw new Error('INTERACTION_UI_RETIRED');
        return this.model.respondInteraction(id, snapshot);
      })
      .finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    const completion = Promise.withResolvers<void>();
    this.closing = completion.promise;
    void Promise.allSettled([...this.pending.values()]).then(() => completion.resolve());
    return this.closing;
  }
}
