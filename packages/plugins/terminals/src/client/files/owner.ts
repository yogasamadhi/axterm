import type { FilesWorkspaceUi } from '@axterm/ui/workspace';
interface Identity {
  readonly generation: string;
  readonly sessions: readonly { readonly id: string }[];
}
type Service = Pick<FilesWorkspaceUi, 'prepareTerminalPane' | 'releaseTerminalPane'>;
interface Entry {
  readonly generation: string;
  readonly admitted: Promise<void>;
  readonly release: () => Promise<void>;
  retiring?: Promise<void>;
}
/** Execution handles only; Files owns the pane, grants, reads, commands and actual IO. */
export class TerminalFilePanes {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(
    private readonly read: () => Identity | undefined,
    private readonly service: () => Service | undefined,
    private readonly signal: AbortSignal,
  ) {}
  private check(id: string, generation: string): void {
    const state = this.read();
    if (
      this.closed ||
      this.signal.aborted ||
      state?.generation !== generation ||
      !state.sessions.some((session) => session.id === id)
    )
      throw Error('TERMINAL_FILES_RETIRED');
  }
  async prepare(id: string, generation: string): Promise<void> {
    this.check(id, generation);
    let entry = this.entries.get(id);
    if (entry && (entry.generation !== generation || entry.retiring))
      throw Error('TERMINAL_FILES_RETIRED');
    if (!entry) {
      if (this.entries.size >= 4) throw Error('TERMINAL_FILES_CAPACITY');
      const service = this.service();
      if (!service?.prepareTerminalPane || !service.releaseTerminalPane)
        throw Error('TERMINAL_FILES_UNAVAILABLE');
      const prepare = service.prepareTerminalPane.bind(service),
        release = service.releaseTerminalPane.bind(service);
      entry = {
        generation,
        admitted: Promise.resolve().then(() => {
          this.check(id, generation);
          return prepare(id, generation);
        }),
        release: () => release(id, generation),
      };
      this.entries.set(id, entry);
    }
    try {
      await entry.admitted;
      this.check(id, generation);
    } catch (error) {
      await this.releaseEntry(id, entry);
      throw error;
    }
  }
  async release(id: string, generation?: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (generation !== undefined && entry.generation !== generation)
      throw Error('TERMINAL_FILES_RETIRED');
    await this.releaseEntry(id, entry);
  }
  private releaseEntry(id: string, entry: Entry): Promise<void> {
    return (entry.retiring ??= (async () => {
      await entry.admitted.catch(() => {});
      await entry.release();
      if (this.entries.get(id) === entry) this.entries.delete(id);
    })());
  }
  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled(
      [...this.entries].map(([id, entry]) => this.releaseEntry(id, entry)),
    );
    if (results.some((result) => result.status === 'rejected') || this.entries.size)
      throw Error('TERMINAL_FILES_UNDRAINED');
  }
}
