import type { SubprocessService, SubprocessHandle } from '@axterm/plugin-api/host';
import type { AiWorkspace } from '@axterm/plugin-api/ai';
import type { AiWorkspaceCommands, WorkspaceExecutionFacts } from '../ports/workspace-command.ts';
import { ApplicationError } from '../application/errors.ts';

export function workspaceExecutionFacts(
  command: string,
  workspace: AiWorkspace,
  platform = process.platform,
  comSpec = process.env.ComSpec,
): WorkspaceExecutionFacts {
  if (workspace.execution === 'ssh') {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return {
      shell: 'SSH login shell (server-selected)',
      command: workspace.commandDirectory
        ? `cd -- ${quote(workspace.commandDirectory)} && (\n${command}\n)`
        : command,
      cwd: workspace.commandDirectory,
      ...(workspace.connectionId ? { connectionId: workspace.connectionId } : {}),
    };
  }
  const executable = platform === 'win32' ? comSpec || 'cmd.exe' : '/bin/sh';
  return {
    shell:
      platform === 'win32' && /(?:^|[\\/])cmd\.exe$/iu.test(executable) ? 'cmd.exe' : executable,
    executable,
    arguments: platform === 'win32' ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command],
    command,
    cwd: workspace.commandDirectory,
  };
}
/** Commands, streams and process ranges are owned through ctx.subprocess, never a second spawn loop. */
export class OwnedWorkspaceCommands implements AiWorkspaceCommands {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly failed = new Set<SubprocessHandle>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly subprocess: Pick<SubprocessService, 'spawn'>,
    private readonly platform = process.platform,
    private readonly comSpec = process.env.ComSpec,
  ) {}
  facts(command: string, workspace: AiWorkspace) {
    return workspaceExecutionFacts(command, workspace, this.platform, this.comSpec);
  }
  resourceCount(): number {
    return this.pending.size + this.failed.size;
  }
  execute(
    command: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    if (this.lifetime.signal.aborted)
      return Promise.reject(
        new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI commands are closed', 503),
      );
    if (this.pending.size >= 64)
      return Promise.reject(
        new ApplicationError('CAPACITY_EXCEEDED', 'AI command capacity reached'),
      );
    const owned = AbortSignal.any([signal, this.lifetime.signal]);
    const task = Promise.resolve().then(() => this.run(command, cwd, owned));
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  close(): Promise<void> {
    this.lifetime.abort();
    return (this.closing ??= (async () => {
      await Promise.allSettled([...this.pending]);
      const outcomes = await Promise.allSettled(
        [...this.failed].map(async (child) => {
          await child.dispose();
          this.failed.delete(child);
        }),
      );
      if (outcomes.some((result) => result.status === 'rejected') || this.failed.size)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'AI command resources could not drain',
          503,
        );
    })());
  }
  private async drainChild(child: SubprocessHandle): Promise<void> {
    try {
      await child.dispose();
      this.failed.delete(child);
    } catch {
      this.failed.add(child);
      throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI command could not drain', 503);
    }
  }
  private async run(command: string, cwd: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!command || command.length > 8192 || command.includes('\0'))
      throw new ApplicationError('VALIDATION_ERROR', 'Invalid workspace command', 400);
    const stop = new AbortController();
    const active = AbortSignal.any([signal, stop.signal]);
    const argv =
      this.platform === 'win32'
        ? [this.comSpec || 'cmd.exe', '/d', '/s', '/c', `"${command}"`]
        : ['/bin/sh', '-c', command];
    const child = this.subprocess.spawn({
      argv,
      cwd,
      graceMs: 500,
      signal: active,
      ...(this.platform === 'win32' ? { windowsVerbatimArguments: true } : {}),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    });
    let count = 0;
    let out = 0;
    let err = 0;
    let failure: ApplicationError | undefined;
    const stdout = Buffer.alloc(128 * 1024);
    const stderr = Buffer.alloc(128 * 1024);
    const receive = (bytes: Buffer, target: 'stdout' | 'stderr') => {
      if (failure) return;
      count += bytes.byteLength;
      if (count > 128 * 1024) {
        failure = new ApplicationError(
          'PAYLOAD_TOO_LARGE',
          'AI command output exceeded its bound',
          413,
        );
        stop.abort();
        return;
      }
      if (target === 'stdout') {
        bytes.copy(stdout, out);
        out += bytes.byteLength;
      } else {
        bytes.copy(stderr, err);
        err += bytes.byteLength;
      }
    };
    const output = (bytes: Buffer) => receive(bytes, 'stdout');
    const errorOutput = (bytes: Buffer) => receive(bytes, 'stderr');
    const failed = () => {
      failure ??= new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI command stream failed', 503);
      stop.abort();
    };
    child.stdout?.on('data', output);
    child.stderr?.on('data', errorOutput);
    child.stdout?.on('error', failed);
    child.stderr?.on('error', failed);
    try {
      if (!child.stdout || !child.stderr)
        throw new ApplicationError('CAPABILITY_UNAVAILABLE', 'AI command streams unavailable', 503);
      const outcome = await child.done;
      if (failure) throw failure;
      signal.throwIfAborted();
      return {
        stdout: stdout.subarray(0, out).toString('utf8'),
        stderr: stderr.subarray(0, err).toString('utf8'),
        exitCode: outcome.exitCode,
      };
    } finally {
      try {
        await this.drainChild(child);
      } finally {
        child.stdout?.off('data', output);
        child.stderr?.off('data', errorOutput);
        child.stdout?.off('error', failed);
        child.stderr?.off('error', failed);
      }
    }
  }
}
