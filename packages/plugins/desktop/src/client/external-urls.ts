import { externalHttpUrlSchema } from '@axterm/plugin-api/desktop';
import type { DesktopUi } from '@axterm/ui/workspace';
import type { DesktopRuntimeState } from './index.ts';
/** Browser navigation stays in the original click stack; Desktop uses the authenticated Remote owner. */
export class DesktopLinksClient implements DesktopUi {
  private closing: Promise<void> | undefined;
  private readonly pending = new Set<Promise<void>>();
  constructor(
    private readonly state: () => DesktopRuntimeState,
    private readonly invoke: (
      generation: string,
      key: string,
      url: string,
      signal?: AbortSignal,
    ) => Promise<void>,
    private readonly browserOpen: (url: string) => void,
  ) {}
  openExternal(url: string, signal?: AbortSignal): Promise<void> {
    if (this.closing || this.pending.size >= 16)
      return Promise.reject(Error('EXTERNAL_NAVIGATION_UNAVAILABLE'));
    signal?.throwIfAborted();
    const target = externalHttpUrlSchema.parse(url),
      state = this.state();
    if (state.status !== 'ready') return Promise.reject(Error('EXTERNAL_NAVIGATION_NOT_READY'));
    if (state.baseline.metadata.mode === 'web') {
      this.browserOpen(target);
      return Promise.resolve();
    }
    if (state.baseline.metadata.mode !== 'desktop')
      return Promise.reject(Error('EXTERNAL_NAVIGATION_UNAVAILABLE'));
    const task = this.invoke(
      state.baseline.metadata.generation,
      crypto.randomUUID(),
      target,
      signal,
    );
    this.pending.add(task);
    const release = () => this.pending.delete(task);
    void task.then(release, release);
    return task;
  }
  close(): Promise<void> {
    return (this.closing ??= Promise.allSettled([...this.pending]).then(() => {}));
  }
}
