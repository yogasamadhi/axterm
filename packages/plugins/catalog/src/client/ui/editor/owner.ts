import type { QuickConnectTarget } from '../session/parser.ts';
import type { Bookmark, Host, CatalogReceipt } from '@axterm/plugin-api/catalog';
import type { CreateConnectionInput, SerialPortInfo } from '@axterm/plugin-api/connections';
import type { SavedCredentialActions } from '@axterm/plugin-api/saved-credentials';
import type { TerminalWorkspaceUi } from '@axterm/ui/workspace';
import { EditorOperations } from './operations.ts';
import { SshSaveWorkflow } from './ssh-save-workflow.ts';
import { ProtocolSaveWorkflow } from './protocol-save-workflow.ts';
import type { SshEditorServices } from './ssh-editor.tsx';
interface SessionBase {
  readonly id: string;
  readonly generation: string;
  readonly bookmark?: Bookmark;
  readonly operations: EditorOperations;
}
export type CatalogEditorSession = SessionBase &
  (
    | { readonly protocol: 'ssh'; readonly host?: Host; readonly workflow: SshSaveWorkflow }
    | {
        readonly protocol: Exclude<Bookmark['protocol'], 'ssh' | 'local'>;
        readonly workflow: ProtocolSaveWorkflow;
      }
  );
