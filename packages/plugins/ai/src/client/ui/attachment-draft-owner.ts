import type { AiAttachmentPreview } from '@axterm/plugin-api/ai';
interface AttachmentClient {
  discardAiAttachment(id: string): Promise<unknown>;
}
export type AttachmentAdmission = 'accepted' | 'duplicate' | 'limit' | 'stale';
/** Preview authority and actual preparation tasks belong to this composer lifetime. */
export class AttachmentDraftOwner {
  private active = true;
  private pending: AbortController | undefined;
  private readonly tasks = new Map<
    AbortController,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  private readonly drafts = new Map<string, AiAttachmentPreview>();
  private readonly failed = new Set<string>();
  private readonly releasing = new Map<string, Promise<void>>();
  private closing: Promise<void> | undefined;
  private snapshot: readonly AiAttachmentPreview[] = Object.freeze([]);
  private readonly listeners = new Set<() => void>();
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    if (this.listeners.size >= 64) throw new Error('AI_ATTACHMENT_OBSERVER_CAPACITY');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(): void {
    this.snapshot = Object.freeze([...this.drafts.values()]);
    for (const listener of this.listeners)
      try {
        listener();
      } catch {
        console.warn('AI_ATTACHMENT_OBSERVER_FAILED');
      }
  }
  constructor(
    private readonly client: AttachmentClient,
    private readonly retired: () => void = () => {},
  ) {}
  begin(): AbortController | undefined {
    if (!this.active || this.pending || this.tasks.size >= 8 || this.failed.size >= 8) return;
    const operation = new AbortController();
    this.pending = operation;
    this.tasks.set(operation, Promise.withResolvers<void>());
    return operation;
  }
  isCurrent(operation: AbortController): boolean {
    return this.active && this.pending === operation && !operation.signal.aborted;
  }
  finish(operation: AbortController): boolean {
    const current = this.isCurrent(operation);
    if (this.pending === operation) this.pending = undefined;
    this.tasks.get(operation)?.resolve();
    this.tasks.delete(operation);
    return current;
  }
  list(): AiAttachmentPreview[] {
    return [...this.drafts.values()];
  }
  resourceCount(): number {
    return (
      this.tasks.size + new Set([...this.drafts.keys(), ...this.failed]).size + this.releasing.size
    );
  }
  async admit(
    operation: AbortController,
    preview: AiAttachmentPreview,
  ): Promise<AttachmentAdmission> {
    let outcome: AttachmentAdmission = 'accepted';
    if (!this.isCurrent(operation)) outcome = 'stale';
    else if (this.list().some(({ name, size }) => name === preview.name && size === preview.size))
      outcome = 'duplicate';
    else if (
      this.drafts.size >= 8 ||
      this.list().reduce((sum, item) => sum + item.size, 0) + preview.size > 100 * 1024
    )
      outcome = 'limit';
    if (outcome !== 'accepted') await this.release(preview.id);
    else {
      this.drafts.set(preview.id, Object.freeze({ ...preview }));
      this.publish();
    }
    return outcome;
  }
  async remove(id: string): Promise<void> {
    if (!this.drafts.has(id)) return;
    await this.release(id);
  }
  consume(ids: readonly string[]): void {
    for (const id of ids) {
      this.drafts.delete(id);
      this.failed.delete(id);
    }
    this.publish();
  }
  cancel(): void {
    for (const operation of this.tasks.keys()) operation.abort();
    this.pending = undefined;
  }
  async clear(): Promise<void> {
    this.cancel();
    const ids = [...new Set([...this.drafts.keys(), ...this.failed])];
    for (const id of ids) this.failed.add(id);
    this.drafts.clear();
    this.publish();
    const results = await Promise.allSettled(ids.map((id) => this.release(id)));
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('AI_ATTACHMENT_RELEASE_FAILED');
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.active = false;
    const completion = Promise.withResolvers<void>();
    this.closing = completion.promise;
    this.cancel();
    void (async () => {
      await Promise.all([...this.tasks.values()].map((task) => task.promise));
      await Promise.allSettled([...this.releasing.values()]);
      await this.clear();
      this.listeners.clear();
      this.retired();
    })().then(completion.resolve, (error) => {
      this.closing = undefined;
      completion.reject(error);
    });
    return this.closing;
  }
  private release(id: string): Promise<void> {
    const current = this.releasing.get(id);
    if (current) return current;
    this.failed.add(id);
    const task = Promise.resolve()
      .then(async () => {
        await this.client.discardAiAttachment(id);
        this.failed.delete(id);
        this.drafts.delete(id);
        this.publish();
      })
      .finally(() => this.releasing.delete(id));
    this.releasing.set(id, task);
    return task;
  }
}
