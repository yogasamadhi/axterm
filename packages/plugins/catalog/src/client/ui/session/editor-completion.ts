import type { CatalogEditorOwner } from '../editor/owner.ts';
/** UI selection lifetime only; protocol facts and IO remain in their existing owners. */
export class EditorCompletion {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  constructor(private readonly editor: Pick<CatalogEditorOwner, 'getSnapshot' | 'subscribe'>) {}
  idle(signal: AbortSignal): Promise<void> {
    return this.wait(() => !this.editor.getSnapshot().session, signal);
  }
  closed(id: string, signal: AbortSignal): Promise<void> {
    return this.wait(() => this.editor.getSnapshot().session?.id !== id, signal);
  }
  private wait(ready: () => boolean, signal: AbortSignal): Promise<void> {
    if (this.pending.size >= 8) throw Error('EDITOR_WAIT_CAPACITY');
    const owned = AbortSignal.any([signal, this.lifetime.signal]);
    owned.throwIfAborted();
    if (ready()) return Promise.resolve();
    const task = new Promise<void>((resolve, reject) => {
      let done = false,
        off = () => {};
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        off();
        owned.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
          if (ready()) finish();
        },
        abort = () => finish(Error('EDITOR_WAIT_CANCELED'));
      off = this.editor.subscribe(check);
      owned.addEventListener('abort', abort, { once: true });
      if (owned.aborted) abort();
      else check();
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.pending]);
  }
}
