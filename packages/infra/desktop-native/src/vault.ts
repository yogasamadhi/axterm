import type { NativeDesktopLifecycle } from '@axterm/plugin-api/desktop';
import { ShellUpdater } from './updater.ts';
import type { DesktopUpdaterPort } from '@axterm/plugin-api/desktop';
import { ShellExternalUrls } from './external-urls.ts';
import type { NativeWebViews } from '@axterm/plugin-api/host';
import type { NativeDesktopWindows } from '@axterm/plugin-api/desktop';
import type { DesktopLaunch } from '@axterm/plugin-api/session-intents';
import { randomUUID } from 'node:crypto';
import type { CredentialMutationMarker } from '@axterm/plugin-api/saved-credentials';
import type { Context } from '@deepseek-ai/cordis';
import {
  type EncryptedVault,
  VaultError,
  VaultCredentials,
  type CredentialVaultPort,
  type VaultAddress,
  type VaultMetadata,
} from '@axterm/infra-credential-vault';
import { type NativeClient, NativeServer, type NativeWire } from './bridge.ts';
import {
  ShellFileGrantCapabilities,
  type NativeFileApplications,
  type NativeFileChooser,
} from './file-capabilities.ts';
import {
  NativeError,
  MAX_NATIVE_REQUESTS,
  type NativeHandlers,
  type NativeMethod,
  type NativeInput,
  type NativeOutput,
} from './protocol.ts';
const MAX_LEASE_MS = 60_000;
interface Lease {
  readonly settle: (value: string | undefined) => void;
  readonly done: Promise<void>;
  readonly timer: ReturnType<typeof setTimeout>;
}
/** One shell owner per inherited channel/generation; all physical files stay here. */
export class ShellVaultCapabilities {
  private readonly leases = new Map<string, Lease>();
  private readonly acquisitions = new Set<AbortController>();
  private readonly acquisitionTasks = new Set<Promise<unknown>>();
  private active = true;
  private closing: Promise<void> | undefined;
  readonly server: NativeServer;
  readonly files: ShellFileGrantCapabilities;
  constructor(
    private readonly vault: EncryptedVault,
    wire: NativeWire,
    audience: string,
    private readonly leaseMs = MAX_LEASE_MS,
    chooser?: NativeFileChooser,
    retired?: () => void,
    managedDirectory?: string,
    applications?: NativeFileApplications,
    nextLaunch?: (
      windowId: string,
      files: ShellFileGrantCapabilities,
      signal: AbortSignal,
    ) => Promise<DesktopLaunch | null>,
    webViews?: NativeWebViews & { dispose(): Promise<void> },
    openExternal?: (url: string) => Promise<void>,
    windows?: NativeDesktopWindows & { dispose(): Promise<void> },
    updater?: DesktopUpdaterPort,
    lifecycle?: NativeDesktopLifecycle,
  ) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS)
      throw new NativeError('INVALID');
    this.files = new ShellFileGrantCapabilities(audience, chooser, managedDirectory, applications);
    const externalUrls = new ShellExternalUrls(openExternal);
    const updates = new ShellUpdater(updater);
    const unavailable = () => Promise.reject(new NativeError('UNAVAILABLE'));
    const handlers: NativeHandlers = {
      'desktop.lifecycle': (_input, signal) =>
        lifecycle ? lifecycle.state(signal) : unavailable(),
      'window.configure': ({ record, applyBounds }, signal) =>
        windows ? windows.configure(record, signal, applyBounds) : unavailable(),
      'window.state': (_input, signal) => (windows ? windows.state(signal) : unavailable()),
      ...externalUrls.handlers(),
      ...updates.handlers(),
      'webView.create': (input, signal) =>
        webViews ? webViews.create(input, signal) : unavailable(),
      'webView.state': ({ windowId, id }, signal) =>
        webViews ? webViews.state(windowId, id, signal) : unavailable(),
      'webView.present': ({ windowId, id, presentation }, signal) =>
        webViews ? webViews.present(windowId, id, presentation, signal) : unavailable(),
      'webView.action': ({ windowId, id, action }, signal) =>
        webViews ? webViews.perform(windowId, id, action, signal) : unavailable(),
      'webView.authenticate': ({ windowId, id, response }, signal) =>
        webViews ? webViews.authenticate(windowId, id, response, signal) : unavailable(),
      'webView.close': ({ windowId, id }, signal) =>
        webViews ? webViews.close(windowId, id, signal) : unavailable(),
      'desktopLaunch.next': ({ windowId }, signal) =>
        nextLaunch
          ? nextLaunch(windowId, this.files, signal)
          : Promise.reject(new NativeError('UNAVAILABLE')),
      ...this.files.handlers(),
      'vault.ready': async () => {
        await vault.open();
        return true as const;
      },
      'vault.list': () => vault.list().then((entries) => [...entries]),
      'vault.get': ({ ref }) => vault.get(ref),
      'vault.put': (input) => vault.put(input),
      'vault.replace': ({ ref, secret }) => vault.replace(ref, secret),
      'vault.createAt': ({ ref, kind, label, secret, mutation }) => {
        if (mutation.generation !== audience) throw new NativeError('INVALID');
        return vault.createAt(ref, { kind, label, secret }, mutation);
      },
      'vault.replaceManaged': ({ ref, secret, mutation }) => {
        if (mutation.generation !== audience) throw new NativeError('INVALID');
        return vault.replaceManaged(ref, secret, mutation);
      },
      'vault.delete': async ({ ref }) => {
        await vault.delete(ref);
        return true as const;
      },
      'vault.deleteManaged': ({ ref, expected }) => {
        if (expected.generation !== audience) throw new NativeError('INVALID');
        return vault.deleteManaged(ref, expected);
      },
      'vault.address.read': async ({ address }) => {
        const value = await vault.readAddress(address);
        return value === undefined ? {} : { value };
      },
      'vault.address.list': ({ space }) => vault.addresses(space).then((entries) => [...entries]),
      'vault.address.delete': ({ address }) => vault.deleteAddress(address),
      'vault.address.acquire': ({ address }, signal) => this.acquire(address, signal),
      'vault.address.commit': async ({ leaseId, value }) => {
        await this.finish(leaseId, value);
        return true as const;
      },
      'vault.address.release': async ({ leaseId }) => {
        await this.finish(leaseId, undefined);
        return true as const;
      },
    };
    this.server = new NativeServer(wire, audience, handlers, async () => {
      try {
        retired?.();
      } finally {
        await Promise.all([
          this.files.close(),
          this.releaseAll(),
          webViews?.dispose(),
          externalUrls.close(),
          updates.close(),
          windows?.dispose(),
        ]);
      }
    });
  }
  close(): Promise<void> {
    return (this.closing ??= this.server.close());
  }
  private acquire(
    address: VaultAddress,
    signal: AbortSignal,
  ): Promise<{ leaseId: string; value?: string }> {
    if (!this.active) return Promise.reject(new NativeError('CLOSED'));
    if (this.acquisitions.size + this.leases.size >= MAX_NATIVE_REQUESTS)
      return Promise.reject(new NativeError('LIMIT'));
    const abort = new AbortController();
    this.acquisitions.add(abort);
    const lifetime = AbortSignal.any([signal, abort.signal]);
    const ready = Promise.withResolvers<{ leaseId: string; value?: string }>();
    const decision = Promise.withResolvers<string | undefined>();
    const leaseId = randomUUID();
    let lease: Lease | undefined;
    const task = this.vault.modifyAddress(
      address,
      async (current) => {
        if (lifetime.aborted || !this.active) throw new NativeError('CANCELLED');
        this.acquisitions.delete(abort);
        const timer = setTimeout(() => {
          void this.finish(leaseId, undefined).catch(() => {});
        }, this.leaseMs);
        lease = { settle: decision.resolve, done: task.then(() => {}), timer };
        void lease.done.catch(() => {});
        this.leases.set(leaseId, lease);
        lifetime.addEventListener('abort', cancel, { once: true });
        ready.resolve({ leaseId, ...(current === undefined ? {} : { value: current }) });
        return decision.promise;
      },
      lifetime,
    );
    function cancel(): void {
      decision.resolve(undefined);
    }
    this.acquisitionTasks.add(task);
    void task
      .then(
        () => ready.reject(new NativeError('CANCELLED')),
        () => ready.reject(new NativeError('FAILED')),
      )
      .finally(() => {
        this.acquisitions.delete(abort);
        this.acquisitionTasks.delete(task);
        lifetime.removeEventListener('abort', cancel);
        if (lease) clearTimeout(lease.timer);
        this.leases.delete(leaseId);
      });
    return ready.promise;
  }
  private async finish(id: string, value: string | undefined): Promise<void> {
    const lease = this.leases.get(id);
    if (!lease) throw new NativeError('LEASE_EXPIRED');
    this.leases.delete(id);
    clearTimeout(lease.timer);
    lease.settle(value);
    await lease.done;
  }
  private async releaseAll(): Promise<void> {
    this.active = false;
    for (const abort of this.acquisitions) abort.abort();
    for (const lease of this.leases.values()) {
      clearTimeout(lease.timer);
      lease.settle(undefined);
    }
    this.leases.clear();
    await Promise.allSettled([...this.acquisitionTasks]);
  }
}
/** Host-only port. A caller callback runs here; only the replacement crosses IPC. */
export class NativeVaultPort implements CredentialVaultPort {
  private active = true;
  private accepting = true;
  private readonly pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  constructor(private readonly client: NativeClient) {}
  open(): Promise<void> {
    return this.run(async () => {
      await this.call('vault.ready', {});
    });
  }
  close(): Promise<void> {
    this.accepting = false;
    return (this.closing ??= Promise.resolve().then(async () => {
      await Promise.allSettled([...this.pending]);
      this.active = false;
    }));
  }
  list(): Promise<readonly VaultMetadata[]> {
    return this.run(() => this.call('vault.list', {}));
  }
  get(ref: string): Promise<string> {
    return this.run(() => this.call('vault.get', { ref }));
  }
  createAt(
    ref: string,
    input: { kind: string; label: string; secret: string },
    mutation: CredentialMutationMarker,
  ): Promise<VaultMetadata> {
    return this.run(() => this.call('vault.createAt', { ref, ...input, mutation }));
  }
  replaceManaged(
    ref: string,
    secret: string,
    mutation: CredentialMutationMarker,
  ): Promise<VaultMetadata> {
    return this.run(() => this.call('vault.replaceManaged', { ref, secret, mutation }));
  }
  replace(ref: string, secret: string): Promise<VaultMetadata> {
    return this.run(() => this.call('vault.replace', { ref, secret }));
  }
  delete(ref: string): Promise<void> {
    return this.run(async () => {
      await this.call('vault.delete', { ref });
    });
  }
  deleteManaged(
    ref: string,
    expected: CredentialMutationMarker,
  ): Promise<'deleted' | 'missing' | 'changed'> {
    return this.run(() => this.call('vault.deleteManaged', { ref, expected }));
  }
  readAddress(address: VaultAddress): Promise<string | undefined> {
    return this.run(async () => (await this.call('vault.address.read', { address })).value);
  }
  addresses(space: VaultAddress['space']): Promise<readonly VaultAddress[]> {
    return this.run(() => this.call('vault.address.list', { space }));
  }
  deleteAddress(address: VaultAddress): Promise<boolean> {
    return this.run(() => this.call('vault.address.delete', { address }));
  }
  modifyAddress(
    address: VaultAddress,
    mutate: (current: string | undefined) => Promise<string | undefined>,
  ): Promise<string | undefined> {
    return this.run(async () => {
      const lease = await this.call('vault.address.acquire', { address });
      let finished = false;
      try {
        let next: string | undefined;
        try {
          next = await mutate(lease.value);
        } catch {
          throw new VaultError('MUTATION_FAILED');
        }
        if (next === undefined) {
          await this.call('vault.address.release', { leaseId: lease.leaseId });
          finished = true;
          return lease.value;
        }
        await this.call('vault.address.commit', { leaseId: lease.leaseId, value: next });
        finished = true;
        return next;
      } finally {
        if (!finished)
          await this.call('vault.address.release', { leaseId: lease.leaseId }).catch(() => {});
      }
    });
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new VaultError('CLOSED'));
    const task = operation();
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    return task;
  }
  private call<K extends NativeMethod>(method: K, input: NativeInput<K>): Promise<NativeOutput<K>> {
    if (!this.active) return Promise.reject(new VaultError('CLOSED'));
    return this.client.call(method, input).catch((error: unknown) => {
      if (error instanceof NativeError) {
        switch (error.code) {
          case 'CLOSED':
          case 'INVALID':
          case 'CORRUPT':
          case 'KEY_MISSING':
          case 'NOT_FOUND':
          case 'CONFLICT':
          case 'IO':
          case 'MUTATION_FAILED':
            throw new VaultError(error.code);
          default:
            throw new VaultError('IO');
        }
      }
      throw new VaultError('IO');
    });
  }
}
export class DesktopVaultCredentials extends VaultCredentials {
  constructor(ctx: Context, client: NativeClient) {
    super(ctx, new NativeVaultPort(client));
  }
}
