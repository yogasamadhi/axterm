import { chooseBrowserFile } from '../browser-file.ts';
import { remoteErrorOf } from '@axterm/plugin-api';
import {
  connectionProfileInputSchema,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type CatalogReceipt,
} from '@axterm/plugin-api/catalog';
import {
  createSavedCredentialSchema,
  createGrantedCredentialSchema,
  type CreateSavedCredentialInput,
  type CreateGrantedCredentialInput,
  type SavedCredentialActions,
  type CredentialSubmission,
} from '@axterm/plugin-api/saved-credentials';
import type { FileGrant, FileGrantActions } from '@axterm/plugin-api/files';
import type { CatalogModel } from '../../index.ts';
export const profileCredentialTargets = [
  ['ssh', 'passwordCredentialRef', 'ssh.password', 'sshPassword'],
  ['ssh', 'privateKeyCredentialRef', 'ssh.privateKey', 'privateKey'],
  ['ssh', 'passphraseCredentialRef', 'ssh.passphrase', 'privateKeyPassphrase'],
  ['ssh', 'certificateCredentialRef', 'ssh.certificate', 'sshCertificate'],
  ...(['telnet', 'vnc', 'rdp', 'ftp', 'spice'] as const).map(
    (protocol) =>
      [protocol, 'passwordCredentialRef', `${protocol}.password`, 'protocolPassword'] as const,
  ),
] as const;
export type ProfileCredentialField = (typeof profileCredentialTargets)[number][2];
type CredentialDraft = { field: ProfileCredentialField } & (
  { input: CreateSavedCredentialInput } | { grant: CreateGrantedCredentialInput }
);
export interface ProfileDraft {
  input: ConnectionProfileInput;
  credentials: readonly CredentialDraft[];
  current?: ConnectionProfile;
}
export interface ProfileCommandState {
  readonly status: 'idle' | 'selecting' | 'running' | 'uncertain' | 'failed' | 'completed';
  readonly operation?: 'save' | 'delete' | undefined;
  readonly receipt?: CatalogReceipt | undefined;
  readonly retainedCredentials?: boolean | undefined;
  readonly files: Readonly<Partial<Record<ProfileCredentialField, string>>>;
}
type ProfileModel = Pick<
  CatalogModel,
  'getSnapshot' | 'createConnectionProfile' | 'updateConnectionProfile' | 'deleteConnectionProfile'
