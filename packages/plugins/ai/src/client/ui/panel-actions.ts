import { AiRunAdmissions } from '../run-admissions.ts';
import { ContextReviewOwner } from './context-review-owner.ts';
import { chooseBrowserFile } from './browser-file.ts';
import type * as A from '@axterm/plugin-api/ai';
import type {
  CreateSavedCredentialInput,
  SavedCredentialActions,
} from '@axterm/plugin-api/saved-credentials';
import type { FileGrantActions, FileGrant } from '@axterm/plugin-api/files';
import type { AiModel } from '../index.ts';
import { AiPanelQueries } from '../panel-queries.ts';
import { AttachmentDraftOwner } from './attachment-draft-owner.ts';
export interface TerminalAiDraft {
  nonce: string;
  prompt: string;
  modelId?: string | undefined;
}
type Versioned = { id: string; version: number };
/** Private presentation actions invoke the owning generated Client models once. */
export class AiPanelActions {
  readonly queries: AiPanelQueries;
  private readonly runAdmissions: AiRunAdmissions;
  private runReservations = 0;
  private readonly runGenerations = new Map<string, string>();
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly composers = new Set<AttachmentDraftOwner>();
  private readonly reviews = new Set<ContextReviewOwner>();
  private readonly fileGrants = new Set<string>();
  private grantReservations = 0;
  private closing: Promise<void> | undefined;
  private closed = false;
  constructor(
    readonly model: AiModel,
    private readonly credentials: SavedCredentialActions,
    private readonly files: FileGrantActions,
    private readonly insert: (id: string, text: string, signal: AbortSignal) => Promise<void>,
  ) {
    this.queries = new AiPanelQueries(model);
    this.runAdmissions = new AiRunAdmissions(model);
  }
  createReviewOwner(): ContextReviewOwner {
    this.assert();
    if (this.reviews.size >= 8) throw new Error('AI_REVIEW_CAPACITY');
    const owner = new ContextReviewOwner(this, () => this.reviews.delete(owner));
    this.reviews.add(owner);
    return owner;
  }
  createAttachmentOwner(): AttachmentDraftOwner {
    this.assert();
    if (this.composers.size >= 8) throw new Error('AI_COMPOSER_CAPACITY');
    const owner = new AttachmentDraftOwner(this, () => this.composers.delete(owner));
    this.composers.add(owner);
    return owner;
  }
  createFileGrant(kind: 'open-file', signal?: AbortSignal) {
    return this.acquireGrant(async (owned) => {
      if (location.protocol === 'axterm-app:') return this.files.create({ kind }, owned);
      const file = await chooseBrowserFile(owned);
      return file ? this.files.importFile(file, false, owned) : undefined;
    }, signal);
  }
  // Cleanup remains admitted while actual composer operations are being retired.
  revokeFileGrant(id: string) {
    if (!this.fileGrants.has(id)) return Promise.resolve();
    return this.cleanup(async () => {
      await this.files.revoke(id);
      this.fileGrants.delete(id);
    });
  }
  importDroppedFile(file: File, signal?: AbortSignal) {
    return this.acquireGrant((owned) => this.files.importFile(file, false, owned), signal);
  }
  private acquireGrant<T extends FileGrant | undefined>(
    acquire: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.task(async () => {
      if (this.fileGrants.size + this.grantReservations >= 64)
        throw new Error('AI_FILE_GRANT_CAPACITY');
      this.grantReservations++;
      try {
        const grant = await acquire(this.signal(signal));
        if (grant) this.fileGrants.add(grant.grantId);
        return grant;
      } finally {
        this.grantReservations--;
      }
    });
  }
  prepareAiAttachment(id: string, signal?: AbortSignal) {
    return this.task(() => this.model.prepareAttachment(id, this.signal(signal)));
  }
  discardAiAttachment(id: string) {
    return this.cleanup(() => this.model.discardAttachment(id));
  }
  previewAiContext(input: A.AiContextPreviewInput, signal?: AbortSignal) {
    return this.task(() => this.model.previewContext(input, this.signal(signal)));
  }
  startAi(input: A.AiRequestInput) {
    return this.task(async () => {
      const facts = this.model.getSnapshot();
      if (facts.status === 'ready')
        for (const [id, generation] of this.runGenerations) {
          const run = facts.baseline.runs.find((row) => row.id === id);
          if (
            generation !== facts.baseline.generation ||
            (run && ['succeeded', 'failed', 'canceled'].includes(run.state))
          )
            this.runGenerations.delete(id);
        }
      if (this.runGenerations.size + this.runReservations >= 128)
        throw new Error('AI_UI_RUN_CAPACITY');
      this.runReservations++;
      try {
        const owned = await this.runAdmissions.start(input);
        this.runGenerations.set(owned.run.id, owned.generation);
        if (this.lifetime.signal.aborted) await this.runAdmissions.cancel(owned);
        return owned.run;
      } finally {
        this.runReservations--;
      }
    });
  }
  cancelAi(id: string) {
    return this.cleanup(async () => {
      const result = await this.model.cancelRun(
        crypto.randomUUID(),
        id,
        this.runGenerations.get(id),
      );
      this.runGenerations.delete(id);
      return result;
    });
  }
  insertTerminal = (id: string, text: string) =>
    this.task(() => this.insert(id, text, this.lifetime.signal));
  decideApproval(id: string, decision: 'approve_once' | 'reject', argsHash: string) {
    return this.task(() =>
      this.model.decideApproval(crypto.randomUUID(), id, { decision, argsHash }),
    );
  }
  testAiProvider(id: string) {
    return this.task(() => this.model.testProvider(id, this.lifetime.signal));
  }
  createAiProvider(input: A.AiProviderInput): Promise<A.AiProvider> {
    return this.task(async () => {
      const receipt = await this.model.createProvider(crypto.randomUUID(), input);
      return this.model.readProvider(receipt.ids[0]!);
    });
  }
  updateAiProvider(row: Versioned, input: A.AiProviderPatch) {
    return this.task(() =>
      this.model.updateProvider(crypto.randomUUID(), row.id, input, `"v${row.version}"`),
    );
  }
  deleteAiProvider(row: Versioned) {
    return this.task(() =>
      this.model.deleteProvider(crypto.randomUUID(), row.id, `"v${row.version}"`),
    );
  }
  createAiModel(input: A.AiModelInput): Promise<A.AiModel> {
    return this.task(async () => {
      const receipt = await this.model.createModel(crypto.randomUUID(), input);
      const state = this.model.getSnapshot();
      const row =
        state.status === 'ready'
          ? state.baseline.models.find((row) => row.id === receipt.ids[0])
          : undefined;
      if (!row) throw new Error('AI_MODEL_OBSERVATION_UNAVAILABLE');
      return row;
    });
  }
  deleteAiModel(row: Versioned) {
    return this.task(() =>
      this.model.deleteModel(crypto.randomUUID(), row.id, `"v${row.version}"`),
    );
  }
  createAiConversation(input: A.AiConversationInput): Promise<A.AiConversation> {
    return this.task(async () => {
      const receipt = await this.model.createConversation(crypto.randomUUID(), input);
      return this.model.getConversation(receipt.ids[0]!);
    });
  }
  deleteAiConversation(row: Versioned) {
    return this.task(() =>
      this.model.deleteConversation(crypto.randomUUID(), row.id, `"v${row.version}"`),
    );
  }
  createCredential(input: CreateSavedCredentialInput): Promise<{ ref: string }> {
    return this.task(async () => {
      const receipt = await this.credentials.create(input);
      if (receipt.status !== 'completed') throw new Error('AI_CREDENTIAL_OUTCOME_UNCERTAIN');
      return { ref: receipt.ref };
    });
  }
  deleteCredential(ref: string): Promise<void> {
    return this.task(async () => {
      const receipt = await this.credentials.remove(ref);
      if (receipt.status !== 'completed') throw new Error('AI_CREDENTIAL_OUTCOME_UNCERTAIN');
    });
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    const done = Promise.withResolvers<void>();
    this.closing = done.promise;
    this.lifetime.abort();
    void (async () => {
      const owners = await Promise.allSettled(
        [...this.composers, ...this.reviews].map((owner) => owner.dispose()),
      );
      await Promise.allSettled([...this.pending]);
      const grants = await Promise.allSettled(
        [...this.fileGrants].map((id) => this.revokeFileGrant(id)),
      );
      const queries = await Promise.allSettled([
        this.queries.dispose(),
        this.runAdmissions.close(),
      ]);
      if ([...owners, ...grants, ...queries].some((result) => result.status === 'rejected'))
        throw new Error('AI_UI_DRAIN_FAILED');
      this.closed = true;
    })().then(done.resolve, done.reject);
    return this.closing;
  }
  private signal(signal?: AbortSignal) {
    return AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
  }
  private assert() {
    if (this.closing) throw new Error('AI_UI_CLOSED');
  }
  private task<T>(run: () => Promise<T>): Promise<T> {
    this.assert();
    return this.cleanup(run);
  }
  private cleanup<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('AI_UI_CLOSED');
    if (this.pending.size >= 64) throw new Error('AI_UI_CAPACITY');
    const task = Promise.resolve().then(run);
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
}
