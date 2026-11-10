export interface AiReadState<T> {
  readonly data: T | undefined;
  readonly isSuccess: boolean;
  readonly isPending: boolean;
  readonly isError: boolean;
}
/** Selected read facts live in a Client owner, with bounded shared memory and actual read drains. */
export class AiReadResource<T> {
  private state: AiReadState<T> = {
    data: undefined,
    isSuccess: false,
    isPending: true,
    isError: false,
  };
  private readonly listeners = new Set<() => void>();
  private readonly lifetime = new AbortController();
  private task: Promise<AiReadState<T>> | undefined;
  private closing: Promise<void> | undefined;
  private invalidated = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly read: (signal: AbortSignal) => Promise<T>,
    private readonly reserve: (value: T | undefined) => void,
    private readonly released: () => void,
    private readonly interval?: number,
  ) {}
  getSnapshot = (): AiReadState<T> => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.assertOpen();
    if (this.listeners.size >= 256) throw new Error('AI_READ_OBSERVER_CAPACITY');
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  invalidate(): void {
    if (this.lifetime.signal.aborted) return;
    if (this.task) this.invalidated = true;
    else void this.refetch().catch(() => {});
  }
  refetch(): Promise<AiReadState<T>> {
    this.assertOpen();
    if (this.task) return this.task;
    clearTimeout(this.timer);
    const task = Promise.resolve()
      .then(async () => {
        this.lifetime.signal.throwIfAborted();
        const value = await this.read(this.lifetime.signal);
        this.lifetime.signal.throwIfAborted();
        this.reserve(value);
        this.publish({ data: freeze(value), isSuccess: true, isPending: false, isError: false });
        return this.state;
      })
      .catch(() => {
        if (!this.lifetime.signal.aborted)
          this.publish({ ...this.state, isSuccess: false, isPending: false, isError: true });
        return this.state;
      })
      .finally(() => {
        if (this.task === task) this.task = undefined;
        if (this.lifetime.signal.aborted) return;
        if (this.invalidated) {
          this.invalidated = false;
          void this.refetch().catch(() => {});
        } else if (this.interval !== undefined)
          this.timer = setTimeout(() => this.invalidate(), this.interval);
      });
    this.task = task;
    return task;
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort();
    clearTimeout(this.timer);
    return (this.closing = (async () => {
      await this.task;
      this.reserve(undefined);
      this.state = { data: undefined, isSuccess: false, isPending: false, isError: true };
      this.listeners.clear();
      this.released();
    })());
  }
  private assertOpen(): void {
    if (this.lifetime.signal.aborted) throw new Error('AI_READ_CLOSED');
  }
  private publish(state: AiReadState<T>): void {
    this.state = state;
    for (const listener of [...this.listeners])
      try {
        listener();
      } catch {
        console.warn('AI_READ_OBSERVER_FAILED');
      }
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
