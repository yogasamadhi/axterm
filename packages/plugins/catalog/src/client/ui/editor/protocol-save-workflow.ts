import { validateProtocolSaveInput } from './validate-draft.ts';
import { remoteErrorOf } from '@axterm/plugin-api';
import {
  createBookmarkSchema,
  type CatalogReceipt,
  type CreateBookmarkInput,
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
export interface ProtocolCredentialDraft {
  readonly field: 'credentialRef' | 'proxy';
  readonly input: CreateSavedCredentialInput;
}
export interface ProtocolSaveDraft {
  readonly input: CreateBookmarkInput;
  readonly credentials: readonly ProtocolCredentialDraft[];
  readonly bookmark?: Bookmark | undefined;
}
export interface ProtocolSaveState {
  readonly status: 'idle' | 'running' | 'uncertain' | 'failed' | 'completed';
  readonly receipt?: CatalogReceipt;
  readonly retainedCredentials?: boolean;
}
/** One job owns the Vault admissions and the atomic Catalog command. Published state never contains secrets. */
export class ProtocolSaveWorkflow {
  private state: ProtocolSaveState = { status: 'idle' };
  private readonly listeners = new Set<() => void>();
  private draft: ProtocolSaveDraft | undefined;
  private generation: string | undefined;
  private tree: string | undefined;
  private createdCount = 0;
  private index = 0;
  private credential: CredentialSubmission | undefined;
  private command:
    | {
        id: string;
        input: CreateBookmarkInput;
      }
    | undefined;
  private phase: 'credentials' | 'catalog' = 'credentials';
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly model: Pick<CatalogModel, 'getSnapshot' | 'createBookmark' | 'updateBookmark'>,
    private readonly vault: SavedCredentialActions,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  start(draft: ProtocolSaveDraft): Promise<void> {
    if (
      this.closing ||
      this.pending ||
      this.state.status === 'uncertain' ||
      this.state.status === 'completed'
    )
      throw new Error('PROTOCOL_SAVE_NOT_IDLE');
    const facts = this.model.getSnapshot();
    if (facts.status !== 'ready') throw new Error('PROTOCOL_SAVE_UNAVAILABLE');
    if (
      draft.credentials.length > 4 ||
      new Set(draft.credentials.map((value) => value.field)).size !== draft.credentials.length
    )
      throw new Error('PROTOCOL_SAVE_INVALID');
    if (draft.input.protocol === 'ssh') throw new Error('PROTOCOL_SAVE_WRONG_OWNER');
    const input = validateProtocolSaveInput(
      draft.input,
      draft.credentials.some((value) => value.field === 'proxy'),
    );
    const credentials = draft.credentials.map((value) => ({
      field: value.field,
      input: createSavedCredentialSchema.parse(value.input),
    }));
    if (
      credentials.some((value) => value.field === 'proxy') &&
      !(['rdp', 'vnc', 'spice'] as const).some(
        (protocol) => input[protocol]?.proxy?.mode === 'custom',
      )
    )
      throw new Error('PROTOCOL_SAVE_INVALID_PROXY');
    if (credentials.some((value) => value.field === 'credentialRef') && !this.settings(input))
      throw new Error('PROTOCOL_SAVE_INVALID_CREDENTIAL_TARGET');
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
      throw new Error('PROTOCOL_SAVE_NOT_UNCERTAIN');
    return this.run(true);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      await this.pending;
      this.listeners.clear();
      if (this.state.status === 'uncertain' && !this.retireChangedGeneration())
        throw new Error('PROTOCOL_SAVE_DRAIN_UNCERTAIN');
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
    if (!draft) throw new Error('PROTOCOL_SAVE_DRAFT_MISSING');
    if (this.phase === 'credentials') {
      while (this.index < draft.credentials.length) {
        if (!this.available()) return;
        const item = draft.credentials[this.index]!;
        if (!this.credential) {
          try {
            this.credential = this.vault.submitCreate(item.input);
          } catch {
            this.fail();
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
            const settings = this.settings(draft.input);
            const proxy = settings && 'proxy' in settings ? settings.proxy : undefined;
            if (proxy?.mode !== 'custom') throw new Error('PROTOCOL_SAVE_PROXY_MISSING');
            proxy.endpoint.credentialRef = receipt.ref;
          } else {
            const settings = this.settings(draft.input);
            if (!settings) throw new Error('PROTOCOL_SAVE_SETTINGS_MISSING');
            settings.credentialRef = receipt.ref;
          }
          this.index++;
          this.credential = undefined;
          reconcile = false;
        } else if (receipt.status === 'failed') {
          this.credential = undefined;
          this.fail();
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
        this.command = { id: crypto.randomUUID(), input: createBookmarkSchema.parse(draft.input) };
      const { id, input } = this.command;
      try {
        const { protocol, hostId: _hostId, ...fields } = input;
        const {
          ftp: _ftp,
          telnet: _telnet,
          serial: _serial,
          rdp: _rdp,
          vnc: _vnc,
          spice: _spice,
          web: _web,
          ...metadata
        } = fields;
        const patch = {
          ...metadata,
          ...(protocol === 'local' || protocol === 'ssh' ? {} : { [protocol]: input[protocol] }),
        };
        const receipt = draft.bookmark
          ? await this.model.updateBookmark(id, draft.bookmark.id, patch, this.tree)
          : await this.model.createBookmark(id, input, this.tree);
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
        this.fail();
        return;
      }
    }
  }
  private fail(): void {
    this.draft = undefined;
    this.publish({ status: 'failed', ...(this.createdCount ? { retainedCredentials: true } : {}) });
  }

  private settings(input: CreateBookmarkInput) {
    switch (input.protocol) {
      case 'ftp':
        return input.ftp;
      case 'telnet':
        return input.telnet;
      case 'rdp':
        return input.rdp;
      case 'vnc':
        return input.vnc;
      case 'spice':
        return input.spice;
      default:
        return undefined;
    }
  }
  private matches(receipt: CredentialCommandReceipt, submission: CredentialSubmission) {
    return (
      receipt.commandId === submission.commandId &&
      receipt.generation === this.generation &&
      submission.generation === this.generation
    );
  }
  private publish(state: ProtocolSaveState) {
    this.state = Object.freeze(state);
    if (!this.closing) for (const listener of this.listeners) listener();
  }
}
