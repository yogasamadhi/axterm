import type { FileGrantActions, FileGrant } from '@axterm/plugin-api/files';
import type { CatalogModel } from '../index.ts';
import { ImportDialogActions } from './import-actions.ts';
export interface ImportView {
  readonly actions?: ImportDialogActions;
  readonly root?: FileGrant;
  readonly busy: boolean;
  readonly failed: boolean;
}
/** Only presentation selection is stored here. Product facts remain in the Catalog model. */
export class CatalogImportLauncher {
  private state: ImportView = { busy: false, failed: false };
  private readonly listeners = new Set<() => void>();
  private pending: Promise<void> | undefined;
  private owner: ImportDialogActions | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly model: CatalogModel,
    private readonly files: FileGrantActions,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: ImportView) {
    if (this.closed) return;
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        console.warn('CATALOG_IMPORT_UI_OBSERVER_FAILED');
      }
    }
  }
  open(file?: File): Promise<void> {
    if (this.closed) return Promise.reject(new Error('CATALOG_IMPORT_UI_CLOSED'));
    if (this.owner || this.pending) return Promise.resolve();
    const state = this.model.getSnapshot();
    if (state.status !== 'ready') {
      this.publish({ busy: false, failed: true });
      return Promise.resolve();
    }
    const owner = new ImportDialogActions(this.model, this.files, state.baseline.generation);
    this.owner = owner;
    this.publish({ busy: true, failed: false });
    const task = (async () => {
      try {
        const root = file ? await owner.importFile(file) : await owner.createFileGrant('open-file');
        if (!root || this.closed) {
          await owner.dispose();
          if (this.owner === owner) this.owner = undefined;
          this.publish({ busy: false, failed: false });
        } else this.publish({ actions: owner, root, busy: false, failed: false });
      } catch {
        try {
          await owner.dispose();
          if (this.owner === owner) this.owner = undefined;
        } catch {
          /* Retain the failed owner and deny further admission. */
        }
        this.publish({ busy: false, failed: true });
      }
    })();
    this.pending = task;
    void task.then(() => {
      if (this.pending === task) this.pending = undefined;
    });
    return task;
  }
  async close(): Promise<void> {
    const owner = this.owner;
    if (!owner) return;
    this.publish({ ...this.state, busy: true });
    try {
      await owner.dispose();
      if (this.owner === owner) this.owner = undefined;
      this.publish({ busy: false, failed: false });
    } catch {
      this.publish({ ...this.state, busy: false, failed: true });
    }
  }
  retireGeneration(): void {
    const state = this.model.getSnapshot();
    if (
      this.owner &&
      state.status === 'ready' &&
      state.baseline.generation !== this.owner.generation
    )
      void this.close();
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    return (this.closing = (async () => {
      await this.owner?.dispose();
      await this.pending;
      this.listeners.clear();
    })());
  }
}
