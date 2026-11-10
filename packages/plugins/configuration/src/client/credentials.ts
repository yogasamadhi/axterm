import type { Context } from '@deepseek-ai/cordis';
import {
  createSavedCredentialSchema,
  createGrantedCredentialSchema,
} from '@axterm/plugin-api/saved-credentials';
import type {
  CreateSavedCredentialInput,
  CreateGrantedCredentialInput,
  CredentialSubmission,
  CredentialCommandReceipt,
  SavedCredentialsBaseline,
  SavedCredentialsUpdate,
} from '@axterm/plugin-api/saved-credentials';
import { RemoteStreamCarrierError, type RemoteStream } from '@axterm/infra-gateway/client';
import { SavedCredentialsProjection } from './credential-projection.ts';
export type SavedCredentialsState =
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly baseline: SavedCredentialsBaseline }
  | { readonly status: 'error'; readonly message: string };
/** Owns only metadata. Secret commands are submitted once; uncertain results use readonly queries. */
export class SavedCredentialsModel {
  private state: SavedCredentialsState = { status: 'connecting' };
  private readonly listeners = new Set<() => void>();
  private readonly commands = new Set<Promise<unknown>>();
  private stream: RemoteStream<SavedCredentialsUpdate>;
  private done: Promise<void>;
  private closing = false;
  private readonly lifetime = new AbortController();
  private disposed = false;
  private retrying: Promise<void> | undefined;
  constructor(private readonly ctx: Context) {
    this.stream = this.open();
    this.done = this.consume(this.stream);
  }
  getSnapshot = (): SavedCredentialsState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assertOpen();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  create(input: CreateSavedCredentialInput): CredentialSubmission {
    const captured = createSavedCredentialSchema.parse(input);
    return this.command((commandId, generation) =>
      this.ctx.remote.configuration.createCredential(commandId, generation, captured),
    );
  }
  createFromGrant(input: CreateGrantedCredentialInput, signal?: AbortSignal): CredentialSubmission {
    signal?.throwIfAborted();
    const captured = createGrantedCredentialSchema.parse(input);
    return this.command((commandId, generation) =>
      this.ctx.remote.configuration.importCredentialFromGrant(
        commandId,
        generation,
        captured,
        AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
      ),
    );
  }
  replace(ref: string, secret: string): CredentialSubmission {
    return this.command((commandId, generation) =>
      this.ctx.remote.configuration.replaceCredential(commandId, generation, ref, secret),
    );
  }
  remove(ref: string): CredentialSubmission {
    return this.command((commandId, generation) =>
      this.ctx.remote.configuration.deleteCredential(commandId, generation, ref),
    );
  }
  outcome(commandId: string): Promise<CredentialCommandReceipt> {
    this.admit();
    return this.track(
      (async () => {
        const result = await this.ctx.remote.configuration.getCredentialOutcome(commandId);
        if (!result.ok) throw result.error;
        return result.value;
      })(),
    );
  }
  private command(
    send: (
      commandId: string,
      generation: string,
    ) => ReturnType<Context['remote']['configuration']['createCredential']>,
  ): CredentialSubmission {
    this.admit();
    if (this.state.status !== 'ready') throw new Error('CREDENTIALS_UNAVAILABLE');
    const commandId = crypto.randomUUID();
    const generation = this.state.baseline.generation;
    const result = this.track(
      (async () => {
        const result = await send(commandId, generation);
        if (!result.ok) throw result.error;
        return result.value;
      })(),
    );
    // Intentionally retain no input or command retry closure in the model.
    return { commandId, generation, result };
  }
  retry(): Promise<void> {
    this.assertOpen();
    return (this.retrying ??= (async () => {
      await this.stream.dispose();
      await this.done;
      if (!this.closing) {
        this.stream = this.open();
        this.done = this.consume(this.stream);
      }
    })().finally(() => {
      this.retrying = undefined;
    }));
  }
  async dispose(): Promise<void> {
    this.closing = true;
    this.lifetime.abort();
    await Promise.allSettled([...this.commands]);
    this.disposed = true;
    await this.stream.dispose();
    await this.done;
    await this.retrying;
    this.listeners.clear();
  }
  private admit(): void {
    this.assertOpen();
    if (this.commands.size >= 32) throw new Error('CREDENTIALS_CAPACITY');
  }
  private assertOpen(): void {
    if (this.closing) throw new Error('CREDENTIALS_CLOSED');
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.commands.add(task);
    void task.then(
      () => this.commands.delete(task),
      () => this.commands.delete(task),
    );
    return task;
  }
  private open(): RemoteStream<SavedCredentialsUpdate> {
    return this.ctx.remote.$stream({
      name: 'configuration.credentials',
      open: (signal) => this.ctx.remote.configuration.watchCredentials(signal),
      ended: () => new RemoteStreamCarrierError('Credential generation ended'),
    });
  }
  private async consume(stream: RemoteStream<SavedCredentialsUpdate>): Promise<void> {
    const projection = new SavedCredentialsProjection();
    let generation = 0;
    try {
      for await (const item of stream) {
        if (generation !== item.generation) {
          generation = item.generation;
          projection.reset();
        }
        const baseline = projection.accept(item.value);
        if (baseline) {
          this.publish({ status: 'ready', baseline });
          item.accept();
        }
      }
    } catch {
      if (!this.disposed)
        this.publish({ status: 'error', message: 'Credential metadata is unavailable' });
    } finally {
      projection.reset();
    }
  }
  private publish(state: SavedCredentialsState): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('CREDENTIALS_OBSERVER_FAILED');
      }
    }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    savedCredentialsModel: SavedCredentialsModel;
  }
}
