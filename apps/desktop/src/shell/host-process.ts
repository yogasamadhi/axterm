import type { NativeDesktopLifecycle } from '@axterm/infra-desktop-native';
import type { DesktopUpdaterPort } from '@axterm/infra-desktop-native';
import type { NativeWebViews } from '@axterm/infra-desktop-native';
import type { NativeDesktopWindows } from '@axterm/infra-desktop-native';
import type { DesktopLaunch } from '@axterm/plugin-api/session-intents';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createDesktopAuthentication } from '@axterm/infra-connection';
import {
  ShellVaultCapabilities,
  nodeIpcWire,
  type NativeFileChooser,
  type NativeFileApplications,
  type ShellFileGrantCapabilities,
} from '@axterm/infra-desktop-native';
import type { EncryptedVault } from '@axterm/infra-credential-vault';
import { parseHostControl, type HostControl } from '@axterm/desktop-host/protocol';
import type { HostAuthority } from './window-policy.ts';
export type HostReady = Extract<HostControl, { type: 'ready' }>;
export interface HostProcessOptions {
  readonly executable: string;
  readonly entry: string;
  readonly home: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly vault: EncryptedVault;
  readonly fatal: () => void;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly fileChooser?: NativeFileChooser;
  readonly fileApplications?: NativeFileApplications;
  readonly openExternal?: (url: string) => Promise<void>;
  readonly updater?: DesktopUpdaterPort;
  readonly lifecycle?: NativeDesktopLifecycle;
  readonly webViews?: NativeWebViews & { dispose(): Promise<void> };
  readonly windows?: NativeDesktopWindows & { dispose(): Promise<void> };
  readonly nextLaunch?: (
    windowId: string,
    files: ShellFileGrantCapabilities,
    signal: AbortSignal,
  ) => Promise<DesktopLaunch | null>;
}
/** Supervises one inherited-IPC Host; this process never dispatches business methods. */
export class DesktopHostProcess {
  readonly generation = randomUUID();
  private readonly child: ChildProcess;
  private readonly native: ShellVaultCapabilities;
  private readonly startup = Promise.withResolvers<HostReady>();
  private readonly exited = Promise.withResolvers<void>();
  private auth: ReturnType<typeof createDesktopAuthentication> | undefined;
  private status: 'starting' | 'ready' | 'failed' | 'stopped' = 'starting';
  private startingResult: HostReady | undefined;
  private closing: Promise<void> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly shutdownTimeoutMs: number;
  private inspection:
    | {
        readonly id: string;
        readonly result: PromiseWithResolvers<{ active: boolean; known: boolean }>;
        readonly timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  constructor(private readonly options: HostProcessOptions) {
    const startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    if (
      ![startupTimeoutMs, this.shutdownTimeoutMs].every(
        (value) => Number.isSafeInteger(value) && value > 0 && value <= 120_000,
      )
    )
      throw new Error('DESKTOP_HOST_DEADLINE_INVALID');
    this.auth = createDesktopAuthentication(this.generation);
    // Always observe rejection, including a failure before the first window requests bootstrap.
    void this.startup.promise.catch(() => {});
    this.child = spawn(options.executable, ['--expose-internals', options.entry], {
      env: { ...options.environment, AXTERM_HOME: options.home, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    this.native = new ShellVaultCapabilities(
      options.vault,
      nodeIpcWire(this.child),
      this.generation,
      undefined,
      options.fileChooser,
      () => {
        if (!this.closing) this.fail();
      },
      join(options.home, 'desktop', 'file-imports', this.generation),
      options.fileApplications,
      options.nextLaunch,
      options.webViews,
      options.openExternal,
      options.windows,
      options.updater,
      options.lifecycle,
    );
    this.child.stdout?.resume();
    this.child.stderr?.resume();
    this.child.on('message', this.receive);
    this.child.once('error', () => this.fail());
    this.child.once('close', () => {
      this.exited.resolve();
      if (!this.closing) this.fail();
    });
    this.startupTimer = setTimeout(() => this.fail(), startupTimeoutMs);
    this.startupTimer.unref();
    void this.send({
      kind: 'axterm-desktop-control',
      version: 1,
      generation: this.generation,
      type: 'initialize',
      home: options.home,
      verifier: this.auth.verifier,
    }).catch(() => this.fail());
  }
  ready(): Promise<HostReady> {
    return this.startup.promise;
  }
  authority(): HostAuthority | undefined {
    return this.status === 'ready' && this.auth && this.startingResult
      ? {
          generation: this.generation,
          origin: this.startingResult.origin,
          credential: this.auth.credential,
        }
      : undefined;
  }
  issueDirectoryDrop(path: string) {
    return this.native.files.issueDirectoryDrop(path);
  }
  discardDirectoryDrop(ticket: string) {
    this.native.files.discardDirectoryDrop(ticket);
  }
  snapshot(): { phase: string; generation: string; origin?: string } {
    return {
      phase: this.status,
      generation: this.generation,
      ...(this.startingResult ? { origin: this.startingResult.origin } : {}),
    };
  }
  inspect(): Promise<{ active: boolean; known: boolean }> {
    if (this.native.files.resourceCount() > 0)
      return Promise.resolve({ active: true, known: true });
    if (this.inspection) return this.inspection.result.promise;
    if (this.status !== 'ready') return Promise.resolve({ active: true, known: false });
    const id = randomUUID();
    const result = Promise.withResolvers<{ active: boolean; known: boolean }>();
    // Keep the one admitted request until its real response/retirement, even if the caller times out.
    const timer = setTimeout(() => result.resolve({ active: true, known: false }), 1500);
    this.inspection = { id, result, timer };
    void this.send({
      kind: 'axterm-desktop-control',
      version: 1,
      generation: this.generation,
      type: 'inspect-quit',
      id,
    }).catch(() => this.settleInspection({ active: true, known: false }));
    return result.promise;
  }
  stop(): Promise<void> {
    return (this.closing ??= (async () => {
      this.clearStartup();
      this.status = 'stopped';
      this.auth = undefined;
      this.startup.reject(new Error('DESKTOP_HOST_STOPPED'));
      this.settleInspection({ active: true, known: false });
      const timer = setTimeout(() => this.child.kill('SIGKILL'), this.shutdownTimeoutMs);
      try {
        if (this.child.connected)
          await this.send({
            kind: 'axterm-desktop-control',
            version: 1,
            generation: this.generation,
            type: 'shutdown',
          }).catch(() => this.child.kill('SIGKILL'));
        else if (this.child.exitCode === null) this.child.kill('SIGKILL');
        await this.exited.promise;
        await this.native.close();
      } finally {
        clearTimeout(timer);
        this.child.off('message', this.receive);
      }
    })());
  }
  private readonly receive = (value: unknown): void => {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('kind' in value) ||
      value.kind !== 'axterm-desktop-control'
    )
      return;
    let message: HostControl;
    try {
      message = parseHostControl(value);
    } catch {
      this.fail();
      return;
    }
    if (message.generation !== this.generation) {
      this.fail();
      return;
    }
    if (message.type === 'ready') {
      if (this.status !== 'starting') {
        this.fail();
        return;
      }
      this.clearStartup();
      this.startingResult = message;
      this.status = 'ready';
      this.startup.resolve(message);
    } else if (message.type === 'inspection') {
      if (this.inspection?.id === message.id)
        this.settleInspection({ active: message.active, known: message.known });
    } else if (message.type === 'failed') this.fail();
  };
  private settleInspection(value: { active: boolean; known: boolean }): void {
    const pending = this.inspection;
    this.inspection = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.result.resolve(value);
    }
  }
  private fail(): void {
    if (this.closing || this.status === 'failed' || this.status === 'stopped') return;
    this.clearStartup();
    this.status = 'failed';
    this.auth = undefined;
    this.startup.reject(new Error('DESKTOP_HOST_FAILED'));
    this.settleInspection({ active: true, known: false });
    try {
      this.options.fatal();
    } catch {
      console.warn('[desktop] Failure notification failed');
    }
  }
  private clearStartup(): void {
    clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
  }
  private send(value: object): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.child.connected) {
        reject(new Error('DESKTOP_HOST_DISCONNECTED'));
        return;
      }
      try {
        this.child.send(value, (error) =>
          error ? reject(new Error('DESKTOP_HOST_SEND_FAILED')) : resolve(),
        );
      } catch {
        reject(new Error('DESKTOP_HOST_SEND_FAILED'));
      }
    });
  }
}
