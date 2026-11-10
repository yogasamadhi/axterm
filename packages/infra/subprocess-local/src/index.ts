// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from packages/subprocess/subprocess-local/src/index.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
/**
 * Local Service Provider for the subprocess capability seam. Each spawn owns a
 * platform-selected managed range with the spec's per-stream stdio dispositions.
 * Normal disposal terminates and joins live ranges; Node's synchronous exit
 * phase force-stops any ranges the service still owns. It has no config: every
 * disposition and limit arrives on the spec, so deployment-varying choices
 * stay with the caller's config (the bash executor's, the LSP host's, …).
 * @module @axterm/infra-subprocess-local
 */

import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { delimiter, extname, isAbsolute, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import type { Context } from '@deepseek-ai/cordis';
import { RegistrationLifetime } from '@axterm/infra-scope';
import type * as NodePty from 'node-pty';
import type { IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';
import { createLazyRequire } from '@axterm/infra-lazy-require';
import { SubprocessRuntime, SubprocessExecutableNotFoundError } from '@axterm/infra-subprocess';
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalEnvironment,
  SubprocessTerminalSpawnSpec,
} from '@axterm/infra-subprocess';
import {
  bindManagedProcess,
  childEnv,
  spawnSubprocess,
  validateSubprocessSpec,
  validateExecutionLocation,
} from './spawn.ts';
import { logSpillFailure, prepareManagedProcessBinding } from './output.ts';
import type { LocalSubprocessHandle, SpawnInternals } from './spawn.ts';
import {
  confirmLinuxManager,
  LinuxScopeNotStartedError,
  launchLinuxScope,
  linuxManagerListener,
  prepareLinuxTerminalScope,
  probeLinuxNative,
  signalLinuxDirectProcess,
  systemdRunIdentity,
} from './linux-scope.ts';
import { LinuxScopeSelector } from './linux-scope-selector.ts';
import type { LinuxScopeDecision } from './linux-scope-selector.ts';
import { launchWindowsJob, probeWindowsJob } from './windows-job.ts';
import { targetEnvironment } from './runner-launch.ts';
import { createProcessInspector } from './process-inspector.ts';
import type { ProcessInspector } from './process-inspector.ts';
import { LocalTerminalHandle } from './terminal.ts';
import { prepareShellActivity } from './shell-activity.ts';

const requireNodePty = createLazyRequire<typeof NodePty>('node-pty', import.meta.url);

/**
 * Local subprocess service: platform-selected managed ranges, Node-shaped stdio
 * dispositions (raw pipes, inherit, bounded tail-keep collection with spill
 * files), credential-scrubbed environment, and provider-owned range signalling.
 * POSIX paths stage TERM before KILL; Windows paths terminate immediately.
 * JavaScript-observable host exit also performs synchronous final termination.
 */
export class LocalSubprocessRuntime extends SubprocessRuntime {
  /** Live handles retained for normal disposal and synchronous host-exit finalization. */
  private live = new Set<LocalSubprocessHandle>();
  private readonly retained = new Set<LocalSubprocessHandle>();
  private readonly failed = new Set<object>();
  private readonly registrations: RegistrationLifetime;
  private readonly lifetime = new AbortController();
  private readonly opening = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  /** Live terminals retained through normal quiescence or host-exit finalization. */
  private terminals = new Set<LocalTerminalHandle>();
  /** Caller endpoints retained until close, independently of managed process lifetime. */
  private controlChannels = new Set<Duplex>();
  /** Test hook: process, spill, and platform operations forwarded to spawnSubprocess. */
  internals: SpawnInternals = {};
  /** Provider-lifetime latch suppressing repeated weaker-containment warnings. */
  private fallbackWarningIssued = false;
  /**
   * Linux native containment decisions. Each probe is a spawnSync that blocks the event loop and forks the
   * host, so the selector reruns it only after an event invalidates the previous verdict.
   */
  private readonly linuxScope = new LinuxScopeSelector({
    probe: () => probeLinuxNative(),
    managerListener: () => linuxManagerListener(),
    confirmManager: () => confirmLinuxManager(),
    launcherIdentity: () => systemdRunIdentity(),
  });
  /** Scope decision of the launch in progress; selectContainmentMode sets it immediately before the launch reads it. */
  private linuxScopeDecision: Extract<LinuxScopeDecision, { kind: 'scope' }> | undefined;
  /** Test hook for platform process inspection; production resolves lazily on terminal spawn. */
  terminalInspector: ProcessInspector | undefined;

  constructor(ctx: Context) {
    super(ctx);
    this.registrations = new RegistrationLifetime(ctx);
    ctx.inject(['desktopTaskInspection'], (scope) => {
      scope.desktopTaskInspection.register('subprocess', {
        inspect: (signal) => {
          signal.throwIfAborted();
          return { active: this.resourceCount() > 0 };
        },
        dispose: () => this.close(),
      });
    });
    ctx.effect(() => {
      const onHostExit = (): void => {
        this.terminateForHostExit();
      };
      process.prependListener('exit', onHostExit);
      return async () => {
        await this.close();
        process.off('exit', onHostExit);
      };
    }, 'local subprocess teardown');
  }

  /** Spill failures reach the plugin logger; the log line is the only trace of why a result has no spill path. */
  private readonly reportSpillFailure = logSpillFailure(this.ctx.logger, 'subprocess-local');

  private terminateForHostExit(): void {
    for (const handle of this.live) {
      try {
        handle.terminateForHostExit();
      } catch {
        // Host exit cannot await or report one target; continue with the rest.
      }
    }
    for (const terminal of this.terminals) {
      try {
        terminal.terminateForHostExit();
      } catch {
        // One terminal must not prevent final termination of another target.
      }
    }
  }

  resourceCount(): number {
    return this.live.size + this.terminals.size + this.opening.size + this.failed.size;
  }

  close(): Promise<void> {
    this.lifetime.abort();
    return (this.closing ??= (async () => {
      await Promise.allSettled([...this.opening]);
      await this.disposeManagedProcesses();
    })());
  }

  private assertOpen(): void {
    if (this.lifetime.signal.aborted) throw new Error('SUBPROCESS_CLOSED');
  }

  private async disposeManagedProcesses(): Promise<void> {
    // Request termination, then await MANAGED-RANGE exit — not just the
    // direct command's settlement — so even a surviving descendant cannot
    // outlive the fiber. Keep both sets authoritative while these waits are
    // pending so a shorter process-level exit bound can still force-kill them.
    const pending: Promise<unknown>[] = [];
    for (const handle of this.retained) pending.push(handle.dispose());
    for (const terminal of this.terminals) {
      pending.push(
        terminal.terminate().then(() => {
          this.terminals.delete(terminal);
        }),
      );
    }
    const outcomes = await Promise.allSettled(pending);
    await Promise.all(
      [...this.controlChannels].map(
        (control) =>
          new Promise<void>((resolveClose) => {
            if (control.closed) {
              resolveClose();
              return;
            }
            control.once('close', () => {
              resolveClose();
            });
            control.destroy();
          }),
      ),
    );
    this.controlChannels.clear();
    const failures: unknown[] = [];
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') failures.push(outcome.reason);
    }
    if (this.failed.size > 0 && failures.length === 0)
      failures.push(new Error('SUBPROCESS_DRAIN_FAILED'));
    if (failures.length > 0) this.terminateForHostExit();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'local subprocess teardown failed');
  }

  private inspectOwned<T>(
    signal: AbortSignal | undefined,
    inspect: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    if (this.opening.size >= 128) return Promise.reject(new Error('SUBPROCESS_CAPACITY'));
    const cancel = new AbortController();
    const combined = AbortSignal.any([
      this.lifetime.signal,
      cancel.signal,
      ...(signal ? [signal] : []),
    ]);
    let work!: Promise<T>;
    const unregister = this.registrations.owner(this.ctx).effect(() => {
      work = Promise.resolve().then(async () => {
        if (combined.aborted) throw new Error('SUBPROCESS_CANCELLED');
        const result = await inspect(combined);
        if (combined.aborted) throw new Error('SUBPROCESS_CANCELLED');
        return result;
      });
      return async () => {
        cancel.abort();
        await work.catch(() => {});
      };
    }, 'owned subprocess inspection');
    this.opening.add(work);
    const release = () => {
      this.opening.delete(work);
    };
    void work.then(release, release);
    return work.finally(unregister);
  }

  resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.inspectOwned(signal, (ownedSignal) =>
      this.resolveExecutableOwned(command, env, ownedSignal),
    );
  }

  private async resolveExecutableOwned(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    this.assertOpen();
    if (typeof command !== 'string' || !command || command.length > 4096 || command.includes('\0'))
      throw new Error('SUBPROCESS_EXECUTABLE_INVALID');
    signal?.throwIfAborted();
    const environment = childEnv(env);
    const absolute = isAbsolute(command);
    if (
      !absolute &&
      (command.includes('/') || (process.platform === 'win32' && command.includes('\\')))
    ) {
      throw new Error(
        `subprocess-local: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`,
      );
    }
    const candidates = absolute ? [command] : this.executableCandidates(command, environment);
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        await access(candidate, constants.X_OK);
        signal?.throwIfAborted();
        return candidate;
      } catch {
        // Try the next PATH candidate; the final miss receives one stable error.
      }
    }
    signal?.throwIfAborted();
    throw new SubprocessExecutableNotFoundError(
      absolute
        ? `subprocess-local: command ${JSON.stringify(command)} is not an executable file`
        : `subprocess-local: command ${JSON.stringify(command)} was not found on PATH`,
    );
  }

  private executableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
    const path = environmentValue(env, 'PATH') ?? '';
    const extensions =
      process.platform === 'win32' && extname(command) === ''
        ? (environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')
        : [''];
    return path
      .split(delimiter)
      .flatMap((directory) =>
        extensions.map((extension) => resolve(process.cwd(), directory, command + extension)),
      );
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.assertOpen();
    if (this.retained.size >= 128) throw new Error('SUBPROCESS_CAPACITY');
    const caller = this.ctx;
    let handle!: LocalSubprocessHandle;
    let drain!: () => Promise<void>;
    const unregister = this.registrations.owner(caller).effect(() => {
      handle = this.spawnOwned(spec);
      this.retained.add(handle);
      const nativeDispose = handle.dispose.bind(handle);
      let closing: Promise<void> | undefined;
      drain = () =>
        (closing ??= nativeDispose().then(
          () => {
            this.retained.delete(handle);
            this.live.delete(handle);
            this.failed.delete(handle);
          },
          () => {
            this.failed.add(handle);
            throw new Error('SUBPROCESS_DRAIN_FAILED');
          },
        ));
      return () => drain();
    }, 'owned subprocess range/output');
    handle.dispose = async () => {
      await drain();
      await unregister();
    };
    return handle;
  }

  private spawnOwned(spec: SubprocessSpawnSpec): LocalSubprocessHandle {
    validateSubprocessSpec(spec);
    const env = targetEnvironment(spec);
    const containmentMode = this.selectContainmentMode('ordinary');
    let handle: LocalSubprocessHandle;
    const internals: SpawnInternals = {
      ...this.internals,
      onSpillFailure: this.reportSpillFailure,
    };
    if (containmentMode === 'fallback') {
      handle = spawnSubprocess(spec, internals);
    } else {
      const binding = prepareManagedProcessBinding(internals);
      const linuxScope = containmentMode === 'linux-scope' ? this.linuxScopeDecision : undefined;
      try {
        const launch =
          linuxScope === undefined
            ? launchWindowsJob(spec, env)
            : launchLinuxScope(spec, env, linuxScope.literalArgv);
        handle = bindManagedProcess(spec, launch, binding);
      } catch (error) {
        binding.dispose();
        throw error;
      }
      if (linuxScope !== undefined) this.watchLinuxScopeStart(handle.done, linuxScope.generation);
    }
    this.live.add(handle);
    const control = handle.control;
    if (control !== undefined) {
      this.controlChannels.add(control);
      control.once('close', () => {
        this.controlChannels.delete(control);
      });
    }
    // Release ownership only once the whole managed range is gone, not at direct-child
    // settlement — a TERM-trapping helper that outlives the leader must stay
    // owned so teardown can still escalate it. For the common no-survivor
    // case waitForExit resolves immediately after settlement.
    const release = (): Promise<void> =>
      handle.waitForExit().then(() => {
        this.live.delete(handle);
      });
    void handle.done.then(release, release).catch(() => {});
    return handle;
  }

  /** Probe again before the next launch when a scope launched under generation never started its target. */
  private watchLinuxScopeStart(done: Promise<unknown>, generation: number): void {
    void done.catch((error: unknown) => {
      if (error instanceof LinuxScopeNotStartedError) this.linuxScope.scopeNotStarted(generation);
    });
  }

  private selectContainmentMode(
    kind: 'ordinary' | 'terminal',
  ): 'linux-scope' | 'windows-job' | 'fallback' {
    const platform = this.internals.platform ?? process.platform;
    let fallbackReason: string | undefined;
    if (platform === 'linux') {
      const decision = this.linuxScope.select();
      const probe = decision.probe === undefined ? '' : `, probed after ${decision.probe}`;
      this.ctx.logger.debug(
        `linux native containment: ${decision.kind} (${decision.reason}${probe})`,
      );
      if (decision.kind === 'scope') {
        this.linuxScopeDecision = decision;
        return 'linux-scope';
      }
      fallbackReason = 'the current user-systemd scope or private bootstrap is unavailable';
    }
    if (kind === 'ordinary' && platform === 'win32') {
      const available = probeWindowsJob();
      if (available) return 'windows-job';
    }
    this.warnFallback(platform, kind, fallbackReason);
    return 'fallback';
  }

  private warnFallback(
    platform: NodeJS.Platform,
    kind: 'ordinary' | 'terminal',
    selectedReason?: string,
  ): void {
    if (this.fallbackWarningIssued) return;
    this.fallbackWarningIssued = true;
    const reason =
      selectedReason ??
      (platform === 'darwin'
        ? 'macOS has no supported persistent process-range owner'
        : platform === 'win32'
          ? kind === 'terminal'
            ? 'Windows ConPTY remains outside Job containment'
            : 'the Win32 Job runner is unavailable'
          : `platform ${platform} has no native managed range`);
    this.ctx.logger.warn(
      `subprocess-local is using weaker process-tree containment because ${reason}; descendants that escape the process group or direct-parent tree are not guaranteed to terminate or delay waitForExit()`,
    );
  }

  /** @inheritdoc */
  // oxlint-disable-next-line typescript/require-await -- Keep the provider promise rejection semantics for cancelled inspection.
  terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    return this.inspectOwned(signal, () => this.readTerminalEnvironment());
  }

  private async readTerminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    const platform = process.platform === 'win32' ? 'windows' : 'posix';
    const defaultShell =
      platform === 'windows'
        ? process.env.ComSpec || undefined
        : process.env.SHELL || userInfo().shell || undefined;
    return { platform, ...(defaultShell === undefined ? {} : { defaultShell }) };
  }

  // Local PTY allocation is synchronous, but the provider contract permits remote asynchronous allocation.
  // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
  spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    this.assertOpen();
    if (this.terminals.size + this.opening.size >= 64)
      return Promise.reject(new Error('SUBPROCESS_CAPACITY'));
    const caller = this.ctx;
    const cancellation = new AbortController();
    let handle: SubprocessTerminalHandle | undefined;
    let work!: Promise<SubprocessTerminalHandle>;
    let drain!: () => Promise<void>;
    const unregister = this.registrations.owner(caller).effect(() => {
      const signal = AbortSignal.any([
        this.lifetime.signal,
        cancellation.signal,
        ...(spec.signal ? [spec.signal] : []),
      ]);
      work = this.spawnTerminalOwned({ ...spec, signal }).then(async (value) => {
        handle = value;
        const nativeTerminate = value.terminate.bind(value);
        let closing: Promise<void> | undefined;
        drain = () =>
          (closing ??= nativeTerminate().then(
            () => {
              this.failed.delete(value);
            },
            (cause: unknown) => {
              this.failed.add(value);
              throw new Error('SUBPROCESS_TERMINAL_DRAIN_FAILED', { cause });
            },
          ));
        if (signal.aborted) {
          await drain();
          throw new Error('SUBPROCESS_CANCELLED');
        }
        return value;
      });
      return async () => {
        cancellation.abort();
        await work.catch(() => {});
        if (handle) await drain();
      };
    }, 'owned subprocess terminal allocation/range');
    this.opening.add(work);
    const result = work.then(
      (value) => {
        value.terminate = async () => {
          await drain();
          await unregister();
        };
        return value;
      },
      async (error: unknown) => {
        await unregister();
        throw error;
      },
    );
    void result.then(
      () => this.opening.delete(work),
      () => this.opening.delete(work),
    );
    return result;
  }

  private async spawnTerminalOwned(
    spec: SubprocessTerminalSpawnSpec,
  ): Promise<SubprocessTerminalHandle> {
    validateExecutionLocation(spec);
    if (
      !Number.isInteger(spec.cols) ||
      spec.cols < 1 ||
      spec.cols > 1000 ||
      !Number.isInteger(spec.rows) ||
      spec.rows < 1 ||
      spec.rows > 1000 ||
      typeof spec.terminalType !== 'string' ||
      !spec.terminalType ||
      spec.terminalType.length > 128 ||
      spec.terminalType.includes('\0') ||
      (spec.binary !== undefined && typeof spec.binary !== 'boolean') ||
      (spec.shellActivity !== undefined && typeof spec.shellActivity !== 'boolean')
    )
      throw new Error('SUBPROCESS_TERMINAL_SPEC_INVALID');
    const file = spec.argv[0];
    if (file === undefined || file.length === 0) {
      throw new Error('subprocess-local: terminal argv must contain a program');
    }
    spec.signal?.throwIfAborted();
    const inspector = this.terminalInspector ?? createProcessInspector();
    const containmentMode = this.selectContainmentMode('terminal');
    const env = targetEnvironment(spec);
    const platform = this.internals.platform ?? process.platform;
    if (spec.binary && platform === 'win32')
      throw new Error('SUBPROCESS_BINARY_TERMINAL_UNSUPPORTED');
    const activity = prepareShellActivity(spec, env, platform);
    const launch =
      activity === undefined ? spec : { ...spec, argv: activity.argv, env: activity.env };
    const options: IPtyForkOptions | IWindowsPtyForkOptions = {
      name: spec.terminalType,
      ...(spec.binary && platform !== 'win32' ? { encoding: null } : {}),
      rows: spec.rows,
      cols: spec.cols,
      cwd: spec.cwd,
      env: { ...(activity?.env ?? env), TERM: spec.terminalType },
      // Windows' own console host (the standby pool runs Server 2022 and
      // Windows 10 22H2) renders the persistent-pwsh prompt tail in a form the
      // readiness path cannot match; the console host node-pty ships emits it
      // verbatim. Keep the bundled console-host selection explicit.
      ...(platform === 'win32' ? { useConptyDll: true } : {}),
    };
    const linuxScope = containmentMode === 'linux-scope' ? this.linuxScopeDecision : undefined;
    let scope: ReturnType<typeof prepareLinuxTerminalScope> | undefined;
    let terminal: NodePty.IPty;
    try {
      scope =
        linuxScope === undefined
          ? undefined
          : prepareLinuxTerminalScope(
              launch,
              { ...(activity?.env ?? env), PWD: spec.cwd, TERM: spec.terminalType },
              linuxScope.literalArgv,
            );
      if (scope !== undefined) {
        options.cwd = scope.cwd;
        options.env = scope.env;
      }
      terminal = requireNodePty().spawn(
        scope?.command ?? file,
        scope?.args ?? [...launch.argv.slice(1)],
        options,
      );
    } catch (error) {
      scope?.cleanup();
      activity?.dispose();
      throw error;
    }
    const allocated: { handle?: LocalTerminalHandle } = {};
    const directSettlement = Promise.withResolvers<void>();
    const owner = scope?.bindOwner({
      running: () => allocated.handle?.running ?? true,
      settled: directSettlement.promise,
      // node-pty swallows signal errors; the scope owner requires their delivery result.
      signal: (signal) =>
        signalLinuxDirectProcess(terminal.pid, () => process.kill(terminal.pid, signal)),
    });
    const handle = new LocalTerminalHandle(
      terminal,
      inspector,
      spec.graceMs,
      platform,
      owner,
      scope?.resolveOutcome,
      activity,
      () => {
        if (allocated.handle) this.terminals.delete(allocated.handle);
      },
      spec.shellActivity === true,
    );
    allocated.handle = handle;
    this.terminals.add(handle);
    if (linuxScope !== undefined) this.watchLinuxScopeStart(handle.done, linuxScope.generation);
    const release = async (): Promise<void> => {
      // terminate() can wait on this direct-exit promise.
      directSettlement.resolve();
      if (spec.shellActivity === true) return;
      await handle.terminate();
      this.terminals.delete(handle);
    };
    void handle.done.then(release, release).catch(() => {});
    return handle;
  }
}

/** Read a Windows environment key using the platform's case-insensitive semantics. */
function environmentValue(env: NodeJS.ProcessEnv, name: 'PATH' | 'PATHEXT'): string | undefined {
  const exact = env[name];
  if (exact !== undefined || process.platform !== 'win32') return exact;
  const normalized = name.toUpperCase();
  return Object.entries(env).find(([key]) => key.toUpperCase() === normalized)?.[1];
}

export default LocalSubprocessRuntime;
