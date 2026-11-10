import { sshOperationDiagnosticSchema } from '@axterm/plugin-api/catalog';
import { RemoteError, remoteErrorOf } from '@axterm/plugin-api';
import { tunnelProfileInputSchema } from '@axterm/plugin-api/connections';
import type {
  CreateConnectionInput,
  ReconnectConnectionHistoryInput,
  Connection,
} from '@axterm/plugin-api/connections';
import type {
  TerminalWorkspaceUi,
  SshTerminalOptions,
  SshFilesViewOptions,
  FilesWorkspaceUi,
  SshStartupTunnel,
  TunnelWorkspaceUi,
} from '@axterm/ui/workspace';
import type { ConnectionsModel } from '../index.ts';
type Model = Pick<
  ConnectionsModel,
  | 'getConnectionCommandOutcome'
  | 'createConnection'
  | 'reconnectConnectionHistory'
  | 'closeConnection'
  | 'getSnapshot'
  | 'subscribe'
>;
/** SSH launch only; each domain still owns its facts, transport and actual resources. */
export class ConnectionWorkspaceAdmissions {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<string>>();
  private readonly rollback = new Map<string, string>();
  private readonly uncertain = new Map<string, string>();
  private closing: Promise<void> | undefined;
  private readonly readyTimeoutMs: number;
  private files: FilesWorkspaceUi | undefined;
  attachFiles(files: FilesWorkspaceUi): () => void {
    if (this.files) throw Error('CONNECTION_FILES_OWNER_DUPLICATE');
    this.files = files;
    return () => {
      if (this.files === files) this.files = undefined;
    };
  }
  constructor(
    private readonly model: Model,
    private readonly terminals: TerminalWorkspaceUi,
    private readonly tunnels?: TunnelWorkspaceUi,
    options: { readonly readyTimeoutMs?: number } = {},
  ) {
    const timeout = options.readyTimeoutMs ?? 120000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000)
      throw Error('CONNECTION_WAIT_BUDGET_INVALID');
    this.readyTimeoutMs = timeout;
  }
  openSsh(
    input: CreateConnectionInput,
    signal?: AbortSignal,
    terminal?: SshTerminalOptions,
    filesOnly?: SshFilesViewOptions,
    filesAfterTerminal?: SshFilesViewOptions,
    startupTunnels?: readonly SshStartupTunnel[],
  ): Promise<string> {
    if (filesOnly && filesAfterTerminal) return Promise.reject(Error('CONNECTION_VIEW_CONFLICT'));
    let tunnelProfiles: readonly SshStartupTunnel[] | undefined;
    try {
      if (startupTunnels?.length) {
        if (!this.tunnels || startupTunnels.length > 8)
          throw Error('CONNECTION_TUNNEL_OWNER_UNAVAILABLE');
        tunnelProfiles = startupTunnels.map((value) => {
          const { hostId: _host, ...profile } = tunnelProfileInputSchema.parse({
            ...value,
            hostId: crypto.randomUUID(),
          });
          return profile;
        });
      }
    } catch {
      return Promise.reject(Error('CONNECTION_STARTUP_TUNNELS_INVALID'));
    }
    const request = structuredClone(input);
    const selectedView = filesOnly ?? filesAfterTerminal;
    const view = selectedView === undefined ? undefined : structuredClone(selectedView);
    if (view && !this.files) return Promise.reject(Error('CONNECTION_FILES_OWNER_MISSING'));
    return this.admit(
      (key) => this.model.createConnection(key, request),
      signal,
      terminal,
      view,
      request,
      filesAfterTerminal !== undefined,
      tunnelProfiles,
    );
  }
  openHistory(
    id: string,
    input: ReconnectConnectionHistoryInput,
    ifMatch: string | undefined,
    signal?: AbortSignal,
    terminal?: SshTerminalOptions,
  ): Promise<string> {
    const request = structuredClone(input);
    return this.admit(
      (key) => this.model.reconnectConnectionHistory(key, id, request, ifMatch),
      signal,
      terminal,
    );
  }
  private admit(
    create: (key: string) => Promise<Connection>,
    signal?: AbortSignal,
    terminal?: SshTerminalOptions,
    filesOnly?: SshFilesViewOptions,
    reuse?: CreateConnectionInput,
    terminalBeforeFiles = false,
    startupTunnels?: readonly SshStartupTunnel[],
  ): Promise<string> {
    if (this.closing) return Promise.reject(new Error('CONNECTION_WORKSPACE_CLOSED'));
    if (this.pending.size + this.rollback.size + this.uncertain.size >= 8)
      return Promise.reject(new Error('CONNECTION_WORKSPACE_CAPACITY'));
    const initial = this.model.getSnapshot();
    if (initial.status !== 'ready')
      return Promise.reject(new Error('CONNECTION_WORKSPACE_UNAVAILABLE'));
    const generation = initial.baseline.generation;
    const { title, ...terminalRequest } = structuredClone(terminal ?? {});
    const filesOwner = filesOnly ? this.files : undefined;
    const key = crypto.randomUUID();
    const owned = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const task = Promise.resolve().then(async () => {
      owned.throwIfAborted();
      const current = this.model.getSnapshot();
      if (current.status !== 'ready' || current.baseline.generation !== generation)
        throw new Error('CONNECTION_WORKSPACE_RETIRED');
      const borrowed =
        !startupTunnels?.length &&
        !reuse?.hops?.length &&
        reuse?.hostId &&
        !reuse.temporarySecret &&
        !reuse.temporaryPassphrase &&
        !reuse.temporaryCredentialGrantId
          ? current.baseline.connections.find(
              (value) =>
                value.state === 'ready' &&
                value.hostId === reuse.hostId &&
                value.connectionProfileId === reuse.connectionProfileId,
            )
          : undefined;
      let connection: Connection;
      try {
        connection = borrowed ?? (await create(key));
      } catch (error) {
        const marked = remoteErrorOf(error);
        const definite =
          marked?.code === 'connections/failure' &&
          [
            'invalid-input',
            'not-found',
            'capacity',
            'closed',
            'cancelled',
            'conflict',
            'stale',
            'precondition-required',
            'precondition-failed',
          ].includes(marked.details.reason);
        if (!definite) {
          this.uncertain.set(key, generation);
          try {
            await this.resolveUncertain(key, generation);
          } catch {
            /* Retain ownership while the actual outcome is unknown. */
          }
        }
        throw error;
      }
      if (!borrowed) this.rollback.set(connection.id, generation);
      try {
        await this.ready(connection.id, generation, owned, key);
        owned.throwIfAborted();
        for (const profile of startupTunnels ?? []) {
          const state = this.model.getSnapshot();
          if (state.status !== 'ready' || state.baseline.generation !== generation)
            throw Error('CONNECTION_WORKSPACE_RETIRED');
          await this.tunnels!.start(
            { connectionId: connection.id, profile: { ...profile, hostId: connection.hostId } },
            owned,
          );
          owned.throwIfAborted();
        }
        if (filesOnly && !terminalBeforeFiles) {
          if (!filesOwner || this.files !== filesOwner)
            throw Error('CONNECTION_FILES_OWNER_MISSING');
          const tab = await filesOwner.open(
            {
              kind: 'remote',
              target: { protocol: 'sftp', connectionId: connection.id },
              ...filesOnly,
            },
            owned,
          );
          this.rollback.delete(connection.id);
          return tab;
        }
        const terminal = await this.terminals.open(
          {
            ...terminalRequest,
            kind: 'ssh',
            connectionId: connection.id,
            cols: terminalRequest.cols ?? 80,
            rows: terminalRequest.rows ?? 24,
          },
          owned,
          ...(title !== undefined ? [{ title }] : []),
        );
        // The terminal is already a visible accepted session; a later Files failure does not undo it.
        this.rollback.delete(connection.id);
        if (filesOnly) {
          if (!filesOwner || this.files !== filesOwner)
            throw Error('CONNECTION_FILES_OWNER_MISSING');
          await filesOwner.open(
            {
              kind: 'remote',
              target: { protocol: 'sftp', connectionId: connection.id },
              ...filesOnly,
            },
            owned,
          );
        }
        return terminal;
      } catch (error) {
        if (!borrowed && this.rollback.has(connection.id))
          await this.release(connection.id, generation);
        throw error;
      }
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    const completion = Promise.withResolvers<void>();
    this.closing = completion.promise;
    this.lifetime.abort();
    void (async () => {
      await Promise.allSettled([...this.pending]);
      await Promise.allSettled(
        [...this.rollback].map(([id, generation]) => this.release(id, generation)),
      );
      await Promise.allSettled(
        [...this.uncertain].map(([key, generation]) => this.resolveUncertain(key, generation)),
      );
      if (this.rollback.size || this.uncertain.size)
        throw new Error('CONNECTION_WORKSPACE_DRAIN_FAILED');
    })().then(completion.resolve, completion.reject);
    return this.closing;
  }
  private async resolveUncertain(key: string, generation: string): Promise<void> {
    const current = this.model.getSnapshot();
    if (current.status !== 'ready') throw new Error('CONNECTION_WORKSPACE_UNAVAILABLE');
    if (current.baseline.generation !== generation) {
      this.uncertain.delete(key);
      return;
    }
    const result = await this.model.getConnectionCommandOutcome(generation, key);
    if (result.status !== 'accepted') throw new Error('CONNECTION_WORKSPACE_OUTCOME_UNCERTAIN');
    await this.model.closeConnection(result.id, generation);
    this.uncertain.delete(key);
  }
  private async release(id: string, generation: string): Promise<void> {
    const current = this.model.getSnapshot();
    if (current.status !== 'ready') throw new Error('CONNECTION_WORKSPACE_UNAVAILABLE');
    if (current.baseline.generation === generation)
      await this.model.closeConnection(id, generation);
    this.rollback.delete(id);
  }
  private ready(
    id: string,
    generation: string,
    signal: AbortSignal,
    operationId: string,
  ): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let off = () => {};
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error('CONNECTION_WORKSPACE_CANCELED'));
      const check = () => {
        const state = this.model.getSnapshot();
        if (state.status === 'ready') {
          if (state.baseline.generation !== generation) {
            finish(new Error('CONNECTION_WORKSPACE_RETIRED'));
            return;
          }
          const connection = state.baseline.connections.find((value) => value.id === id);
          if (connection?.state === 'ready') finish();
          else if (connection?.state === 'failed' || connection?.state === 'closed') {
            const diagnostic = sshOperationDiagnosticSchema.safeParse({
              code: connection.errorCode,
              operationId,
            });
            finish(
              new RemoteError('connections/failure', 'CONNECTION_WORKSPACE_FAILED', {
                reason: 'unavailable',
                ...(diagnostic.success ? { diagnostic: diagnostic.data } : {}),
              }),
            );
          }
        } else if (state.status === 'error') finish(new Error('CONNECTION_WORKSPACE_UNAVAILABLE'));
      };
      const timer = setTimeout(
        () =>
          finish(
            new RemoteError('connections/failure', 'CONNECTION_WORKSPACE_TIMEOUT', {
              reason: 'unavailable',
              diagnostic: { code: 'CONNECTION_WAIT_TIMEOUT', operationId },
            }),
          ),
        this.readyTimeoutMs,
      );
      try {
        off = this.model.subscribe(check);
        if (settled) {
          off();
          return;
        }
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        else check();
      } catch (error) {
        finish(error instanceof Error ? error : new Error('CONNECTION_WORKSPACE_UNAVAILABLE'));
      }
    });
  }
}
