import type { AiAttachmentPreview } from '@workspace/contracts';

interface AttachmentClient {
  discardAiAttachment(id: string): Promise<unknown>;
}

export type AttachmentAdmission = 'accepted' | 'duplicate' | 'limit' | 'stale';

/** Runtime preview IDs belong to this composer lifetime; bytes remain in the Runtime. */
export class AttachmentDraftOwner {
  private active = true;
  private pending: AbortController | undefined;
  private drafts: AiAttachmentPreview[] = [];

  constructor(private readonly client: AttachmentClient) {}

  begin(): AbortController | undefined {
    if (!this.active || this.pending) return;
    const operation = new AbortController();
    this.pending = operation;
    return operation;
  }

  isCurrent(operation: AbortController): boolean {
    return this.active && this.pending === operation && !operation.signal.aborted;
  }

  finish(operation: AbortController): boolean {
    if (!this.isCurrent(operation)) return false;
    this.pending = undefined;
    return true;
  }

  list(): AiAttachmentPreview[] {
    return [...this.drafts];
  }

  async admit(
    operation: AbortController,
    preview: AiAttachmentPreview,
  ): Promise<AttachmentAdmission> {
    let outcome: AttachmentAdmission = 'accepted';
    if (!this.isCurrent(operation)) outcome = 'stale';
    else if (this.drafts.some(({ name, size }) => name === preview.name && size === preview.size))
      outcome = 'duplicate';
    else if (
      this.drafts.length >= 8 ||
      this.drafts.reduce((sum, item) => sum + item.size, 0) + preview.size > 100 * 1024
    )
      outcome = 'limit';
    if (outcome !== 'accepted') {
      await this.release(preview.id);
      return outcome;
    }
    this.drafts.push(preview);
    return outcome;
  }

  async remove(id: string): Promise<void> {
    if (!this.drafts.some((item) => item.id === id)) return;
    this.drafts = this.drafts.filter((item) => item.id !== id);
    await this.release(id);
  }

  consume(ids: readonly string[]): void {
    const consumed = new Set(ids);
    this.drafts = this.drafts.filter((item) => !consumed.has(item.id));
  }

  cancel(): void {
    this.pending?.abort();
    this.pending = undefined;
  }

  async clear(): Promise<void> {
    this.cancel();
    const previous = this.drafts;
    this.drafts = [];
    await Promise.allSettled(previous.map(({ id }) => this.release(id)));
  }

  async dispose(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await this.clear();
  }

  private async release(id: string): Promise<void> {
    await this.client.discardAiAttachment(id).catch(() => undefined);
  }
}
