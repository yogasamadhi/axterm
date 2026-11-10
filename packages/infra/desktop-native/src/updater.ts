import type { DesktopUpdaterPort, UpdaterAction, UpdaterStatus } from '@axterm/plugin-api/desktop';
import { updaterActionSchema, updaterStatusSchema } from '@axterm/plugin-api/desktop';
import { z } from 'zod';
import { NativeError, type NativeHandlers } from './protocol.ts';

/** Per-generation native owner. A lost acknowledgement never executes a second OS action. */
export class ShellUpdater {
  private active = true;
  private readonly jobs = new Map<
    string,
    { action: UpdaterAction; task: Promise<UpdaterStatus> }
  >();
  private readonly pending = new Set<Promise<UpdaterStatus>>();
  private closing: Promise<void> | undefined;
  constructor(private readonly updater?: DesktopUpdaterPort) {}
  handlers(): Pick<NativeHandlers, 'updater.status' | 'updater.perform' | 'updater.drain'> {
    return {
      'updater.status': () => {
        if (!this.active) throw new NativeError('CLOSED');
        return updaterStatusSchema.parse(this.updater?.status() ?? { state: 'disabled' });
      },
      'updater.perform': ({ key, action }, signal) => {
        if (!this.active) throw new NativeError('CLOSED');
        if (!z.uuid().safeParse(key).success || !updaterActionSchema.safeParse({ action }).success)
          throw new NativeError('INVALID');
        const old = this.jobs.get(key);
        if (old) {
          if (old.action !== action) throw new NativeError('CONFLICT');
          return old.task;
        }
        if (!this.updater) throw new NativeError('UNAVAILABLE');
        if (this.jobs.size >= 2000 || this.pending.size >= 16) throw new NativeError('LIMIT');
        if (signal.aborted) throw new NativeError('CANCELLED');
        const task = Promise.resolve().then(async () => {
          if (!this.active || signal.aborted) throw new NativeError('CANCELLED');
          const cancel = () => {
            // Cancelling the caller requests cancellation, but the actual operation stays owned.
            void this.updater!.perform('cancel').catch(() => {});
          };
          signal.addEventListener('abort', cancel, { once: true });
          try {
            return updaterStatusSchema.parse(await this.updater!.perform(action));
          } catch {
            throw new NativeError('FAILED');
          } finally {
            signal.removeEventListener('abort', cancel);
          }
        });
        this.jobs.set(key, { action, task });
        this.pending.add(task);
        const release = () => this.pending.delete(task);
        void task.then(release, release);
        return task;
      },
      'updater.drain': async ({ key }) => {
        if (!this.active) throw new NativeError('CLOSED');
        await this.jobs.get(key)?.task.catch(() => {});
        return true as const;
      },
    };
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.active = false;
      const results = await Promise.allSettled([this.updater?.close(), ...this.pending]);
      this.jobs.clear();
      if (results[0]?.status === 'rejected') throw new NativeError('FAILED');
    })());
  }
}
