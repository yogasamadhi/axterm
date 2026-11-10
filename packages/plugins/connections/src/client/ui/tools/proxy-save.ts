import { remoteErrorOf } from '@axterm/plugin-api';
import {
  updateSettingsSchema,
  type ConfigurationClientActions,
  type Settings,
} from '@axterm/plugin-api/configuration';
import {
  createSavedCredentialSchema,
  type SavedCredentialActions,
  type CredentialSubmission,
} from '@axterm/plugin-api/saved-credentials';
interface State {
  readonly status: 'idle' | 'running' | 'saved' | 'failed' | 'uncertain';
  readonly credentialRetained: boolean;
}
export class ProxySave {
  private state: State = { status: 'idle', credentialRetained: false };
  private readonly listeners = new Set<() => void>();
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private draft:
    | {
        generation: string;
        key: string;
        etag: string;
        proxy: Settings['network']['proxy'];
        credential?: CredentialSubmission;
      }
    | undefined;
  constructor(
    private readonly settings: ConfigurationClientActions,
    private readonly vault: SavedCredentialActions,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  save(proxy: Settings['network']['proxy'], password: string, label: string): Promise<void> {
    if (this.closing || this.pending || this.state.status === 'uncertain')
      throw Error('PROXY_SAVE_BUSY');
    const state = this.settings.getSnapshot();
    if (state.status !== 'ready') throw Error('PROXY_NOT_READY');
    if (password && (proxy.mode !== 'custom' || !proxy.endpoint.username))
      throw Error('PROXY_USERNAME_REQUIRED');
    const input = structuredClone(proxy);
    const provisional =
      input.mode === 'custom' && !!password
        ? { ...input, endpoint: { ...input.endpoint, credentialRef: 'proxy-validation-only' } }
        : input;
    updateSettingsSchema.parse({ network: { proxy: provisional } });
    const secret = password
      ? createSavedCredentialSchema.parse({
          kind: 'proxyPassword',
          label: label.slice(0, 100),
          secret: password,
        })
      : undefined;
    this.draft = {
      generation: state.baseline.generation,
      key: crypto.randomUUID(),
      etag: '"v' + state.baseline.settings.version + '"',
      proxy: input,
    };
    if (secret) {
      try {
        this.draft.credential = this.vault.submitCreate(secret);
      } catch {
        this.draft = undefined;
        this.publish('failed');
        throw Error('PROXY_CREDENTIAL_SUBMISSION_FAILED');
      } finally {
        secret.secret = '';
      }
    }
    return this.run(false);
  }
  retry(): Promise<void> {
    if (this.closing || this.pending || this.state.status !== 'uncertain')
      throw Error('PROXY_SAVE_NOT_UNCERTAIN');
    return this.run(true);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      await this.pending?.catch(() => {});
      this.listeners.clear();
      if (this.state.status === 'uncertain' && !this.retire()) throw Error('PROXY_SAVE_UNDRAINED');
      this.draft = undefined;
    })());
  }
  private retire(): boolean {
    const current = this.settings.getSnapshot();
    if (
      this.draft &&
      current.status === 'ready' &&
      current.baseline.generation !== this.draft.generation
    ) {
      this.draft = undefined;
      this.publish('failed');
      return true;
    }
    return false;
  }
  private run(reconcile: boolean): Promise<void> {
    this.publish('running');
    const task = this.advance(reconcile).catch((error) => {
      const marked = remoteErrorOf(error);
      if (
        marked?.code === 'configuration/failure' &&
        [
          'invalid-input',
          'precondition-failed',
          'precondition-required',
          'conflict',
          'closed',
        ].includes(marked.details.reason)
      ) {
        this.draft = undefined;
        this.publish('failed');
      } else this.publish('uncertain');
    });
    this.pending = task;
    void task
      .finally(() => {
        if (this.pending === task) this.pending = undefined;
      })
      .catch(() => {});
    return task;
  }
  private async advance(reconcile: boolean) {
    if (this.retire()) return;
    const draft = this.draft!,
      current = this.settings.getSnapshot();
    if (!draft || current.status !== 'ready' || current.baseline.generation !== draft.generation) {
      this.publish('uncertain');
      return;
    }
    if (draft.credential) {
      const submitted = draft.credential;
      const receipt = await (reconcile
        ? this.vault.outcome(submitted.commandId)
        : submitted.result);
      if (
        receipt.commandId !== submitted.commandId ||
        receipt.generation !== draft.generation ||
        submitted.generation !== draft.generation ||
        receipt.operation !== 'create'
      ) {
        this.publish('uncertain');
        return;
      }
      if (receipt.status !== 'completed') {
        if (['failed', 'expired', 'interrupted'].includes(receipt.status)) {
          this.draft = undefined;
          this.publish('failed');
        } else this.publish('uncertain');
        return;
      }
      this.state = { ...this.state, credentialRetained: true };
      if (draft.proxy.mode !== 'custom') throw Error('PROXY_DRAFT_INVALID');
      draft.proxy.endpoint.credentialRef = receipt.ref;
      delete draft.credential;
    }
    if (this.retire()) return;
    const before = this.settings.getSnapshot();
    if (before.status !== 'ready' || before.baseline.generation !== draft.generation) {
      this.publish('uncertain');
      return;
    }
    await this.settings.setNetworkProxy(draft.key, draft.proxy, draft.etag);
    if (this.retire()) return;
    this.draft = undefined;
    this.publish('saved');
  }
  private publish(status: State['status']) {
    this.state = Object.freeze({ ...this.state, status });
    if (!this.closing)
      for (const fn of this.listeners) {
        try {
          fn();
        } catch {
          console.warn('PROXY_SAVE_OBSERVER_FAILED');
        }
      }
  }
}
