import { remoteErrorOf } from '@axterm/plugin-api';
import type { FileGrant, FileGrantActions } from '@axterm/plugin-api/files';
import type { TerminalBackgroundMetadata } from '@axterm/plugin-api/terminals';
import type { TerminalAssetsModel } from '../assets.ts';
type Model = Pick<TerminalAssetsModel, 'getSnapshot' | 'importAsset' | 'deleteAsset'>;
interface ImportIntent {
  generation: string;
  key: string;
  requested: boolean;
  grant?: FileGrant;
  revoked: boolean;
  started: boolean;
  imported?: TerminalBackgroundMetadata;
}
interface Asset {
  generation: string;
  metadata: TerminalBackgroundMetadata;
  deleteKey: string;
  protected: boolean;
}
/** One picker admission plus at most two unapplied imports; ownership survives late/unknown completion. */
export class TerminalThemeAssetPicker {
  private readonly lifetime = new AbortController();
  private intent: ImportIntent | undefined;
  private readonly owned = new Map<string, Asset>();
  private pending: Promise<unknown> | undefined;
  private closing: Promise<void> | undefined;
  private resetting: Promise<void> | undefined;
  hasPendingIntent(): boolean {
    return !!this.intent;
  }
  constructor(
    private readonly model: Model,
    private readonly grants: FileGrantActions,
  ) {
    if (!grants.revokeInGeneration) throw Error('TERMINAL_THEME_GRANT_CAPABILITY_MISSING');
  }
  choose(signal?: AbortSignal): Promise<TerminalBackgroundMetadata | undefined> {
    if (
      this.lifetime.signal.aborted ||
      this.pending ||
      this.resetting ||
      this.intent ||
      this.owned.size >= 2
    )
      throw Error('TERMINAL_THEME_ASSET_BUSY');
    signal?.throwIfAborted();
    const generation = this.generation();
    this.intent = {
      generation,
      key: crypto.randomUUID(),
      requested: false,
      revoked: false,
      started: false,
    };
    return this.start(
      this.intent,
      AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
    );
  }
  retry(signal?: AbortSignal): Promise<TerminalBackgroundMetadata | undefined> {
    if (this.lifetime.signal.aborted || this.pending || this.resetting || !this.intent)
      throw Error('TERMINAL_THEME_ASSET_NOT_UNCERTAIN');
    return this.start(
      this.intent,
      AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
    );
  }
  protect(id: string | null): (accepted: boolean) => void {
    const asset = id ? this.owned.get(id) : undefined;
    if (!asset) return () => {};
    asset.protected = true;
    return (accepted) => {
      if (this.owned.get(id!) !== asset) return;
      if (accepted) this.owned.delete(id!);
      else asset.protected = false;
    };
  }
  commit(id: string | null): void {
    if (id) this.owned.delete(id);
  }
  discard(id: string): Promise<void> {
    if (this.pending) return Promise.reject(Error('TERMINAL_THEME_ASSET_BUSY'));
    const task = this.remove(id);
    this.pending = task;
    void task.then(
      () => {
        if (this.pending === task) this.pending = undefined;
      },
      () => {
        if (this.pending === task) this.pending = undefined;
      },
    );
    return task;
  }
  /** Reset a closing editor; never forget cleanup that failed or a write whose outcome is unknown. */
  reset(): Promise<void> {
    if (this.resetting) return this.resetting;
    const task = this.resetOwned();
    this.resetting = task;
    void task.then(
      () => {
        if (this.resetting === task) this.resetting = undefined;
      },
      () => {
        if (this.resetting === task) this.resetting = undefined;
      },
    );
    return task;
  }
  private async resetOwned(): Promise<void> {
    await this.pending?.catch(() => {});
    if (this.intent) {
      const current = this.model.getSnapshot();
      if (current.status === 'ready' && current.baseline.generation !== this.intent.generation)
        this.intent = undefined;
      else await this.start(this.intent, new AbortController().signal, true);
    }
    const settled = await Promise.allSettled([...this.owned.keys()].map((id) => this.remove(id)));
    if (this.intent || this.owned.size || settled.some((item) => item.status === 'rejected'))
      throw Error('TERMINAL_THEME_ASSET_DRAIN_FAILED');
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    const task = this.reset();
    this.closing = task;
    void task.catch(() => {
      if (this.closing === task) this.closing = undefined;
    });
    return task;
  }
  private start(
    intent: ImportIntent,
    signal: AbortSignal,
    reconcile = false,
  ): Promise<TerminalBackgroundMetadata | undefined> {
    const task = this.execute(intent, signal, reconcile);
    this.pending = task;
    void task.then(
      () => {
        if (this.pending === task) this.pending = undefined;
      },
      () => {
        if (this.pending === task) this.pending = undefined;
      },
    );
    return task;
  }
  private async execute(
    intent: ImportIntent,
    signal: AbortSignal,
    reconcile: boolean,
  ): Promise<TerminalBackgroundMetadata | undefined> {
    let error: unknown,
      unknown = false;
    try {
      if (this.generation() !== intent.generation) {
        this.intent = undefined;
        throw Error('TERMINAL_THEME_ASSET_RETIRED');
      }
      if (!intent.requested) {
        signal.throwIfAborted();
        intent.requested = true;
        const grant = await this.grants.create({ kind: 'open-file' }, signal);
        if (!grant) {
          this.intent = undefined;
          return;
        }
        intent.grant = grant;
      }
      if (!intent.grant) throw Error('TERMINAL_THEME_ASSET_GRANT_OUTCOME_UNCERTAIN');
      if (!intent.imported) {
        if (!reconcile) signal.throwIfAborted();
        intent.started = true;
        const receipt = await this.model.importAsset(
          intent.key,
          intent.grant.grantId,
          intent.generation,
        );
        intent.imported = Object.freeze(structuredClone(receipt.asset));
        this.owned.set(receipt.asset.id, {
          generation: intent.generation,
          metadata: intent.imported,
          deleteKey: crypto.randomUUID(),
          protected: false,
        });
      }
    } catch (cause) {
      error = cause;
      unknown =
        (!intent.grant && intent.requested && !definite(cause)) ||
        (intent.started && !intent.imported && !definite(cause));
    }
    try {
      if (intent.grant && !intent.revoked) {
        await this.grants.revokeInGeneration!(intent.grant.grantId, intent.generation);
        intent.revoked = true;
      }
    } catch (cause) {
      error ??= cause;
      unknown = true;
    }
    if (!unknown && this.intent === intent) this.intent = undefined;
    if (error) throw error;
    if (intent.imported && (signal.aborted || reconcile)) {
      await this.remove(intent.imported.id);
      if (signal.aborted) signal.throwIfAborted();
      return;
    }
    return intent.imported;
  }
  private generation(): string {
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') throw Error('TERMINAL_THEME_ASSETS_NOT_READY');
    return state.baseline.generation;
  }
  private async remove(id: string): Promise<void> {
    const asset = this.owned.get(id);
    if (!asset) return;
    const current = this.model.getSnapshot();
    if (current.status === 'ready' && current.baseline.generation !== asset.generation) {
      this.owned.delete(id);
      return;
    }
    if (asset.protected) throw Error('TERMINAL_THEME_APPLICATION_OUTCOME_UNCERTAIN');
    await this.model.deleteAsset(asset.deleteKey, id, asset.metadata.version, asset.generation);
    if (this.owned.get(id) === asset) this.owned.delete(id);
  }
}
function definite(error: unknown): boolean {
  const marked = remoteErrorOf(error);
  return (
    !!marked &&
    (marked.code === 'terminals/failure' || marked.code === 'files/failure') &&
    [
      'invalid-input',
      'not-found',
      'forbidden',
      'stale',
      'closed',
      'cancelled',
      'capacity',
      'conflict',
      'receipt-expired',
      'precondition-required',
      'precondition-failed',
    ].includes(marked.details.reason)
  );
}
