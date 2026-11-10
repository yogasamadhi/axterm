import { sshHostFailure, type SshOperationFailure } from './ssh-host-error.ts';
import { validateSshSaveInput } from './validate-draft.ts';
import { remoteErrorOf } from '@axterm/plugin-api';
import {
  createSshBookmarkSchema,
  type CatalogReceipt,
  type CreateSshBookmarkInput,
  type Host,
  type Bookmark,
} from '@axterm/plugin-api/catalog';
import {
  createSavedCredentialSchema,
  type SavedCredentialActions,
  type CreateSavedCredentialInput,
  type CredentialSubmission,
  type CredentialCommandReceipt,
} from '@axterm/plugin-api/saved-credentials';
import type { CatalogModel } from '../../index.ts';
export interface SshCredentialDraft {
  readonly field:
    'credentialRef' | 'passphraseCredentialRef' | 'certificateCredentialRef' | 'proxy';
  readonly input: CreateSavedCredentialInput;
}
export interface SshSaveDraft {
  readonly input: CreateSshBookmarkInput;
  readonly credentials: readonly SshCredentialDraft[];
  readonly host?: Host | undefined;
  readonly bookmark?: Bookmark | undefined;
}
export interface SshSaveState {
  readonly status: 'idle' | 'running' | 'uncertain' | 'failed' | 'completed';
  readonly receipt?: CatalogReceipt;
  readonly retainedCredentials?: boolean;
  readonly failure?: SshOperationFailure;
}
/** One job owns the Vault admissions and the atomic Catalog command. Published state never contains secrets. */
export class SshSaveWorkflow {
  private state: SshSaveState = { status: 'idle' };
  private readonly listeners = new Set<() => void>();
  private draft: SshSaveDraft | undefined;
  private generation: string | undefined;
  private tree: string | undefined;
  private createdCount = 0;
  private index = 0;
  private credential: CredentialSubmission | undefined;
  private command: { id: string; input: CreateSshBookmarkInput } | undefined;
  private phase: 'credentials' | 'catalog' = 'credentials';
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly model: Pick<
      CatalogModel,
      'getSnapshot' | 'createSshBookmark' | 'updateSshBookmark'
    >,
    private readonly vault: SavedCredentialActions,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  start(draft: SshSaveDraft): Promise<void> {
    if (
      this.closing ||
      this.pending ||
      this.state.status === 'uncertain' ||
      this.state.status === 'completed'
    )
      throw new Error('SSH_SAVE_NOT_IDLE');
    const facts = this.model.getSnapshot();
    if (facts.status !== 'ready') throw new Error('SSH_SAVE_UNAVAILABLE');
    if (
      draft.credentials.length > 4 ||
      new Set(draft.credentials.map((value) => value.field)).size !== draft.credentials.length ||
      !!draft.host !== !!draft.bookmark
    )
      throw new Error('SSH_SAVE_INVALID');
    const input = validateSshSaveInput(
      draft.input,
      draft.credentials.some((value) => value.field === 'proxy'),
    );
    const credentials = draft.credentials.map((value) => ({
      field: value.field,
      input: createSavedCredentialSchema.parse(value.input),
    }));
    if (credentials.some((value) => value.field === 'proxy') && input.host.proxy?.mode !== 'custom')
      throw new Error('SSH_SAVE_INVALID_PROXY');
    this.draft = structuredClone({ ...draft, input, credentials });
    this.generation = facts.baseline.generation;
    this.tree = facts.baseline.bookmarks.etag;
    this.index = 0;
    this.createdCount = 0;
    this.command = undefined;
    this.credential = undefined;
    this.phase = 'credentials';
    return this.run(false);
  }
  retry(): Promise<void> {
    if (this.closing || this.pending || this.state.status !== 'uncertain')
      throw new Error('SSH_SAVE_NOT_UNCERTAIN');
    return this.run(true);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      await this.pending;
      this.listeners.clear();
      if (this.state.status === 'uncertain' && !this.retireChangedGeneration())
        throw new Error('SSH_SAVE_DRAIN_UNCERTAIN');
      this.draft = undefined;
    })());
  }
  private run(reconcile: boolean): Promise<void> {
    this.publish({ status: 'running' });
    const task = this.advance(reconcile).catch(() => {
      this.publish({ status: 'uncertain' });
    });
    this.pending = task;
    void task.then(() => {
      if (this.pending === task) this.pending = undefined;
    });
    return task;
  }
  private retireChangedGeneration(): boolean {
    const facts = this.model.getSnapshot();
    if (facts.status !== 'ready' || facts.baseline.generation === this.generation) return false;
    // Old admissions may have committed. Preserve their Vault entries for owner reconciliation, never delete them in a new generation.
    this.draft = undefined;
    this.command = undefined;
    this.credential = undefined;
    this.publish({ status: 'failed' });
    return true;
  }
  private available(): boolean {
    if (this.retireChangedGeneration()) return false;
    const facts = this.model.getSnapshot();
    if (facts.status === 'ready' && facts.baseline.generation === this.generation) return true;
    this.publish({ status: 'uncertain' });
    return false;
  }
  private async advance(reconcile: boolean): Promise<void> {
    if (!this.available()) return;
    const draft = this.draft;
    if (!draft) throw new Error('SSH_SAVE_DRAFT_MISSING');
    if (this.phase === 'credentials') {
      while (this.index < draft.credentials.length) {
        if (!this.available()) return;
        const item = draft.credentials[this.index]!;
        if (!this.credential) {
          try {
            this.credential = this.vault.submitCreate(item.input);
          } catch (error) {
            this.fail(sshHostFailure(error, 'credential'));
            return;
          }
          item.input.secret = '';
          reconcile = false;
        }
        let receipt: CredentialCommandReceipt;
        try {
          receipt = reconcile
            ? await this.vault.outcome(this.credential.commandId)
            : await this.credential.result;
        } catch {
          this.publish({ status: 'uncertain' });
          return;
        }
        if (!this.available()) return;
        if (!this.matches(receipt, this.credential)) {
          this.publish({ status: 'uncertain' });
          return;
        }
        if (receipt.status === 'completed') {
          this.createdCount++;
          if (item.field === 'proxy') {
            const proxy = draft.input.host.proxy;
            if (proxy?.mode !== 'custom') throw new Error('SSH_SAVE_PROXY_MISSING');
            proxy.endpoint.credentialRef = receipt.ref;
          } else draft.input.host[item.field] = receipt.ref;
          this.index++;
          this.credential = undefined;
          reconcile = false;
        } else if (receipt.status === 'failed') {
          this.credential = undefined;
          this.fail({
            stage: 'credential',
            diagnostic: { code: 'CAPABILITY_UNAVAILABLE', operationId: receipt.commandId },
          });
          return;
        } else {
          this.publish({ status: 'uncertain' });
          return;
        }
      }
      if (this.phase === 'credentials') this.phase = 'catalog';
    }
    if (this.phase === 'catalog') {
      if (!this.available()) return;
      if (!this.command)
        this.command = {
          id: crypto.randomUUID(),
          input: createSshBookmarkSchema.parse(draft.input),
        };
      const { id, input } = this.command;
      try {
        const receipt =
          draft.host && draft.bookmark
            ? await this.model.updateSshBookmark(
                id,
                draft.bookmark.id,
                { host: input.host, bookmark: input.bookmark },
                '"v' + draft.host.version + '"',
                this.tree,
              )
            : await this.model.createSshBookmark(id, input, this.tree);
        this.draft = undefined;
        this.command = undefined;
        this.publish({ status: 'completed', receipt });
        return;
      } catch (error) {
        const marked = remoteErrorOf(error);
        const definite =
          marked?.code === 'catalog/failure' &&
          [
            'invalid-input',
            'not-found',
            'capacity',
            'closed',
            'conflict',
            'stale',
            'precondition-required',
            'precondition-failed',
          ].includes(marked.details.reason);
        if (!definite) {
          this.publish({ status: 'uncertain' });
          return;
        }
        this.command = undefined;
        this.fail(sshHostFailure(error, 'save', id));
        return;
      }
    }
  }
  private fail(failure: SshOperationFailure = { stage: 'save' }): void {
    this.draft = undefined;
    this.publish({
      status: 'failed',
      failure,
      ...(this.createdCount ? { retainedCredentials: true } : {}),
    });
  }

  private matches(receipt: CredentialCommandReceipt, submission: CredentialSubmission) {
    return (
      receipt.commandId === submission.commandId &&
      receipt.generation === this.generation &&
      submission.generation === this.generation
    );
  }
  private publish(state: SshSaveState) {
    this.state = Object.freeze(state);
    if (!this.closing) for (const listener of this.listeners) listener();
  }
}
