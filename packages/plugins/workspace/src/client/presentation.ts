import { remoteErrorOf } from '@axterm/plugin-api';
import {
  workspacePresentationSchema,
  type ConfigurationClientActions,
  type WorkspacePresentation,
  type WorkspacePresentationBinding,
} from '@axterm/plugin-api/configuration';
import { paneCount, type WorkspaceStore } from './store.ts';
export type PresentationStatus = 'connecting' | 'ready' | 'saving' | 'error' | 'restart-required';
export class PresentationStatusStore {
  private value: PresentationStatus = 'connecting';
  private readonly listeners = new Set<() => void>();
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(value: PresentationStatus): void {
    if (value === this.value) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  close(): void {
    this.listeners.clear();
  }
}
interface Intent {
  readonly key: string;
  readonly input: WorkspacePresentation;
  readonly generation: string;
  readonly version: number;
  readonly revision: number;
}
/** Persists pure UI intent through Configuration's sole Client model. One retained request and one latest intent. */
export class WorkspacePresentationOwner {
  private readonly lifetime = new AbortController();
  private readonly disposers: (() => void)[];
  private binding: WorkspacePresentationBinding | undefined;
  private hydrated = false;
  private requestedGeneration: string | undefined;
  private needsBinding = false;
  private seen = 0;
  private retained: Intent | undefined;
  private processing: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private stopped = false;
  private paused = 0;
  constructor(
    private readonly workspace: WorkspaceStore,
    private readonly configuration: ConfigurationClientActions,
    private readonly slot: string,
    private readonly status: PresentationStatusStore,
  ) {
    if (!configuration.bindWorkspacePresentation || !configuration.saveWorkspacePresentation)
      throw Error('WORKSPACE_PERSISTENCE_UNAVAILABLE');
    this.disposers = [configuration.subscribe(this.refresh), workspace.subscribe(this.changed)];
    window.addEventListener('pagehide', this.pagehide, { once: true });
    this.refresh();
  }
  async pause(): Promise<() => void> {
    if (this.stopped) throw Error('WORKSPACE_PERSISTENCE_CLOSED');
    this.paused++;
    await this.processing;
    if (this.retained) {
      this.paused--;
      throw Error('WORKSPACE_PERSISTENCE_UNCERTAIN');
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.paused--;
      this.changed();
    };
  }
  retry(): Promise<void> {
    if (this.stopped) throw Error('WORKSPACE_PERSISTENCE_CLOSED');
    if (this.processing) return this.processing;
    return this.start();
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.stopped = true;
      this.lifetime.abort();
      for (const off of this.disposers) off();
      window.removeEventListener('pagehide', this.pagehide);
      await this.processing;
      this.retained = undefined;
    })());
  }
  private readonly pagehide = () => {
    this.stopped = true;
    this.lifetime.abort();
  };
  private current() {
    const state = this.configuration.getSnapshot();
    if (state.status !== 'ready') return undefined;
    return state.baseline;
  }
  private readonly refresh = () => {
    if (this.stopped) return;
    const state = this.current();
    if (!state) {
      this.status.set('connecting');
      return;
    }
    if (this.binding?.generation !== state.generation) {
      this.binding = undefined;
      this.hydrated = false;
      this.retained = undefined;
      if (this.requestedGeneration !== state.generation) {
        this.requestedGeneration = state.generation;
        this.needsBinding = true;
      }
      if (!this.processing && this.needsBinding) {
        this.needsBinding = false;
        void this.start().catch(() => {});
      }
      return;
    }
    if (state.settings.workspace.importRevision !== this.binding.importRevision) {
      this.retained = undefined;
      this.status.set('restart-required');
      return;
    }
    const record = state.settings.workspace.presentations?.[this.binding.key];
    if (this.retained && record?.lastCommandId === this.retained.key) {
      this.seen = Math.max(this.seen, this.retained.revision);
      this.retained = undefined;
      if (!this.processing) this.status.set('ready');
    }
    this.changed();
  };
  private readonly changed = () => {
    if (
      this.stopped ||
      this.paused ||
      this.status.getSnapshot() === 'restart-required' ||
      !this.hydrated ||
      this.processing ||
      this.retained
    )
      return;
    if (this.workspace.getPresentationRevision() > this.seen) void this.start().catch(() => {});
  };
  private start(): Promise<void> {
    if (this.processing) return this.processing;
    const task = Promise.resolve()
      .then(() => this.process())
      .catch(() => {
        if (!this.stopped && this.status.getSnapshot() !== 'restart-required')
          this.status.set('error');
      })
      .finally(() => {
        this.processing = undefined;
        if (!this.stopped && this.needsBinding) {
          this.needsBinding = false;
          void this.start().catch(() => {});
          return;
        }
        if (
          !this.stopped &&
          this.hydrated &&
          !this.retained &&
          this.status.getSnapshot() !== 'error'
        )
          this.changed();
      });
    this.processing = task;
    return task;
  }
  private async process(): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    let state = this.current();
    if (!state) return;
    if (!this.binding) {
      const binding = await this.configuration.bindWorkspacePresentation!(this.slot);
      this.lifetime.signal.throwIfAborted();
      state = this.current();
      if (!state || state.generation !== binding.generation)
        throw Error('WORKSPACE_BINDING_RETIRED');
      this.binding = binding;
      if (this.workspace.bindPresentationGeneration(binding.generation))
        this.seen = this.workspace.getPresentationRevision();
      const saved = state.settings.workspace.presentations?.[binding.key];
      if (saved?.generation === binding.generation)
        this.workspace.restorePresentation(saved.presentation);
      else if (saved) {
        const { layout: coldLayout, ...presentation } = saved.presentation;
        this.workspace.restorePresentation({
          ...presentation,
          tabs: [],
          activeTabId: null,
          ...(coldLayout && state.settings.workspace.restoreLayout
            ? {
                layout: {
                  ...coldLayout,
                  paneTabIds: coldLayout.paneTabIds.map(() => null),
                },
              }
            : {}),
        });
      }
      if (!saved && state.settings.workspace.restoreLayout && state.settings.workspace.layout) {
        const legacy = state.settings.workspace.layout;
        const mode = legacy.split && legacy.layoutMode === 'c1' ? 'c2' : legacy.layoutMode,
          count = paneCount(mode);
        this.workspace.restorePresentation({
          section: state.settings.workspace.aiInspectorOpen ? 'ai' : legacy.section,
          sidebarOpen: state.settings.workspace.aiInspectorOpen || legacy.sidebarOpen,
          activeTabId: null,
          tabs: [],
          layout: {
            mode,
            paneTabIds: Array.from({ length: count }, () => null),
            focusedPane: Math.min(legacy.focusedPane, count - 1),
          },
        });
      }
      this.hydrated = true;
    }
    const binding = this.binding;
    while (!this.stopped && !this.paused) {
      state = this.current();
      if (!state || state.generation !== binding.generation)
        throw Error('WORKSPACE_GENERATION_RETIRED');
      if (state.settings.workspace.importRevision !== binding.importRevision) {
        this.retained = undefined;
        this.status.set('restart-required');
        return;
      }
      const record = state.settings.workspace.presentations?.[binding.key],
        revision = this.workspace.getPresentationRevision();
      if (this.retained && record?.lastCommandId === this.retained.key) {
        this.seen = Math.max(this.seen, this.retained.revision);
        this.retained = undefined;
      }
      if (!this.retained && revision <= this.seen) {
        this.status.set('ready');
        return;
      }
      if (!this.retained) {
        const input = workspacePresentationSchema.parse(this.workspace.getPresentation());
        if (
          record?.generation === binding.generation &&
          JSON.stringify(input) === JSON.stringify(record.presentation)
        ) {
          this.seen = revision;
          this.status.set('ready');
          return;
        }
        this.retained = {
          key: crypto.randomUUID(),
          input,
          generation: binding.generation,
          version: record?.version ?? 0,
          revision,
        };
      }
      const intent = this.retained;
      this.status.set('saving');
      try {
        const receipt = await this.configuration.saveWorkspacePresentation!(
          intent.key,
          this.slot,
          intent.input,
          intent.version,
          intent.generation,
          binding.importRevision,
        );
        await this.observed(binding, receipt.version);
        this.seen = Math.max(this.seen, intent.revision);
        if (this.retained === intent) this.retained = undefined;
      } catch (error) {
        const after = this.current()?.settings.workspace.presentations?.[binding.key];
        if (after?.lastCommandId === intent.key) {
          this.seen = Math.max(this.seen, intent.revision);
          if (this.retained === intent) this.retained = undefined;
          continue;
        }
        const marked = remoteErrorOf(error);
        // A definite CAS refusal has no side effect; retain the latest UI state for explicit retry with fresh preconditions.
        if (
          marked?.code === 'configuration/failure' &&
          marked.details.reason === 'precondition-failed' &&
          this.retained === intent
        )
          this.retained = undefined;
        throw error;
      }
    }
  }
  private observed(binding: WorkspacePresentationBinding, version: number): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let off = () => {},
        done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        this.lifetime.signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        const state = this.current();
        if (!state || state.generation !== binding.generation)
          finish(Error('WORKSPACE_GENERATION_RETIRED'));
        else if (state.settings.workspace.importRevision !== binding.importRevision)
          finish(Error('WORKSPACE_IMPORT_RETIRED'));
        else if ((state.settings.workspace.presentations?.[binding.key]?.version ?? 0) >= version)
          finish();
      };
      const abort = () => finish(Error('WORKSPACE_PERSISTENCE_CLOSED')),
        timer = setTimeout(() => finish(Error('WORKSPACE_FACT_TIMEOUT')), 10000);
      try {
        off = this.configuration.subscribe(check);
        this.lifetime.signal.addEventListener('abort', abort, { once: true });
        if (this.lifetime.signal.aborted) abort();
        else check();
      } catch {
        finish(Error('WORKSPACE_FACT_UNAVAILABLE'));
      }
    });
  }
}
