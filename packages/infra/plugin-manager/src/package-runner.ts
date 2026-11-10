// Package commands share the application subprocess range and output ownership.
import type { SubprocessHandle, SubprocessService } from '@axterm/plugin-api/host';
import type { ProfilePnpmInvocation } from '@axterm/infra-app-boot';
export type PackageFailure =
  | 'invalid-input'
  | 'capacity'
  | 'closed'
  | 'timeout'
  | 'cancelled'
  | 'not-found'
  | 'network'
  | 'disk-full'
  | 'permission'
  | 'unavailable';
export class PackageRunError extends Error {
  constructor(readonly reason: PackageFailure) {
    super('PACKAGE_OPERATION_' + reason.toUpperCase().replaceAll('-', '_'));
  }
}
export interface PackageRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly lossy: boolean;
  readonly failure?: PackageFailure;
}
/** All package subprocesses use the one managed-range provider, never a second process owner. */
export class PackageRunner {
  private readonly lifetime = new AbortController();
  private readonly tasks = new Set<Promise<PackageRunResult>>();
  private readonly failed = new Set<SubprocessHandle>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly subprocess: SubprocessService,
    private readonly invocation: ProfilePnpmInvocation,
    private readonly directory: string,
  ) {
    this.invocation = {
      command: invocation.command,
      args: [...invocation.args],
      env: { ...invocation.env },
    };
  }
  resourceCount(): number {
    return this.tasks.size + this.failed.size;
  }
  cleanupFailed(): boolean {
    return this.failed.size > 0;
  }
  run(
    argv: readonly string[],
    options: {
      signal?: AbortSignal | undefined;
      timeoutMs: number;
      requireCompleteOutput?: boolean;
      env?: Readonly<Record<string, string>>;
    },
  ): Promise<PackageRunResult> {
    if (this.closing) return Promise.reject(new PackageRunError('closed'));
    if (this.failed.size || this.tasks.size >= 4)
      return Promise.reject(new PackageRunError('capacity'));
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1 ||
      options.timeoutMs > 30 * 60_000 ||
      argv.length > 128 ||
      argv.some((value) => typeof value !== 'string' || value.length > 8192 || value.includes('\0'))
    )
      return Promise.reject(new PackageRunError('invalid-input'));
    const request = [...argv];
    const timeoutMs = options.timeoutMs,
      callerSignal = options.signal,
      complete = options.requireCompleteOutput;
    const environment = { ...this.invocation.env, ...options.env };
    const task = Promise.resolve().then(async () => {
      const timeout = new AbortController();
      const signal = AbortSignal.any([
        this.lifetime.signal,
        timeout.signal,
        ...(callerSignal ? [callerSignal] : []),
      ]);
      if (signal.aborted)
        throw new PackageRunError(this.lifetime.signal.aborted ? 'closed' : 'cancelled');
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      let handle: SubprocessHandle | undefined;
      let outcome: PackageRunResult | undefined;
      let rejected: { reason: unknown } | undefined;
      try {
        handle = this.subprocess.spawn({
          argv: [this.invocation.command, ...this.invocation.args, ...request],
          cwd: this.directory,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 1024 * 1024 },
            stderr: { maxBytes: 1024 * 1024 },
          },
          graceMs: 1000,
          signal,
          env: environment,
        });
        const result = await handle.done;
        if (timeout.signal.aborted) throw new PackageRunError('timeout');
        if (signal.aborted) throw new PackageRunError('cancelled');
        const out = handle.collected.stdout?.readFrom(0),
          err = handle.collected.stderr?.readFrom(0);
        if (complete && out?.lossy) throw new PackageRunError('capacity');
        const failure =
          result.exitCode === 0
            ? undefined
            : classify((out?.text ?? '') + '\n' + (err?.text ?? ''));
        outcome = {
          exitCode: result.exitCode,
          stdout: out?.text ?? '',
          stderr: err?.text ?? '',
          lossy: out?.lossy ?? false,
          ...(failure ? { failure } : {}),
        };
      } catch (reason) {
        rejected = { reason };
      } finally {
        clearTimeout(timer);
        if (handle)
          try {
            await handle.dispose();
            this.failed.delete(handle);
          } catch {
            this.failed.add(handle);
            rejected = { reason: new PackageRunError('unavailable') };
          }
      }
      if (rejected) throw rejected.reason;
      return outcome!;
    });
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.lifetime.abort();
      await Promise.allSettled([...this.tasks]);
      await Promise.allSettled(
        [...this.failed].map(async (handle) => {
          await handle.dispose();
          this.failed.delete(handle);
        }),
      );
      if (this.failed.size) throw new PackageRunError('unavailable');
    })());
  }
}
function classify(output: string): PackageFailure {
  if (/(?:ERR_PNPM_FETCH_404|ERR_PNPM_NO_MATCHING_VERSION|E404|ETARGET)/u.test(output))
    return 'not-found';
  if (/(?:ENOSPC|EDQUOT)/u.test(output)) return 'disk-full';
  if (/(?:EACCES|EPERM)/u.test(output)) return 'permission';
  if (/(?:ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|FETCH_ERROR|ERR_PNPM_FETCH)/u.test(output))
    return 'network';
  return 'unavailable';
}
