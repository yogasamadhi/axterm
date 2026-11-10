import { Service, type Context } from '@deepseek-ai/cordis';
import { RegistrationLifetime } from '@axterm/infra-scope';
import type { DesktopTaskContribution, DesktopTaskInspection } from '@axterm/plugin-api/host';
interface Contribution {
  readonly value: DesktopTaskContribution;
  closing: boolean;
  failed: boolean;
}
/** Resource ownership only: the contributor itself implements inspection and draining. */
export default class DesktopTasks extends Service implements DesktopTaskInspection {
  private readonly entries = new Map<string, Contribution>();
  private readonly registrations: RegistrationLifetime;
  private readonly lifetime = new AbortController();
  private revision = 0;
  private closed = false;
  constructor(ctx: Context) {
    super(ctx, 'desktopTaskInspection');
    this.registrations = new RegistrationLifetime(ctx);
    ctx.effect(() => () => {
      this.closed = true;
      this.lifetime.abort();
    });
  }
  register(name: string, value: DesktopTaskContribution): () => Promise<void> {
    if (this.closed) throw new Error('DESKTOP_TASKS_CLOSED');
    if (
      !/^[a-z][a-z0-9.-]{0,127}$/.test(name) ||
      typeof value.inspect !== 'function' ||
      typeof value.dispose !== 'function'
    )
      throw new Error('DESKTOP_TASKS_INVALID');
    if (this.entries.has(name)) throw new Error('DESKTOP_TASKS_DUPLICATE');
    if (this.entries.size >= 256) throw new Error('DESKTOP_TASKS_CAPACITY');
    const entry: Contribution = { value, closing: false, failed: false };
    return this.registrations.owner(this.ctx).effect(() => {
      this.entries.set(name, entry);
      this.revision++;
      return async () => {
        entry.closing = true;
        this.revision++;
        try {
          await value.dispose();
        } catch {
          entry.failed = true;
          throw new Error('DESKTOP_TASK_DRAIN_FAILED');
        }
        if (this.entries.get(name) === entry) {
          this.entries.delete(name);
          this.revision++;
        }
      };
    });
  }
  async inspect(signal: AbortSignal): Promise<{ active: boolean }> {
    const revision = this.revision;
    const lifetime = AbortSignal.any([signal, this.lifetime.signal]);
    lifetime.throwIfAborted();
    if (this.closed) throw new Error('DESKTOP_TASKS_CLOSED');
    const results = await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        if (entry.failed) throw new Error('DESKTOP_TASK_STATE_UNAVAILABLE');
        if (entry.closing) return { active: true };
        try {
          const result = await entry.value.inspect(lifetime);
          if (typeof result.active !== 'boolean') throw new Error();
          return { active: result.active };
        } catch {
          throw new Error('DESKTOP_TASK_STATE_UNAVAILABLE');
        }
      }),
    );
    lifetime.throwIfAborted();
    if (revision !== this.revision) throw new Error('DESKTOP_TASK_STATE_CHANGED');
    return { active: results.some((result) => result.active) };
  }
}
