import type { Context } from '@deepseek-ai/cordis';
import { freemem, loadavg, totalmem, uptime } from 'node:os';
import type { SubprocessHandle } from '@axterm/plugin-api/host';
import type { AiToolResourcesPort } from '../ports/tool-resources.ts';
import { ApplicationError } from '../application/errors.ts';
/** All AI Tool IO stays with selected owners; this adapter owns cancellation and actual drains. */
export class AiToolResources implements AiToolResourcesPort {
  readonly platform = process.platform;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly failed = new Set<SubprocessHandle>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly ctx: Context,
    private readonly workingDirectory: string,
  ) {}
  resourceCount(): number {
    return this.pending.size + this.failed.size;
  }
  hostSummary(id: string) {
    this.assertOpen();
    const catalog = this.ctx.get('catalog');
    if (!catalog)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Saved hosts are unavailable', 503);
    const host = catalog.getHost(id);
    return {
      id: host.id,
      name: host.name,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      authType: host.authType,
    };
  }
  recentOutput(id: string): string {
    this.assertOpen();
    return this.ctx.terminals.recentOutput(id);
  }
  memory() {
    this.assertOpen();
    return {
      platform: this.platform,
      totalBytes: totalmem(),
      freeBytes: freemem(),
      uptimeSeconds: uptime(),
      loadAverage: loadavg(),
    };
  }
  listRemote: AiToolResourcesPort['listRemote'] = (connectionId, path, signal) =>
    this.run(signal, async (owned) => {
      const value = await this.ctx.remoteFiles.list(
        { protocol: 'sftp', connectionId },
        path,
        owned,
      );
      owned.throwIfAborted();
      return value.entries;
    });
  readRemoteText: AiToolResourcesPort['readRemoteText'] = (connectionId, path, signal) =>
    this.run(signal, async (owned) => {
      const value = await this.ctx.remoteFiles.readText(
        { protocol: 'sftp', connectionId },
        path,
        owned,
      );
      owned.throwIfAborted();
      return value;
    });
  execReadOnly: AiToolResourcesPort['execReadOnly'] = (id, input) =>
    this.run(input.signal, (owned) => this.ctx.connections.exec(id, { ...input, signal: owned }));
  insertCommand: AiToolResourcesPort['insertCommand'] = (id, command, signal) =>
    this.run(signal, (owned) => this.ctx.terminals.executeCommand(id, command, owned));
  fixedCommand(
    file: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string }> {
    // These are the frozen product's diagnostics. No shell or arbitrary executable enters this seam.
    const allowed =
      (file === 'df' && args.length === 1 && args[0] === '-h') ||
      (file === 'ps' && args.join('\0') === '-axo\0pid,comm,%cpu,%mem') ||
      (file === 'wmic' && args.join('\0') === 'logicaldisk\0get\0size,freespace,caption') ||
      (file === 'tasklist' && args.length === 0) ||
      (file === 'systemctl' &&
        args.length === 3 &&
        args[0] === 'status' &&
        args[1] === '--no-pager' &&
        /^[a-zA-Z0-9_.@-]{1,100}$/.test(args[2]!)) ||
      (file === 'sc.exe' &&
        args.length === 2 &&
        args[0] === 'query' &&
        /^[a-zA-Z0-9_.@-]{1,100}$/.test(args[1]!));
    if (!allowed)
      return Promise.reject(
        new ApplicationError('CAPABILITY_UNAVAILABLE', 'Diagnostic command unavailable', 503),
      );
    return this.run(signal, async (owned) => {
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), 5000);
      timer.unref();
      let child: SubprocessHandle | undefined;
      try {
        const active = AbortSignal.any([owned, stop.signal]);
        active.throwIfAborted();
        child = this.ctx.subprocess.spawn({
          argv: [file, ...args],
          cwd: this.workingDirectory,
          graceMs: 500,
          signal: active,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 256 * 1024 },
            stderr: { maxBytes: 256 * 1024 },
          },
        });
        const result = await child.done;
        active.throwIfAborted();
        const stdout = child.collected.stdout?.readFrom(0);
        const stderr = child.collected.stderr?.readFrom(0);
        if (result.exitCode !== 0 || !stdout || !stderr || stdout.lossy || stderr.lossy)
          throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'Diagnostic command failed', 503);
        return {
          stdout: stdout.text.slice(0, 128 * 1024),
          stderr: stderr.text.slice(0, 16 * 1024),
        };
      } finally {
        clearTimeout(timer);
        if (child) await this.drainChild(child);
      }
    });
  }
  private async drainChild(child: SubprocessHandle): Promise<void> {
    try {
      await child.dispose();
      this.failed.delete(child);
    } catch {
      this.failed.add(child);
      throw new ApplicationError(
        'CAPABILITY_UNAVAILABLE',
        'AI diagnostic resources could not drain',
        503,
      );
    }
  }
  close(): Promise<void> {
    this.lifetime.abort();
    return (this.closing ??= (async () => {
      await Promise.allSettled([...this.pending]);
      await Promise.allSettled(
        [...this.failed].map(async (child) => {
          await child.dispose();
          this.failed.delete(child);
        }),
      );
      if (this.failed.size)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'AI tool resources could not drain',
          503,
        );
    })());
  }
  private assertOpen(): void {
    if (this.lifetime.signal.aborted)
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI tools closed', 503);
  }
  private run<T>(
    signal: AbortSignal | undefined,
    apply: (owned: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      this.assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.pending.size >= 64)
      return Promise.reject(new ApplicationError('CAPACITY_EXCEEDED', 'AI tool capacity reached'));
    const owned = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const task = Promise.resolve().then(() => {
      owned.throwIfAborted();
      return apply(owned);
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
}
