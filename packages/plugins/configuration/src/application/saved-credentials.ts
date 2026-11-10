import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SavedCredentialsService } from '@axterm/plugin-api/host';
import {
  SavedCredentialStorageError,
  createSavedCredentialSchema,
  createGrantedCredentialSchema,
  type CreateGrantedCredentialInput,
  replaceSavedCredentialSchema,
  savedCredentialRefSchema,
  type CreateSavedCredentialInput,
  type CredentialCommandReceipt,
  type CredentialCommandFailure,
  type SavedCredentialMetadata,
  type CredentialMutationMarker,
} from '@axterm/plugin-api/saved-credentials';
import type { CredentialIntentStore, CredentialFileReader } from '../ports/saved-credentials.ts';
import { CredentialWorkflowError } from './errors.ts';
class CredentialPreparationError extends Error {
  constructor(readonly reason: 'closed' | 'invalid-input') {
    super('CREDENTIAL_PREPARATION_FAILED');
  }
}
/** Coordinates one admitted Vault mutation with a durable intent; never holds a SQLite transaction across IO. */
export class SavedCredentialWorkflow {
  private accepting = true;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly uncertain = new Set<string>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly generation: string,
    private readonly store: CredentialIntentStore,
    private readonly provider: () => SavedCredentialsService | undefined,
  ) {}
  active(): boolean {
    return this.pending.size > 0 || this.uncertain.size > 0;
  }
  list(): Promise<readonly SavedCredentialMetadata[]> {
    this.admitRead();
    return this.track(this.port().list());
  }
  create(
    commandId: string,
    generation: string,
    input: CreateSavedCredentialInput,
  ): Promise<CredentialCommandReceipt> {
    this.admit(commandId, generation);
    const parsed = createSavedCredentialSchema.safeParse(input);
    if (!parsed.success) throw new CredentialWorkflowError('invalid-input');
    const ref = 'cred_' + randomUUID();
    const port = this.port();
    const normalized = commandId.toLowerCase();
    this.store.reserve(normalized, 'create', ref, {
      kind: parsed.data.kind,
      label: parsed.data.label,
    });
    return this.execute(normalized, () =>
      port.createAt(ref, parsed.data, { generation: this.generation, commandId: normalized }),
    );
  }
  createFromGrant(
    commandId: string,
    generation: string,
    input: CreateGrantedCredentialInput,
    reader: CredentialFileReader,
    caller?: AbortSignal,
  ): Promise<CredentialCommandReceipt> {
    this.admit(commandId, generation);
    const parsed = createGrantedCredentialSchema.safeParse(input);
    if (!parsed.success) throw new CredentialWorkflowError('invalid-input');
    const signal = AbortSignal.any([this.lifetime.signal, ...(caller ? [caller] : [])]);
    if (signal.aborted) throw new CredentialWorkflowError('closed');
    const normalized = commandId.toLowerCase(),
      ref = 'cred_' + randomUUID(),
      port = this.port();
    this.store.reserve(normalized, 'create', ref, {
      kind: parsed.data.kind,
      label: parsed.data.label,
    });
    return this.execute(normalized, async () => {
      let secret: CreateSavedCredentialInput;
      try {
        signal.throwIfAborted();
        const content = await reader(parsed.data.grantId, 131072, signal);
        signal.throwIfAborted();
        secret = createSavedCredentialSchema.parse({
          kind: parsed.data.kind,
          label: parsed.data.label,
          secret: content,
        });
        if (new TextEncoder().encode(secret.secret).byteLength > 131072)
          throw new Error('CREDENTIAL_FILE_TOO_LARGE');
      } catch {
        throw new CredentialPreparationError(signal.aborted ? 'closed' : 'invalid-input');
      }
      return port.createAt(ref, secret, { generation: this.generation, commandId: normalized });
    });
  }
  replace(
    commandId: string,
    generation: string,
    ref: string,
    secret: string,
  ): Promise<CredentialCommandReceipt> {
    this.admit(commandId, generation);
    const parsed = replaceSavedCredentialSchema.safeParse({ secret });
    if (!parsed.success || !savedCredentialRefSchema.safeParse(ref).success)
      throw new CredentialWorkflowError('invalid-input');
    const normalized = commandId.toLowerCase();
    const port = this.port();
    this.store.reserve(normalized, 'replace', ref, {});
    return this.execute(normalized, () =>
      port.replace(ref, parsed.data.secret, { generation: this.generation, commandId: normalized }),
    );
  }
  remove(commandId: string, generation: string, ref: string): Promise<CredentialCommandReceipt> {
    this.admit(commandId, generation);
    if (!savedCredentialRefSchema.safeParse(ref).success)
      throw new CredentialWorkflowError('invalid-input');
    const normalized = commandId.toLowerCase();
    const port = this.port();
    this.store.reserve(normalized, 'delete', ref, {});
    return this.execute(normalized, async () => {
      await port.remove(ref);
      return undefined;
    });
  }
  outcome(commandId: string): Promise<CredentialCommandReceipt> {
    this.admitRead();
    return this.track(this.readOutcome(commandId));
  }
  removeOwned(
    commandId: string,
    generation: string,
    ref: string,
    expected: CredentialMutationMarker,
  ): Promise<CredentialCommandReceipt> {
    this.admit(commandId, generation);
    if (!savedCredentialRefSchema.safeParse(ref).success)
      throw new CredentialWorkflowError('invalid-input');
    const normalized = commandId.toLowerCase(),
      port = this.port();
    if (!port.removeOwned) throw new CredentialWorkflowError('unavailable');
    this.store.reserve(normalized, 'delete', ref, {});
    return this.execute(normalized, async () => {
      await port.removeOwned!(ref, expected);
      return undefined;
    });
  }
  /** Only the proof-scoped temporary-token owner uses observable absence to settle its own deletion. */
  confirmOwnedRemoval(commandId: string, generation: string, ref: string): Promise<boolean> {
    this.admit(commandId, generation);
    return this.track(
      (async () => {
        const intent = this.store.get(commandId);
        if (
          !intent ||
          intent.operation !== 'delete' ||
          intent.generation !== generation ||
          intent.ref !== ref
        )
          return false;
        if (await this.port().inspect(ref)) return false;
        this.store.finish(commandId, 'completed');
        this.uncertain.delete(commandId);
        return true;
      })(),
    );
  }
  private async readOutcome(commandId: string): Promise<CredentialCommandReceipt> {
    if (!z.uuid().safeParse(commandId).success) throw new CredentialWorkflowError('invalid-input');
    const id = commandId.toLowerCase();
    const intent = this.store.get(id);
    if (!intent) throw new CredentialWorkflowError('not-found');
    if (
      (intent.status === 'uncertain' ||
        intent.status === 'interrupted' ||
        (intent.status === 'running' && this.uncertain.has(id))) &&
      intent.operation !== 'delete'
    ) {
      const current = await this.port().inspect(intent.ref);
      if (
        current?.mutation?.generation === intent.generation &&
        current.mutation.commandId === id
      ) {
        const result = this.store.finish(id, 'completed', current.metadata);
        this.uncertain.delete(id);
        return result;
      }
    }
    const { descriptor: _descriptor, ...receipt } = intent;
    return receipt;
  }
  close(): Promise<void> {
    this.accepting = false;
    this.lifetime.abort();
    return (this.closing ??= Promise.resolve().then(async () => {
      await Promise.allSettled([...this.pending]);
      if (this.uncertain.size) throw new CredentialWorkflowError('uncertain');
    }));
  }
  private admit(commandId: string, generation: string): void {
    this.assertOpen();
    if (generation !== this.generation) throw new CredentialWorkflowError('stale-generation');
    if (!z.uuid().safeParse(commandId).success) throw new CredentialWorkflowError('invalid-input');
    if (this.pending.size >= 32) throw new CredentialWorkflowError('capacity');
  }
  private admitRead(): void {
    this.assertOpen();
    if (this.pending.size >= 32) throw new CredentialWorkflowError('capacity');
  }
  private port(): SavedCredentialsService {
    const port = this.provider();
    if (!port) throw new CredentialWorkflowError('unavailable');
    return port;
  }
  private assertOpen(): void {
    if (!this.accepting) throw new CredentialWorkflowError('closed');
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  private execute(
    commandId: string,
    perform: () => Promise<SavedCredentialMetadata | undefined>,
  ): Promise<CredentialCommandReceipt> {
    const task = Promise.resolve().then(async () => {
      try {
        const metadata = await perform();
        try {
          return this.store.finish(commandId, 'completed', metadata);
        } catch {
          this.uncertain.add(commandId);
          throw new CredentialWorkflowError('uncertain');
        }
      } catch (error) {
        if (error instanceof CredentialWorkflowError) {
          this.uncertain.add(commandId);
          throw error;
        }
        let definite = false;
        let reason: CredentialCommandFailure = 'uncertain';
        if (error instanceof CredentialPreparationError) {
          definite = true;
          reason = error.reason;
        } else if (
          error instanceof SavedCredentialStorageError &&
          ['invalid', 'not-found', 'conflict'].includes(error.code)
        ) {
          definite = true;
          reason =
            error.code === 'invalid'
              ? 'invalid-input'
              : error.code === 'not-found'
                ? 'not-found'
                : 'conflict';
        }
        if (!definite) this.uncertain.add(commandId);
        try {
          const result = this.store.finish(
            commandId,
            definite ? 'failed' : 'uncertain',
            undefined,
            reason,
          );
          if (result.status === 'completed') this.uncertain.delete(commandId);
          return result;
        } catch {
          this.uncertain.add(commandId);
          throw new CredentialWorkflowError('uncertain');
        }
      }
    });
    return this.track(task);
  }
}