interface EditorSelection {
  readonly session?: CatalogEditorSession;
  readonly failed: boolean;
  readonly busy: boolean;
  readonly ports: readonly SerialPortInfo[];
  readonly portsFailed: boolean;
}
export interface CatalogEditorServices extends SshEditorServices {
  readonly terminalWorkspace: TerminalWorkspaceUi;
  readonly launch: (bookmark: Bookmark, signal: AbortSignal) => Promise<boolean>;
}
/** Selection and form lifetime; domain facts remain in their selected Client owners. */
export class CatalogEditorOwner {
  private state: EditorSelection = { failed: false, busy: false, ports: [], portsFailed: false };
  private readonly listeners = new Set<() => void>();
  private pending: Promise<void> | undefined;
  private closed = false;
  private initial: { id: string; target: QuickConnectTarget } | undefined;
  private closing: Promise<void> | undefined;
  constructor(
    readonly services: CatalogEditorServices,
    private readonly vault: SavedCredentialActions,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  initialTarget(id: string): QuickConnectTarget | undefined {
    return this.initial?.id === id ? this.initial.target : undefined;
  }
  openQuickConnect(
    target: Exclude<QuickConnectTarget, { protocol: 'ssh' | 'local' }>,
  ): string | undefined {
    const previous = this.state.session?.id;
    this.open(
      undefined,
      target.protocol === 'http' || target.protocol === 'https' ? 'web' : target.protocol,
      target,
    );
    const selected = this.state.session?.id;
    return selected && selected !== previous ? selected : undefined;
  }
  open(
    bookmark?: Bookmark,
    protocol: Bookmark['protocol'] = bookmark?.protocol ?? 'ssh',
    initialTarget?: QuickConnectTarget,
  ): void {
    if (this.closed || this.state.session || this.pending) return;
    const facts = this.services.catalog.getSnapshot();
    if (facts.status !== 'ready' || protocol === 'local') {
      this.publish({ ...this.state, failed: true });
      return;
    }
    const host = bookmark?.hostId
      ? facts.baseline.hosts.find((value) => value.id === bookmark.hostId)
      : undefined;
    if (protocol === 'ssh' && bookmark && !host) {
      this.publish({ ...this.state, failed: true });
      return;
    }
    const base = {
      id: crypto.randomUUID(),
      generation: facts.baseline.generation,
      ...(bookmark ? { bookmark: structuredClone(bookmark) } : {}),
      operations: new EditorOperations(() => {
        const current = this.services.catalog.getSnapshot();
        return current.status === 'ready' ? current.baseline.generation : undefined;
      }),
    };
    const session: CatalogEditorSession =
      protocol === 'ssh'
        ? {
            ...base,
            protocol,
            ...(host ? { host: structuredClone(host) } : {}),
            workflow: new SshSaveWorkflow(this.services.catalog, this.vault),
          }
        : {
            ...base,
            protocol,
            workflow: new ProtocolSaveWorkflow(this.services.catalog, this.vault),
          };
    this.initial = initialTarget
      ? { id: session.id, target: structuredClone(initialTarget) }
      : undefined;
    this.publish({ session, failed: false, busy: false, ports: [], portsFailed: false });
    if (protocol === 'serial') void this.refreshPorts();
  }
  async protocol(protocol: Bookmark['protocol']): Promise<void> {
    const session = this.state.session;
    if (this.closed || !session || session.bookmark) return;
    if (protocol === 'local') {
      try {
        await session.operations.admit((signal) =>
          this.services.terminalWorkspace.open({ kind: 'local', cols: 160, rows: 80 }, signal),
        );
        await this.close();
      } catch {
        this.publish({ ...this.state, failed: true });
      }
      return;
    }
    await this.close();
    this.open(undefined, protocol);
  }
  async refreshPorts(): Promise<void> {
    const session = this.state.session;
    if (this.closed || !session || session.protocol !== 'serial') return;
    try {
      const ports = await session.operations.admit(() =>
        this.services.connections.listSerialPorts(),
      );
      if (this.state.session === session)
        this.publish({ ...this.state, ports, portsFailed: false });
    } catch {
      if (this.state.session === session) this.publish({ ...this.state, portsFailed: true });
    }
  }
  close(): Promise<void> {
    if (this.pending) return this.pending;
    const session = this.state.session;
    if (!session) return Promise.resolve();
    this.publish({ ...this.state, busy: true });
    const task = (async () => {
      try {
        await Promise.all([session.workflow.close(), session.operations.close()]);
        if (this.state.session === session) {
          this.initial = undefined;
          this.publish({ failed: false, busy: false, ports: [], portsFailed: false });
        }
      } catch {
        this.publish({ ...this.state, failed: true, busy: false });
      }
    })();
    this.pending = task;
    void task.then(() => {
      if (this.pending === task) this.pending = undefined;
    });
    return task;
  }
  async saved(
    receipt: CatalogReceipt,
    action: string,
    temporary: Pick<
      CreateConnectionInput,
      'temporarySecret' | 'temporaryPassphrase' | 'temporaryCertificate' | 'connectionProfileId'
    >,
  ): Promise<void> {
    const session = this.state.session;
    if (this.closed || !session || session.protocol !== 'ssh') return;
    let failed = false;
    if (action === 'save-and-connect') {
      try {
        const [hostId, bookmarkId] = receipt.ids;
        if (!hostId || !bookmarkId) throw new Error('CATALOG_SAVE_RECEIPT_INVALID');
        await session.operations.admit((signal) =>
          this.services.connectionWorkspace.openSsh(
            { hostId, ...temporary },
            { signal, terminal: { bookmarkId } },
          ),
        );
      } catch {
        failed = true;
      }
    }
    await this.close();
    if (failed) this.publish({ ...this.state, failed: true });
    else if (action === 'save-and-new') this.open();
  }
  async savedProtocol(receipt: CatalogReceipt, connect: boolean): Promise<void> {
    const session = this.state.session;
    if (this.closed || !session || session.protocol === 'ssh') return;
    let failed = false;
    if (connect)
      try {
        await session.operations.admit(async (signal) => {
          const bookmark = await this.savedBookmark(session, receipt, signal);
          if (!(await this.services.launch(bookmark, signal)))
            throw new Error('CATALOG_LAUNCH_FAILED');
        });
      } catch {
        failed = true;
      }
    await this.close();
    if (failed) this.publish({ ...this.state, failed: true });
  }
  private async savedBookmark(
    session: CatalogEditorSession,
    receipt: CatalogReceipt,
    signal: AbortSignal,
  ): Promise<Bookmark> {
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (error?: Error, value?: Bookmark) => {
        unsubscribe();
        lifetime.removeEventListener('abort', abort);
        if (error) reject(error);
        else if (value) resolve(value);
      };
      const abort = () => finish(new Error('CATALOG_SAVED_VIEW_CANCELLED'));
      const inspect = () => {
        const facts = this.services.catalog.getSnapshot();
        if (facts.status === 'ready') {
          if (facts.baseline.generation !== session.generation)
            return finish(new Error('CATALOG_GENERATION_CHANGED'));
          if (facts.baseline.cursor >= receipt.cursor) {
            const bookmark = facts.baseline.bookmarks.bookmarks.find(
              (value) => value.id === receipt.ids[0],
            );
            finish(bookmark ? undefined : new Error('CATALOG_SAVED_BOOKMARK_MISSING'), bookmark);
          }
        }
      };
      unsubscribe = this.services.catalog.subscribe(inspect);
      lifetime.addEventListener('abort', abort, { once: true });
      if (lifetime.aborted) abort();
      else inspect();
    });
  }
  retireGeneration(): void {
    const session = this.state.session,
      facts = this.services.catalog.getSnapshot();
    if (session && facts.status === 'ready' && facts.baseline.generation !== session.generation)
      void this.close();
  }
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      await this.pending;
      const session = this.state.session;
      if (session) await Promise.all([session.workflow.close(), session.operations.close()]);
      this.initial = undefined;
      this.listeners.clear();
    })());
  }
  private publish(state: EditorSelection) {
    this.state = state;
    if (!this.closed) for (const listener of this.listeners) listener();
  }
}
