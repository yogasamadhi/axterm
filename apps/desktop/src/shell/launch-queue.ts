import { randomUUID } from 'node:crypto';
import type { DesktopLaunch } from '@axterm/plugin-api/session-intents';
import { parseQuickConnect } from '@axterm/plugin-api/session-intents';
import { NativeError, type ShellFileGrantCapabilities } from '@axterm/infra-desktop-native';
import { materializeDesktopCommandLine, type DesktopCommandLineResult } from './command-line.ts';
type Request = Extract<DesktopCommandLineResult, { kind: 'session' }>;
/** Only real OS ingress feeds this bounded native-input queue. No workflow executes in the shell. */
export class DesktopLaunchQueue {
  private readonly queue: { windowId: string; request: Request; expiresAt: number }[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly active = new Set<Promise<DesktopLaunch | null>>();
  private readonly lifetime = new AbortController();
  enqueue(windowId: string, request: Request): boolean {
    this.sweep();
    if (
      this.lifetime.signal.aborted ||
      this.queue.length + this.active.size >= 32 ||
      !parseQuickConnect(request.source)
    )
      return false;
    this.queue.push({
      windowId,
      request: structuredClone(request),
      expiresAt: Date.now() + 60_000,
    });
    for (const wake of [...this.waiters]) wake();
    return true;
  }
  next(
    windowId: string,
    files: ShellFileGrantCapabilities,
    signal: AbortSignal,
  ): Promise<DesktopLaunch | null> {
    if (this.lifetime.signal.aborted) return Promise.reject(new NativeError('CLOSED'));
    if (this.active.size >= 8) return Promise.reject(new NativeError('LIMIT'));
    const owned = AbortSignal.any([this.lifetime.signal, signal]);
    const task = this.take(windowId, files, owned);
    this.active.add(task);
    void task.finally(() => this.active.delete(task)).catch(() => {});
    return task;
  }
  retireWindow(id: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--)
      if (this.queue[i]!.windowId === id) this.queue.splice(i, 1);
  }
  clear(): void {
    this.queue.length = 0;
  }
  resourceCount(): number {
    return this.queue.length + this.active.size + this.waiters.size;
  }
  async close(): Promise<void> {
    this.lifetime.abort();
    this.clear();
    for (const wake of [...this.waiters]) wake();
    await Promise.allSettled([...this.active]);
  }
  private sweep(): void {
    for (let i = this.queue.length - 1; i >= 0; i--)
      if (this.queue[i]!.expiresAt <= Date.now()) this.queue.splice(i, 1);
  }
  private async take(
    windowId: string,
    files: ShellFileGrantCapabilities,
    signal: AbortSignal,
  ): Promise<DesktopLaunch | null> {
    signal.throwIfAborted();
    this.sweep();
    if (!this.queue.some((item) => item.windowId === windowId))
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.waiters.delete(finish);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, 1000);
        this.waiters.add(finish);
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
      });
    signal.throwIfAborted();
    this.sweep();
    const index = this.queue.findIndex((item) => item.windowId === windowId);
    if (index < 0) return null;
    const { request } = this.queue.splice(index, 1)[0]!;
    const granted: string[] = [];
    let delivered = false;
    const create = async (path: string, kind: 'file' | 'directory') => {
      const grant = await files.registry.createTrustedPath(
        path,
        kind,
        kind === 'directory' ? ['read', 'write'] : ['read'],
        // Retained CLI behavior: writable directories live with their view/generation.
        kind === 'directory' ? undefined : 60_000,
        signal,
      );
      granted.push(grant.grantId);
      signal.throwIfAborted();
      return grant.grantId;
    };
    try {
      const privateKeyGrantId = request.privateKeyPath
        ? await create(request.privateKeyPath, 'file')
        : undefined;
      const initialDirectoryGrantId = request.initialDirectoryPath
        ? await create(request.initialDirectoryPath, 'directory')
        : undefined;
      const batchOperationGrantId = request.batchOperationPath
        ? await create(request.batchOperationPath, 'file')
        : undefined;
      const source = materializeDesktopCommandLine(request, {
        ...(privateKeyGrantId ? { privateKeyGrantId } : {}),
        ...(initialDirectoryGrantId ? { initialDirectoryGrantId } : {}),
        ...(batchOperationGrantId ? { batchOperationGrantId } : {}),
      });
      if (!parseQuickConnect(source)) throw new NativeError('INVALID');
      signal.throwIfAborted();
      delivered = true;
      return { id: randomUUID(), source };
    } finally {
      if (!delivered) for (const id of granted) files.registry.revoke(id);
    }
  }
}
