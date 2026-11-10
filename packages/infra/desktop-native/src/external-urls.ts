import { externalHttpUrlSchema } from '@axterm/plugin-api/desktop';
import { NativeError, type NativeHandlers } from './protocol.ts';
/** Shell-owned OS work. No timeout/cancel is ever treated as OS completion. */
export class ShellExternalUrls {
  private active = true;
  private readonly jobs = new Map<string, { url: string; task: Promise<true> }>();
  private readonly pending = new Set<Promise<true>>();
  constructor(private readonly open?: (url: string) => Promise<void>) {}
  handlers(): Pick<NativeHandlers, 'externalUrl.open' | 'externalUrl.drain'> {
    return {
      'externalUrl.open': ({ key, url }, signal) => {
        if (!this.active) throw new NativeError('CLOSED');
        const target = externalHttpUrlSchema.safeParse(url);
        if (!target.success) throw new NativeError('INVALID');
        const old = this.jobs.get(key);
        if (old) {
          if (old.url !== target.data) throw new NativeError('CONFLICT');
          return old.task;
        }
        if (!this.open) throw new NativeError('UNAVAILABLE');
        if (this.pending.size >= 16 || this.jobs.size >= 2000) throw new NativeError('LIMIT');
        const task = Promise.resolve().then(async () => {
          if (!this.active || signal.aborted) throw new NativeError('CANCELLED');
          try {
            await this.open!(target.data);
          } catch {
            throw new NativeError('IO');
          }
          return true as const;
        });
        this.jobs.set(key, { url: target.data, task });
        this.pending.add(task);
        const release = () => this.pending.delete(task);
        void task.then(release, release);
        return task;
      },
      'externalUrl.drain': async ({ key }) => {
        if (!this.active) throw new NativeError('CLOSED');
        await this.jobs.get(key)?.task.catch(() => {});
        return true as const;
      },
    };
  }
  async close(): Promise<void> {
    this.active = false;
    await Promise.allSettled([...this.pending]);
    this.jobs.clear();
  }
}
