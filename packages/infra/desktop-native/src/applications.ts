import { randomUUID } from 'node:crypto';
import { Service, type Context } from '@deepseek-ai/cordis';
import { RemoteError } from '@axterm/plugin-api';
import { grantedDirectoryPathSchema, type FilesFailureReason } from '@axterm/plugin-api/files';
import type { FileApplications } from '@axterm/plugin-api/host';
import type {} from './credentials.ts';
import { NativeError } from './protocol.ts';
const failure = (reason: FilesFailureReason) =>
  new RemoteError('files/failure', 'The native file action could not complete', { reason });
/** Desktop-only Host facade. Accepted OS effects are never automatically replayed. */
export default class DesktopFileApplications extends Service implements FileApplications {
  static readonly inject = ['desktopNative', 'runtimeIdentity'];
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;
  private undrained = false;
  constructor(ctx: Context) {
    super(ctx, 'fileApplications');
    if (ctx.desktopNative.generation !== ctx.runtimeIdentity.generation)
      throw new NativeError('INVALID');
    ctx.effect(() => () => this.close());
    ctx.inject(['desktopTaskInspection'], (owner) => {
      owner.desktopTaskInspection.register('native-file-applications', {
        inspect: (signal) => {
          signal.throwIfAborted();
          return { active: this.pending.size > 0 || this.undrained };
        },
        dispose: () => this.close(),
      });
    });
  }
  open(grantId: string, path: string, signal?: AbortSignal) {
    return this.perform('fileGrant.open', grantId, path, signal);
  }
  reveal(grantId: string, path: string, signal?: AbortSignal) {
    return this.perform('fileGrant.reveal', grantId, path, signal);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.pending]);
      if (this.undrained) throw failure('uncertain');
    })());
  }
  private perform(
    method: 'fileGrant.open' | 'fileGrant.reveal',
    grantId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.closing) return Promise.reject(failure('closed'));
    if (this.pending.size >= 16) return Promise.reject(failure('capacity'));
    const relative = grantedDirectoryPathSchema.safeParse(path);
    if (!relative.success || !grantId || grantId.length > 256)
      return Promise.reject(failure('invalid-input'));
    const owned = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    if (owned.aborted) return Promise.reject(failure('cancelled'));
    const native = this.ctx.desktopNative,
      key = randomUUID();
    const task = native.call(method, { key, grantId, path: relative.data }, owned).then(
      () => {},
      async (error) => {
        const code = error instanceof NativeError ? error.code : 'IO';
        const definite: Partial<Record<typeof code, FilesFailureReason>> = {
          INVALID: 'invalid-input',
          FORBIDDEN: 'forbidden',
          STALE: 'stale',
          NOT_FOUND: 'not-found',
          UNAVAILABLE: 'unavailable',
          LIMIT: 'capacity',
          CONFLICT: 'conflict',
        };
        if (!definite[code]) {
          try {
            await native.call('fileGrant.application.drain', { key });
          } catch {
            this.undrained = true;
          }
        }
        throw failure(definite[code] ?? 'uncertain');
      },
    );
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => {});
    return task;
  }
}
