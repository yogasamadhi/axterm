import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Duplex } from 'node:stream';
import { proxyCommandSchema, type ProxyCommandConfig } from '@workspace/contracts';
import type { ProxyCommandRequest, ProxyCommandRunner } from '../../ports/proxy-command-runner';

const MAX_STDERR_BYTES = 8 * 1_024;

export type ProxyCommandErrorCode =
  | 'PROXY_COMMAND_INVALID'
  | 'PROXY_COMMAND_START_FAILED'
  | 'PROXY_COMMAND_FAILED'
  | 'PROXY_COMMAND_TIMEOUT'
  | 'PROXY_COMMAND_ABORTED';

export class ProxyCommandError extends Error {
  constructor(
    readonly code: ProxyCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProxyCommandError';
  }
}

export interface ExpandedProxyCommand {
  executable: string;
  arguments: string[];
}

export function expandProxyCommand(
  command: ProxyCommandConfig,
  target: ProxyCommandRequest['target'],
  username: string,
): ExpandedProxyCommand {
  let parsed: ProxyCommandConfig;
  try {
    parsed = proxyCommandSchema.parse(command);
  } catch {
    throw new ProxyCommandError('PROXY_COMMAND_INVALID', 'ProxyCommand is invalid');
  }
  if (
    !target.host ||
    /[\0\r\n]/u.test(target.host) ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65_535 ||
    !username ||
    /[\0\r\n]/u.test(username)
  )
    throw new ProxyCommandError('PROXY_COMMAND_INVALID', 'ProxyCommand target is invalid');
  return {
    executable: parsed.executable,
    arguments: parsed.arguments.map((argument) =>
      argument.replace(/%%|%[hpr]/gu, (placeholder) => {
        if (placeholder === '%h') return target.host;
        if (placeholder === '%p') return String(target.port);
        if (placeholder === '%r') return username;
        return '%';
      }),
    ),
  };
}

export class StdioProxyCommandRunner implements ProxyCommandRunner {
  async connect(request: ProxyCommandRequest): Promise<Duplex> {
    if (
      !Number.isInteger(request.timeoutMs) ||
      request.timeoutMs < 1 ||
      request.timeoutMs > 300_000
    )
      throw new ProxyCommandError('PROXY_COMMAND_INVALID', 'ProxyCommand timeout is invalid');
    if (request.signal?.aborted) throw abortedError();
    const expanded = expandProxyCommand(request.command, request.target, request.username);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(expanded.executable, expanded.arguments, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      throw new ProxyCommandError(
        'PROXY_COMMAND_START_FAILED',
        'ProxyCommand could not be started',
      );
    }
    try {
      await waitForSpawn(child, request.timeoutMs, request.signal);
    } catch (error) {
      stopChild(child);
      throw error;
    }
    return new ChildProcessDuplex(child, request.signal);
  }
}

class ChildProcessDuplex extends Duplex {
  private stderr = Buffer.alloc(0);
  private exited = false;
  private readonly abort = () => this.destroy(abortedError());

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly signal?: AbortSignal,
  ) {
    super({ allowHalfOpen: false });
    child.stdout.on('data', this.onData);
    child.stdout.once('end', this.onEnd);
    child.stdout.once('error', this.onStreamError);
    child.stdin.once('error', this.onStreamError);
    child.stderr.on('data', this.onStderr);
    child.once('exit', this.onExit);
    child.once('error', this.onProcessError);
    signal?.addEventListener('abort', this.abort, { once: true });
  }

  override _read(): void {
    this.child.stdout.resume();
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.exited || this.child.stdin.destroyed) {
      callback(new ProxyCommandError('PROXY_COMMAND_FAILED', 'ProxyCommand is no longer running'));
      return;
    }
    this.child.stdin.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.child.stdin.destroyed) callback();
    else this.child.stdin.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.cleanup();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    stopChild(this.child);
    callback(error);
  }

  private readonly onData = (chunk: Buffer) => {
    if (!this.push(chunk)) this.child.stdout.pause();
  };

  private readonly onEnd = () => this.push(null);

  private readonly onStderr = (chunk: Buffer) => {
    if (this.stderr.length >= MAX_STDERR_BYTES) return;
    const remaining = MAX_STDERR_BYTES - this.stderr.length;
    this.stderr = Buffer.concat([this.stderr, chunk.subarray(0, remaining)]);
  };

  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    this.exited = true;
    if (this.destroyed) return;
    if (code === 0) {
      this.push(null);
      return;
    }
    const detail = boundedFailureDetail(this.stderr);
    this.destroy(
      new ProxyCommandError(
        'PROXY_COMMAND_FAILED',
        `ProxyCommand exited ${signal ? `with signal ${signal}` : `with code ${code ?? 'unknown'}`}${detail}`,
      ),
    );
  };

  private readonly onProcessError = () =>
    this.destroy(
      new ProxyCommandError('PROXY_COMMAND_FAILED', 'ProxyCommand process failed after start'),
    );

  private readonly onStreamError = () =>
    this.destroy(new ProxyCommandError('PROXY_COMMAND_FAILED', 'ProxyCommand stream failed'));

  private cleanup(): void {
    this.signal?.removeEventListener('abort', this.abort);
    this.child.stdout.off('data', this.onData);
    this.child.stdout.off('end', this.onEnd);
    this.child.stdout.off('error', this.onStreamError);
    this.child.stdin.off('error', this.onStreamError);
    this.child.stderr.off('data', this.onStderr);
    this.child.off('exit', this.onExit);
    this.child.off('error', this.onProcessError);
  }
}

function waitForSpawn(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(timeoutError())), timeoutMs);
    timer.unref();
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.off('spawn', spawned);
      child.off('error', failed);
      signal?.removeEventListener('abort', aborted);
    };
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const spawned = () => finish(resolve);
    const failed = () =>
      finish(() =>
        reject(
          new ProxyCommandError('PROXY_COMMAND_START_FAILED', 'ProxyCommand could not be started'),
        ),
      );
    const aborted = () => finish(() => reject(abortedError()));
    child.once('spawn', spawned);
    child.once('error', failed);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function boundedFailureDetail(value: Buffer): string {
  const text = value
    .toString('utf8')
    .replace(/[\0\r\n\t]+/gu, ' ')
    .trim();
  return text ? `: ${text}` : '';
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  if (!child.killed && child.exitCode === null) child.kill();
}

function abortedError(): ProxyCommandError {
  return new ProxyCommandError('PROXY_COMMAND_ABORTED', 'ProxyCommand was canceled');
}

function timeoutError(): ProxyCommandError {
  return new ProxyCommandError('PROXY_COMMAND_TIMEOUT', 'ProxyCommand start timed out');
}
