import type { FileGrantActions } from '@axterm/plugin-api/files';
import { remoteErrorOf } from '@axterm/plugin-api';
import { createConnectionSchema } from '@axterm/plugin-api/connections';
import { sshStartupIntent } from './ssh-startup.ts';
import type { Host } from '@axterm/plugin-api/catalog';
import type {
  ConnectionWorkspaceUi,
  TerminalWorkspaceUi,
  AutomationWorkspaceUi,
} from '@axterm/ui/workspace';
import type { CatalogModel } from '../../index.ts';
import type { CatalogEditorOwner } from '../editor/owner.ts';
import type { QuickConnectTarget } from './parser.ts';
interface SessionActionState {
  readonly busy: boolean;
  readonly failed: boolean;
  readonly cleanupPending?: boolean;
}
/** Explicit transient admissions. IO reconciliation and actual resources remain with their owners. */
export class NewSessionActions {
  private state: SessionActionState = { busy: false, failed: false };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private pending: Promise<boolean> | undefined;
  private closing: Promise<void> | undefined;
  private readonly automationWaiters = new Set<() => void>();
  private automation: AutomationWorkspaceUi | undefined;
  private fileGrants: FileGrantActions | undefined;
  private readonly localGrants = new Map<string, { generation: string; owner: FileGrantActions }>();
  private reconciling: Promise<void> | undefined;
  attachAutomation(owner: AutomationWorkspaceUi): () => void {
    if (this.automation) throw Error('SESSION_AUTOMATION_DUPLICATE');
    this.automation = owner;
    for (const wake of this.automationWaiters) wake();
    return () => {
      if (this.automation === owner) this.automation = undefined;
    };
  }
  attachFileGrants(owner: FileGrantActions): () => void {
    if (this.fileGrants) throw Error('SESSION_FILES_OWNER_DUPLICATE');
    this.fileGrants = owner;
    return () => {
      if (this.fileGrants === owner) this.fileGrants = undefined;
    };
  }
  private waitAutomation(signal: AbortSignal): Promise<AutomationWorkspaceUi> {
    signal.throwIfAborted();
    if (this.automation) return Promise.resolve(this.automation);
    return new Promise((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer);
        this.automationWaiters.delete(check);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(this.automation!);
      };
      const check = () => {
        if (this.automation) done();
      };
      const abort = () => done(Error('AUTOMATION_ADMISSION_CANCELLED'));
      const timer = setTimeout(() => done(Error('AUTOMATION_UI_UNAVAILABLE')), 10000);
      this.automationWaiters.add(check);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else check();
    });
  }
  retryCleanup(): Promise<void> {
    if (this.closing) return Promise.reject(Error('NEW_SESSION_CLOSED'));
    return (this.reconciling ??= (async () => {
      const outcomes = await Promise.allSettled(
        [...this.localGrants.keys()].map((id) => this.releaseDirectory(id)),
      );
      this.publish({ ...this.state, failed: this.localGrants.size > 0 });
      if (outcomes.some((result) => result.status === 'rejected') || this.localGrants.size)
        throw Error('SESSION_DIRECTORY_UNDRAINED');
    })().finally(() => {
      this.reconciling = undefined;
    }));
  }
  private async withDirectory<T>(
    id: string | undefined,
    perform: () => Promise<T>,
    handoff = false,
  ): Promise<T> {
    if (!id) return perform();
    const owner = this.fileGrants,
      facts = this.model.getSnapshot();
    if (!owner || facts.status !== 'ready') throw Error('SESSION_FILES_UNAVAILABLE');
    this.localGrants.set(id, { generation: facts.baseline.generation, owner });
    let accepted = false;
    try {
      const result = await perform();
      accepted = handoff;
      return result;
    } finally {
      if (accepted) this.localGrants.delete(id);
      else await this.releaseDirectory(id);
    }
  }
  private async releaseDirectory(id: string): Promise<void> {
    const owned = this.localGrants.get(id);
    if (!owned) return;
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') throw Error('SESSION_DIRECTORY_UNCERTAIN');
    if (state.baseline.generation !== owned.generation)
      throw Error('SESSION_DIRECTORY_GENERATION_CHANGED');
    if (!owned.owner.revokeInGeneration) throw Error('SESSION_DIRECTORY_FENCING_UNAVAILABLE');
    try {
      await owned.owner.revokeInGeneration(id, owned.generation);
    } catch (error) {
      const marked = remoteErrorOf(error),
        current = this.model.getSnapshot();
      if (
        marked?.code !== 'files/failure' ||
        marked.details.reason !== 'not-found' ||
        current.status !== 'ready' ||
        current.baseline.generation !== owned.generation
      )
        throw error;
    }
    this.localGrants.delete(id);
  }
  constructor(
    private readonly model: Pick<CatalogModel, 'getSnapshot'>,
    private readonly connections: ConnectionWorkspaceUi,
    private readonly terminals: TerminalWorkspaceUi,
    private readonly editor: Pick<CatalogEditorOwner, 'openQuickConnect'>,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  host(host: Host, profileId?: string) {
    const id = host.id;
    return this.admit(() =>
      this.connections.openSsh(
        { hostId: id },
        { signal: this.lifetime.signal, terminal: profileId ? { profileId } : {} },
      ),
    );
  }
  launch(target: QuickConnectTarget, profileId?: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    const owned = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    if (this.closing || this.pending) return Promise.resolve(false);
    const captured = structuredClone(target);
    if (captured.protocol !== 'ssh' && captured.protocol !== 'local')
      return this.admit(async () => {
        if (!this.editor.openQuickConnect(captured)) throw Error('SESSION_EDITOR_UNAVAILABLE');
      });
    if (captured.protocol === 'local') {
      // Batch operations require the Automation-owned workflow, not terminal command injection.
      if (captured.batchOperationGrantId)
        return this.admit(() =>
          this.withDirectory(
            captured.batchOperationGrantId,
            async () => {
              const automation = await this.waitAutomation(owned),
                facts = this.model.getSnapshot();
              if (facts.status !== 'ready') throw Error('AUTOMATION_NOT_READY');
              const task = automation.runBatchGrant(
                captured.batchOperationGrantId!,
                facts.baseline.generation,
                owned,
              );
              // A returned promise means the selected owner synchronously accepted the input grant.
              this.localGrants.delete(captured.batchOperationGrantId!);
              await task;
            },
            true,
          ),
        );
      return this.admit(() =>
        this.withDirectory(captured.initialDirectoryGrantId, () =>
          this.terminals.open(
            {
              kind: 'local',
              cols: 160,
              rows: 80,
              ...(profileId ? { profileId } : {}),
              ...(captured.initialDirectoryGrantId
                ? {
                    workingDirectory: {
                      scope: 'local',
                      grantId: captured.initialDirectoryGrantId,
                      path: '',
                    } as const,
                  }
                : {}),
            },
            owned,
            ...(captured.title ? [{ title: captured.title }] : []),
          ),
        ),
      );
    }
    if (!captured.enableSsh && !captured.enableSftp) return this.unavailable();
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') return this.unavailable();
    let startup: ReturnType<typeof sshStartupIntent>;
    try {
      startup = sshStartupIntent(captured, state.baseline);
    } catch {
      return this.unavailable();
    }
    const known = captured.credentialGrantId
      ? undefined
      : state.baseline.hosts.find(
          (host) =>
            host.hostname === captured.hostname &&
            host.port === captured.port &&
            (!captured.username || host.username === captured.username),
        );
    const parsed = createConnectionSchema.safeParse({
      ...(startup.hops.length ? { hops: startup.hops } : {}),
      ...(known
        ? { hostId: known.id }
        : {
            target: {
              name: captured.title ?? captured.hostname,
              hostname: captured.hostname,
              port: captured.port,
              username: captured.username ?? 'root',
              authType: captured.credentialGrantId
                ? 'privateKey'
                : captured.temporarySecret
                  ? 'password'
                  : captured.authType,
            },
          }),
      ...(captured.temporarySecret ? { temporarySecret: captured.temporarySecret } : {}),
      ...(captured.temporaryPassphrase
        ? { temporaryPassphrase: captured.temporaryPassphrase }
        : {}),
      ...(captured.credentialGrantId
        ? { temporaryCredentialGrantId: captured.credentialGrantId }
        : {}),
    });
    if (!parsed.success) return this.unavailable();
    const input = parsed.data;
    const filesView = {
      ...(captured.title ? { title: captured.title } : {}),
      ...(captured.initialDirectoryGrantId
        ? { initialDirectoryGrantId: captured.initialDirectoryGrantId }
        : {}),
    };
    return this.admit(() =>
      this.withDirectory(
        captured.initialDirectoryGrantId,
        () =>
          this.connections.openSsh(input, {
            signal: owned,
            ...(startup.tunnels.length ? { tunnels: startup.tunnels } : {}),
            ...(!captured.enableSsh
              ? { filesOnly: filesView }
              : captured.initialDirectoryGrantId
                ? { filesAfterTerminal: filesView }
                : {}),
            terminal: {
              ...(captured.title ? { title: captured.title } : {}),
              ...(profileId ? { profileId } : {}),
              ...(captured.environment ? { environment: { ...captured.environment } } : {}),
            },
          }),
        true,
      ),
    );
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await this.pending;
      await this.reconciling;
      await Promise.allSettled([...this.localGrants.keys()].map((id) => this.releaseDirectory(id)));
      this.listeners.clear();
      if (this.localGrants.size) throw Error('SESSION_DIRECTORY_UNDRAINED');
    })());
  }
  private admit(invoke: () => Promise<unknown>): Promise<boolean> {
    if (this.closing || this.pending || this.localGrants.size || this.reconciling)
      return Promise.resolve(false);
    const initial = this.model.getSnapshot();
    if (initial.status !== 'ready') return this.unavailable();
    const generation = initial.baseline.generation;
    this.publish({ busy: true, failed: false });
    const pending = Promise.resolve()
      .then(async () => {
        this.lifetime.signal.throwIfAborted();
        const current = this.model.getSnapshot();
        if (current.status !== 'ready' || current.baseline.generation !== generation)
          throw new Error('NEW_SESSION_GENERATION_CHANGED');
        await invoke();
        this.lifetime.signal.throwIfAborted();
        const accepted = this.model.getSnapshot();
        if (accepted.status !== 'ready' || accepted.baseline.generation !== generation)
          throw Error('NEW_SESSION_GENERATION_CHANGED');
        return true;
      })
      .catch(() => false)
      .then((accepted) => {
        this.publish({ busy: false, failed: !accepted });
        return accepted;
      });
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      })
      .catch(() => {});
    return pending;
  }
  private unavailable(): Promise<boolean> {
    this.publish({ busy: false, failed: true });
    return Promise.resolve(false);
  }
  private publish(state: SessionActionState) {
    this.state = Object.freeze({ ...state, cleanupPending: this.localGrants.size > 0 });
    if (!this.closing)
      for (const listener of this.listeners) {
        try {
          listener();
        } catch {
          console.warn('NEW_SESSION_OBSERVER_FAILED');
        }
      }
  }
}
