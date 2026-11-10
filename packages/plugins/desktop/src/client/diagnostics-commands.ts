import { remoteErrorOf } from '@axterm/plugin-api';
import type { FileGrantActions } from '@axterm/plugin-api/files';
import type { DesktopDiagnosticExport, DesktopDiagnosticOutcome } from '@axterm/plugin-api/desktop';
interface Port {
  export(
    key: string,
    generation: string,
    grantId: string,
    signal: AbortSignal,
  ): Promise<DesktopDiagnosticExport>;
  outcome(key: string, generation: string): Promise<DesktopDiagnosticOutcome>;
  drain(key: string, generation: string): Promise<DesktopDiagnosticOutcome>;
}
interface Intent {
  key: string;
  generation: string;
  grantId?: string;
  attempted: boolean;
}
/** A single explicit picker/write. Unknown results query the original key; no automatic file rewrite. */
export class DiagnosticExportCommands {
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private intent: Intent | undefined;
  private pending: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private state: { busy: boolean; uncertain: boolean; result?: DesktopDiagnosticExport } = {
    busy: false,
    uncertain: false,
  };
  constructor(
    private readonly generation: () => string | undefined,
    private readonly files: FileGrantActions,
    private readonly port: Port,
  ) {
    if (!files.createInGeneration || !files.revokeInGeneration)
      throw Error('DIAGNOSTIC_FILE_AUTHORITY_UNAVAILABLE');
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  export(): Promise<void> {
    if (this.closing || this.pending || this.intent) throw Error('DIAGNOSTIC_EXPORT_BUSY');
    const generation = this.generation();
    if (!generation) throw Error('DIAGNOSTIC_EXPORT_NOT_READY');
    this.intent = { key: crypto.randomUUID(), generation, attempted: false };
    return this.run(async (intent) => {
      const grant = await this.files.createInGeneration!(
        { kind: 'save-file' },
        intent.generation,
        this.lifetime.signal,
      );
      if (!grant) {
        this.intent = undefined;
        return;
      }
      intent.grantId = grant.grantId;
      this.assertGeneration(intent);
      this.lifetime.signal.throwIfAborted();
      intent.attempted = true;
      const result = await this.port.export(
        intent.key,
        intent.generation,
        grant.grantId,
        this.lifetime.signal,
      );
      await this.finish(intent, result);
    });
  }
  retry(): Promise<void> {
    if (this.closing || this.pending || !this.intent)
      throw Error('DIAGNOSTIC_EXPORT_NOT_UNCERTAIN');
    return this.run(async (intent) => {
      this.assertGeneration(intent);
      if (!intent.grantId) throw Error('DIAGNOSTIC_PICKER_OUTCOME_UNCERTAIN');
      const outcome = await this.port.outcome(intent.key, intent.generation);
      if (outcome.phase === 'pending') throw Error('DIAGNOSTIC_EXPORT_PENDING');
      if (outcome.phase !== 'complete') await this.port.drain(intent.key, intent.generation);
      await this.finish(intent, outcome.phase === 'complete' ? outcome.result : undefined);
      if (outcome.phase !== 'complete') throw Error('DIAGNOSTIC_EXPORT_NOT_COMPLETED');
    });
  }
  private assertGeneration(intent: Intent): void {
    if (this.generation() !== intent.generation) throw Error('DIAGNOSTIC_EXPORT_RETIRED');
  }
  private run(work: (intent: Intent) => Promise<void>): Promise<void> {
    const intent = this.intent!;
    this.publish({ busy: true, uncertain: false });
    const task = Promise.resolve()
      .then(() => work(intent))
      .catch(async (error) => {
        const marked = remoteErrorOf(error);
        if (
          !intent.grantId &&
          marked?.code === 'files/failure' &&
          [
            'invalid-input',
            'unavailable',
            'closed',
            'capacity',
            'forbidden',
            'stale',
            'cancelled',
          ].includes(marked.details.reason)
        )
          this.intent = undefined;
        if (
          intent.grantId &&
          marked?.code === 'desktop/failure' &&
          ['invalid-input', 'stale', 'conflict', 'capacity', 'unavailable', 'closed'].includes(
            marked.details.reason,
          )
        ) {
          try {
            await this.finish(intent);
          } catch {
            this.publish({ busy: false, uncertain: true });
            throw Error('DIAGNOSTIC_EXPORT_FAILED');
          }
        }
        this.publish({ busy: false, uncertain: !!this.intent });
        throw Error('DIAGNOSTIC_EXPORT_FAILED');
      })
      .finally(() => {
        if (this.pending === task) this.pending = undefined;
        if (!this.intent) this.publish({ ...this.state, busy: false, uncertain: false });
      });
    this.pending = task;
    return task;
  }
  private async finish(intent: Intent, result?: DesktopDiagnosticExport): Promise<void> {
    if (intent.grantId) await this.files.revokeInGeneration!(intent.grantId, intent.generation);
    this.intent = undefined;
    this.publish({ busy: false, uncertain: false, ...(result ? { result } : {}) });
  }
  private publish(state: typeof this.state): void {
    if (this.closing) return;
    this.state = state;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        console.warn('DIAGNOSTIC_EXPORT_OBSERVER_FAILED');
      }
    }
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await this.pending?.catch(() => {});
      const intent = this.intent;
      if (intent) {
        if (!intent.grantId) throw Error('DIAGNOSTIC_PICKER_OUTCOME_UNCERTAIN');
        if (intent.attempted) await this.port.drain(intent.key, intent.generation);
        await this.files.revokeInGeneration!(intent.grantId, intent.generation);
        this.intent = undefined;
      }
      this.listeners.clear();
    })());
  }
}