>;
/** One owned, bounded job; credentials never enter a baseline, receipt or published UI state. */
export class ConnectionProfileCommands {
  private state: ProfileCommandState = { status: 'idle', files: {} };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private readonly selected = new Map<ProfileCredentialField, FileGrant>();
  private readonly leases = new Set<string>();
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private generation: string | undefined;
  private job:
    | { operation: 'save'; draft: ProfileDraft }
    | { operation: 'delete'; current: ConnectionProfile }
    | undefined;
  private credential: CredentialSubmission | undefined;
  private index = 0;
  private created = 0;
  private key: string | undefined;
  constructor(
    private readonly model: ProfileModel,
    private readonly vault: SavedCredentialActions,
    private readonly files: FileGrantActions,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  grant(field: ProfileCredentialField) {
    return this.selected.get(field);
  }
  choose(field: ProfileCredentialField, file?: File): Promise<void> {
    this.assertIdle();
    if (this.leases.size >= 4) throw new Error('PROFILE_GRANT_CAPACITY');
    if (field !== 'ssh.privateKey' && field !== 'ssh.certificate')
      throw new Error('PROFILE_FILE_TARGET_INVALID');
    const generation = this.readyGeneration();
    this.publish({ status: 'selecting' });
    return this.track(
      (async () => {
        try {
          const browser = typeof location !== 'undefined' && location.protocol !== 'axterm-app:';
          const selectedFile =
            file ?? (browser ? await chooseBrowserFile(this.lifetime.signal) : undefined);
          if (selectedFile && selectedFile.size > 131072) throw new Error('PROFILE_FILE_TOO_LARGE');
          const grant = selectedFile
            ? await this.files.importFile(selectedFile, false, this.lifetime.signal)
            : browser
              ? undefined
              : await this.files.create({ kind: 'open-file' }, this.lifetime.signal);
          if (grant) {
            this.leases.add(grant.grantId);
            if (this.closing || this.readyGeneration() !== generation) {
              await this.release(grant.grantId);
              return;
            }
            const previous = this.selected.get(field);
            this.selected.set(field, grant);
            if (previous) await this.release(previous.grantId);
          }
          this.publish({ status: 'idle' });
        } catch {
          this.publish({ status: 'failed' });
        }
      })(),
    );
  }
  clearFile(field: ProfileCredentialField): Promise<void> {
    this.assertIdle();
    const grant = this.selected.get(field);
    this.selected.delete(field);
    this.publish({ status: 'idle' });
    return this.track(grant ? this.release(grant.grantId) : Promise.resolve());
  }
  reset(): Promise<void> {
    this.assertIdle();
    this.selected.clear();
    this.publish({
      status: 'idle',
      receipt: undefined,
      retainedCredentials: undefined,
      operation: undefined,
    });
    return this.track(this.releaseAll());
  }
  start(draft: ProfileDraft): Promise<void> {
    this.assertIdle();
    const generation = this.readyGeneration();
    const input = connectionProfileInputSchema.parse(draft.input);
    if (
      draft.credentials.length > 9 ||
      new Set(draft.credentials.map((item) => item.field)).size !== draft.credentials.length
    )
      throw new Error('PROFILE_CREDENTIALS_INVALID');
    const credentials = draft.credentials.map((item) => {
      const target = profileCredentialTargets.find((target) => target[2] === item.field);
      if (!target) throw new Error('PROFILE_CREDENTIAL_TARGET_INVALID');
      if ('grant' in item) {
        const grant = createGrantedCredentialSchema.parse(item.grant);
        if (target[3] !== grant.kind || this.selected.get(item.field)?.grantId !== grant.grantId)
          throw new Error('PROFILE_GRANT_INVALID');
        return { field: item.field, grant };
      }
      const parsed = createSavedCredentialSchema.parse(item.input);
      if (parsed.kind !== target[3]) throw new Error('PROFILE_CREDENTIAL_KIND_INVALID');
      return { field: item.field, input: parsed };
    });
    this.job = structuredClone({ operation: 'save', draft: { ...draft, input, credentials } });
    this.generation = generation;
    this.index = this.created = 0;
    this.key = crypto.randomUUID();
    this.credential = undefined;
    return this.run(false);
  }
  remove(current: ConnectionProfile): Promise<void> {
    this.assertIdle();
    this.generation = this.readyGeneration();
    this.job = { operation: 'delete', current: structuredClone(current) };
    this.key = crypto.randomUUID();
    this.created = 0;
    return this.run(false);
  }
  retry(): Promise<void> {
    if (this.closing || this.pending || this.state.status !== 'uncertain')
      throw new Error('PROFILE_NOT_UNCERTAIN');
    return this.run(true);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await this.pending;
      this.listeners.clear();
      await this.releaseAll();
      if (this.state.status === 'uncertain' && this.sameGeneration())
        throw new Error('PROFILE_DRAIN_UNCERTAIN');
      this.job = undefined;
      this.selected.clear();
    })());
  }
  private assertIdle() {
    if (
      this.closing ||
      this.pending ||
      ['running', 'selecting', 'uncertain'].includes(this.state.status)
    )
      throw new Error('PROFILE_BUSY');
  }
  private readyGeneration() {
    const facts = this.model.getSnapshot();
    if (facts.status !== 'ready') throw new Error('PROFILE_NOT_READY');
    return facts.baseline.generation;
  }
  private sameGeneration() {
    const facts = this.model.getSnapshot();
    return facts.status !== 'ready' || facts.baseline.generation === this.generation;
  }
  private available() {
    const facts = this.model.getSnapshot();
    if (facts.status === 'ready' && facts.baseline.generation !== this.generation) {
      this.fail();
      return false;
    }
    if (facts.status !== 'ready') {
      this.publish({ status: 'uncertain' });
      return false;
    }
    return true;
  }
  private run(reconcile: boolean): Promise<void> {
    this.publish({
      status: 'running',
      operation: this.job?.operation,
      receipt: undefined,
      retainedCredentials: undefined,
    });
    return this.track(this.advance(reconcile).catch(() => this.publish({ status: 'uncertain' })));
  }
  private async advance(reconcile: boolean): Promise<void> {
    if (!this.available()) return;
    const job = this.job;
    if (!job || !this.key) throw new Error('PROFILE_JOB_MISSING');
    if (job.operation === 'save') {
      const draft = job.draft;
      while (this.index < draft.credentials.length) {
        if (!this.available()) return;
        const item = draft.credentials[this.index]!;
        if (!this.credential) {
          try {
            this.credential =
              'grant' in item
                ? this.vault.submitFromGrant(item.grant, this.lifetime.signal)
                : this.vault.submitCreate(item.input);
          } catch {
            this.fail();
            return;
          }
          if ('input' in item) item.input.secret = '';
          reconcile = false;
        }
        let receipt;
        try {
          receipt = reconcile
            ? await this.vault.outcome(this.credential.commandId)
            : await this.credential.result;
        } catch {
          this.publish({ status: 'uncertain' });
          return;
        }
        if (!this.available()) return;
        if (
          receipt.commandId !== this.credential.commandId ||
          receipt.generation !== this.generation ||
          this.credential.generation !== this.generation ||
          receipt.operation !== 'create'
        ) {
          this.publish({ status: 'uncertain' });
          return;
        }
        if (
          receipt.status === 'failed' ||
          receipt.status === 'interrupted' ||
          receipt.status === 'expired'
        ) {
          this.fail();
          return;
        }
        if (receipt.status !== 'completed') {
          this.publish({ status: 'uncertain' });
          return;
        }
        const target = profileCredentialTargets.find((target) => target[2] === item.field)!;
        const section = draft.input[target[0]]!;
        Object.assign(section, { [target[1]]: receipt.ref });
        this.created++;
        this.index++;
        this.credential = undefined;
        reconcile = false;
      }
    }
    if (!this.available()) return;
    try {
      const receipt =
        job.operation === 'delete'
          ? await this.model.deleteConnectionProfile(
              this.key,
              job.current.id,
              `"v${job.current.version}"`,
            )
          : job.draft.current
            ? await this.model.updateConnectionProfile(
                this.key,
                job.draft.current.id,
                connectionProfileInputSchema.parse(job.draft.input),
                `"v${job.draft.current.version}"`,
              )
            : await this.model.createConnectionProfile(
                this.key,
                connectionProfileInputSchema.parse(job.draft.input),
              );
      this.job = undefined;
      this.credential = undefined;
      this.publish({ status: 'completed', receipt });
    } catch (error) {
      const marked = remoteErrorOf(error);
      if (
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
        ].includes(marked.details.reason)
      )
        this.fail();
      else this.publish({ status: 'uncertain' });
    }
  }
  private fail() {
    const retained = this.created > 0 || !!this.credential;
    this.job = undefined;
    this.credential = undefined;
    this.publish({ status: 'failed', ...(retained ? { retainedCredentials: true } : {}) });
  }
  private track(task: Promise<void>) {
    this.pending = task;
    void task
      .finally(() => {
        if (this.pending === task) this.pending = undefined;
      })
      .catch(() => {});
    return task;
  }
  private async release(id: string) {
    await this.files.revoke(id);
    this.leases.delete(id);
  }
  private async releaseAll() {
    const results = await Promise.allSettled([...this.leases].map((id) => this.release(id)));
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('PROFILE_GRANTS_DRAIN_FAILED');
  }
  private publish(patch: Partial<ProfileCommandState>) {
    this.state = Object.freeze({
      ...this.state,
      ...patch,
      files: Object.freeze(
        Object.fromEntries([...this.selected].map(([field, grant]) => [field, grant.name])),
      ),
    });
    if (!this.closing)
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          console.warn('PROFILE_UI_OBSERVER_FAILED');
        }
      }
  }
}
