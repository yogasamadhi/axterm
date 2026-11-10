import type { Context } from '@deepseek-ai/cordis';
import type { ProfileContext, ProfilePluginLocation } from '@axterm/infra-app-boot';
import {
  assertBundlePlatform,
  bundlePatchFiles,
  isExactPluginVersion,
  loadOverlayPatches,
  composeEntries,
  evaluatePluginCompatibility,
  readProfileManifest,
  readProfilePatches,
  readProfilePlugins,
  readProfileVersionExemptions,
  resolveBundleDir,
  setProfileVersionExemption,
  writeProfileBundles,
} from '@axterm/infra-app-boot';
import { withFileLock, writeFileAtomic } from '@axterm/infra-atomic-write';
import { readFile, mkdir, rm, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { isSeq, parseDocument } from 'yaml';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type PackageRunner, PackageRunError } from './package-runner.ts';
import {
  PackageInspector,
  scopedRegistryArguments,
  packageMetadata,
  packageName,
  boundedManifest,
  boundedManifestSync,
  type InspectedPackage,
  type PackageMetadata,
} from './metadata.ts';
import { writePluginEnabled, flatten } from './patch.ts';
import { pendingBuilds, approveBuilds, type PendingBuild } from './builds.ts';
import type {} from '@axterm/infra-hmr';
const backupFiles = [
  'package.json',
  'pnpm-lock.yaml',
  'cordis.patch.yml',
  'pnpm-workspace.yaml',
] as const;
const backupText = z
  .string()
  .max(16 * 1024 * 1024)
  .nullable();
const backupSchema = z
  .object({
    'package.json': z.string().max(16 * 1024 * 1024),
    'pnpm-lock.yaml': backupText,
    'cordis.patch.yml': backupText,
    'pnpm-workspace.yaml': backupText,
  })
  .strict();

export interface ManagedPackage {
  readonly name: string;
  readonly version: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly bundle: boolean;
  readonly problem?: 'unavailable' | 'invalid' | 'incompatible';
}
export interface PluginChange {
  readonly changed: boolean;
  readonly application: 'applied' | 'overridden' | 'restart-required' | 'failed';
  readonly restartReason?: string;
}
/** One writer for Profile package/selection files. All execution uses the managed subprocess owner. */
export class PluginManager {
  private readonly inspector: PackageInspector;
  private readonly lifetime = new AbortController();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly activities = new Set<Promise<unknown>>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private lifecycleUncertain = false;
  private readonly location: ProfilePluginLocation;
  constructor(
    private readonly ctx: Context,
    private readonly profile: ProfileContext,
    private readonly runner: PackageRunner,
    registry = 'https://registry.npmjs.org/',
    private readonly managementOnly = false,
    fallbackRegistries: readonly string[] = [],
  ) {
    this.inspector = new PackageInspector(runner, registry, fallbackRegistries);
    this.location = {
      binName: 'axterm',
      profileDir: profile.dir,
      installAnchor: profile.installAnchor,
    };
  }
  inspect(spec: string, signal?: AbortSignal, registry?: string): Promise<InspectedPackage> {
    if (this.closing) return Promise.reject(new PackageRunError('closed'));
    if (this.tasks.size >= 8) return Promise.reject(new PackageRunError('capacity'));
    const task = this.queue.then(() =>
      (registry ? new PackageInspector(this.runner, registry) : this.inspector).inspect(
        spec,
        AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]),
      ),
    );
    this.queue = task.catch(() => {});
    this.tasks.add(task);
    this.activities.add(task);
    void task.then(
      () => {
        this.tasks.delete(task);
        this.activities.delete(task);
      },
      () => {
        this.tasks.delete(task);
        this.activities.delete(task);
      },
    );
    return task;
  }
  list(): readonly ManagedPackage[] {
    const inventory = readProfilePlugins(this.location);
    const names = new Set([
      ...(inventory.manifest.axterm?.profile?.bundles ?? []),
      ...inventory.dependencies.map(({ name }) => name),
    ]);
    return [...names].map((name) => {
      packageName(name);
      const installed = inventory.dependencies.find((item) => item.name === name);
      const selected = inventory.manifest.axterm?.profile?.bundles?.includes(name) === true;
      try {
        const directory = resolveBundleDir(
          'axterm',
          name,
          this.profile.installAnchor,
          this.profile.dir,
        );
        const manifest = packageMetadata(
          JSON.parse(boundedManifestSync(join(directory, 'package.json'))),
        );
        let invalidBundle = false;
        try {
          this.validateBundle(directory, manifest);
        } catch {
          invalidBundle = true;
        }
        const compatibility = evaluatePluginCompatibility(
          manifest,
          readProfileVersionExemptions(this.profile.dir),
        );
        return {
          name,
          version: manifest.version,
          installed: !!installed,
          enabled: selected || this.entries().some((row) => row.name === name && !row.disabled),
          bundle: manifest.axterm?.bundle !== undefined,
          ...(invalidBundle ? { problem: 'invalid' as const } : {}),
          ...(compatibility && !compatibility.exempted ? { problem: 'incompatible' as const } : {}),
        };
      } catch {
        return {
          name,
          version: installed && isExactPluginVersion(installed.version) ? installed.version : '',
          installed: !!installed,
          enabled: selected,
          bundle: installed?.bundle ?? false,
          problem: 'unavailable' as const,
        };
      }
    });
  }
  entries() {
    const loader = this.ctx.get('loader');
    const live = new Map([...(loader?.entries() ?? [])].map((row) => [row.options.id, row]));
    const states = ['pending', 'loading', 'active', 'failed', 'not-running', 'unloading'] as const;
    return flatten(composeEntries([readProfilePatches('axterm', this.profile)])).flatMap((row) => {
      if (typeof row.id !== 'string' || typeof row.name !== 'string') return [];
      const fiber = live.get(row.id)?.fiber;
      const state =
        loader === undefined
          ? 'offline'
          : fiber
            ? (states[fiber.state] ?? 'not-running')
            : 'not-running';
      return [{ id: row.id, name: row.name, disabled: row.disabled === true, state }];
    });
  }
  pendingBuilds(): Promise<readonly PendingBuild[]> {
    if (this.closing) return Promise.reject(new PackageRunError('closed'));
    if (this.tasks.size >= 8) return Promise.reject(new PackageRunError('capacity'));
    const task = this.queue.then(() => pendingBuilds(this.profile.dir));
    this.queue = task.catch(() => {});
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }
  approveBuilds(
    ids: readonly string[],
    approved: boolean,
    signal?: AbortSignal,
  ): Promise<PluginChange> {
    if (approved !== true) return Promise.reject(new PackageRunError('permission'));
    const request = [...ids];
    return this.mutate(async (active) => {
      const available = await pendingBuilds(this.profile.dir);
      if (
        !request.length ||
        request.length > 64 ||
        new Set(request).size !== request.length ||
        request.some((id) => !available.some((item) => item.id === id))
      )
        throw new PackageRunError('invalid-input');
      const backup = await this.backup();
      await approveBuilds(this.profile.dir, request, this.runner, active);
      await this.finishBackup(backup);
      return { changed: true, application: 'applied' };
    }, signal);
  }
  async transactions(): Promise<readonly string[]> {
    const entries = await readdir(join(this.profile.dir, '.plugin-manager/transactions')).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    if (entries.length > 512) throw new PackageRunError('capacity');
    return entries.map((id) => z.uuid().parse(id));
  }
  repair(id: string): Promise<PluginChange> {
    if (!this.managementOnly) return Promise.reject(new PackageRunError('permission'));
    z.uuid().parse(id);
    return this.mutate(
      async (signal) => {
        await this.restore(join(this.profile.dir, '.plugin-manager/transactions', id), signal);
        return { changed: true, application: 'applied' };
      },
      undefined,
      true,
    );
  }
  install(
    spec: string,
    options: { enabled?: boolean; replace?: boolean; signal?: AbortSignal; registry?: string } = {},
  ): Promise<PluginChange> {
    options = { ...options };
    return this.mutate(async (signal) => {
      const inspected = await (
        options.registry ? new PackageInspector(this.runner, options.registry) : this.inspector
      ).inspect(spec, signal);
      this.compatible(inspected.manifest);
      const before = readProfileManifest('axterm', this.profile.dir);
      const existing = Object.hasOwn(before.dependencies ?? {}, inspected.manifest.name);
      if (existing && !options.replace) throw new PackageRunError('invalid-input');
      const enabled =
        options.enabled ??
        (existing
          ? this.list().some((item) => item.name === inspected.manifest.name && item.enabled)
          : true);
      this.assertMutable(inspected.manifest.name);
      // Replacing a loaded implementation requires a real unload, even when pnpm could relink it.
      if (existing && !this.managementOnly && !this.ctx.get('hmr'))
        return {
          changed: false,
          application: 'restart-required',
          restartReason: 'offline-upgrade-required',
        };
      const backup = await this.backup();
      try {
        if (existing) {
          await this.select(inspected.manifest.name, false);
          const stopped = await this.reload();
          if (stopped.application === 'failed') throw new PackageRunError('unavailable');
          if (stopped.application === 'applied') {
            await this.removeInstalled(inspected.manifest.name, signal);
            await this.reload();
          }
        }
        const result = await this.runner.run(
          [
            'add',
            '--save-exact',
            '--config.ignore-scripts=true',
            '--config.ignore-pnpmfile=true',
            '--config.manage-package-manager-versions=false',
            '--config.auto-install-peers=false',
            '--registry',
            inspected.registry ?? this.inspector.registry,
            ...scopedRegistryArguments(
              inspected.manifest.name,
              inspected.registry ?? this.inspector.registry,
            ),
            '--',
            inspected.spec,
          ],
          { signal, timeoutMs: 30 * 60_000 },
        );
        if (result.exitCode !== 0) throw new PackageRunError(result.failure ?? 'unavailable');
        const downloaded = packageMetadata(
          JSON.parse(
            await boundedManifest(
              join(this.profile.dir, 'node_modules', inspected.manifest.name, 'package.json'),
            ),
          ),
        );
        if (
          downloaded.name !== inspected.manifest.name ||
          downloaded.version !== inspected.manifest.version
        )
          throw new PackageRunError('invalid-input');
        this.compatible(downloaded);
        await this.select(downloaded.name, enabled);
        const applied = await this.reload(
          enabled ? this.declaredRows(downloaded.name).map((row) => row.id) : [],
        );
        await this.finishBackup(backup);
        return { ...applied, changed: true };
      } catch (error) {
        // A failed managed-range cleanup is not permission to race it with a rollback installer.
        if (this.runner.cleanupFailed()) throw new PackageRunError('unavailable');
        if (
          this.ctx.get('hmr') &&
          Object.hasOwn(
            readProfileManifest('axterm', this.profile.dir).dependencies ?? {},
            inspected.manifest.name,
          )
        ) {
          await this.select(inspected.manifest.name, false);
          await this.reload();
          await this.removeInstalled(inspected.manifest.name, signal);
          await this.reload();
        }
        await this.restore(backup, signal);
        throw error;
      }
    }, options.signal);
  }
  remove(name: string, signal?: AbortSignal): Promise<PluginChange> {
    packageName(name);
    return this.mutate(async (active) => {
      this.assertMutable(name);
      const before = readProfileManifest('axterm', this.profile.dir);
      if (!Object.hasOwn(before.dependencies ?? {}, name)) throw new PackageRunError('not-found');
      await this.select(name, false);
      const stopped = await this.reload();
      // A non-HMR Host must stop before CLI removes its loaded implementation.
      if (stopped.application !== 'applied') return { ...stopped, changed: true };
      this.assertStopped(name);
      const backup = await this.backup();
      await this.removeInstalled(name, active);
      await this.finishBackup(backup);
      return { ...(await this.reload()), changed: true };
    }, signal);
  }
  setBundleEnabled(name: string, enabled: boolean): Promise<PluginChange> {
    packageName(name);
    return this.mutate(async () => {
      this.assertMutable(name);
      await this.select(name, enabled);
      const applied = await this.reload(
        enabled ? this.declaredRows(name).map((row) => row.id) : [],
      );
      return {
        ...applied,
        application:
          applied.application === 'applied' && !enabled && this.runningTarget(name)
            ? 'overridden'
            : applied.application,
        changed: true,
      };
    });
  }
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginChange> {
    return this.mutate(async () => {
      const matches = this.entries().filter((row) => row.id === id);
      if (matches.length !== 1) throw new PackageRunError('invalid-input');
      const row = matches[0]!;
      this.assertMutable(row.name);
      const changed = await writePluginEnabled(this.profile, id, row.name, enabled);
      const applied = await this.reload(enabled ? [id] : []);
      const overridden =
        applied.application === 'applied' &&
        !enabled &&
        [...(this.ctx.get('loader')?.entries() ?? [])].some(
          (entry) => entry.options.id === id && entry.fiber?.state === 2,
        );
      return { ...applied, application: overridden ? 'overridden' : applied.application, changed };
    });
  }
  allowVersion(
    packageVersion: string,
    runtimeVersion: string,
    enabled: boolean,
    acceptRisk: boolean,
  ): Promise<PluginChange> {
    return this.mutate(async () => {
      await setProfileVersionExemption(
        this.profile.dir,
        packageVersion,
        runtimeVersion,
        enabled,
        acceptRisk,
      );
      return {
        changed: true,
        application: 'restart-required',
        restartReason: 'compatibility-changed',
      };
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const done = Promise.withResolvers<void>();
    this.closing = done.promise;
    this.lifetime.abort();
    void (async () => {
      await Promise.allSettled([...this.tasks]);
      await this.queue;
      await this.runner.close();
      if (this.lifecycleUncertain) throw new PackageRunError('unavailable');
    })().then(done.resolve, done.reject);
    return this.closing;
  }
  inspectTasks(signal: AbortSignal): { active: boolean } {
    signal.throwIfAborted();
    return {
      active:
        this.lifecycleUncertain || this.activities.size > 0 || this.runner.resourceCount() > 0,
    };
  }
  private mutate<T>(
    apply: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    repair = false,
  ): Promise<T> {
    if (this.closing) return Promise.reject(new PackageRunError('closed'));
    if (this.tasks.size >= 8) return Promise.reject(new PackageRunError('capacity'));
    const active = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const task = this.queue.then(() =>
      withFileLock(
        join(this.profile.dir, 'package.json'),
        async () => {
          active.throwIfAborted();
          if (this.runner.cleanupFailed() || this.lifecycleUncertain)
            throw new PackageRunError('unavailable');
          const pending = await readdir(
            join(this.profile.dir, '.plugin-manager/transactions'),
          ).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
          });
          if (pending.length && !repair) throw new PackageRunError('unavailable');
          const hmr = this.ctx.get('hmr');
          return hmr ? hmr.runExclusive(() => apply(active)) : apply(active);
        },
        { signal: active, waitMs: 120_000 },
      ),
    );
    this.queue = task.catch(() => {});
    this.tasks.add(task);
    this.activities.add(task);
    void task.then(
      () => {
        this.tasks.delete(task);
        this.activities.delete(task);
      },
      () => {
        this.tasks.delete(task);
        this.activities.delete(task);
      },
    );
    return task;
  }
  private compatible(manifest: object) {
    const mismatch = evaluatePluginCompatibility(
      manifest,
      readProfileVersionExemptions(this.profile.dir),
    );
    if (mismatch && !mismatch.exempted) throw new PackageRunError('invalid-input');
  }
  private assertMutable(name: string) {
    // Installed application components cannot replace the manager or its own lifecycle dependencies.
    if (
      [
        '@axterm/bundle-base',
        '@axterm/bundle-plugins',
        '@axterm/infra-plugin-manager',
        '@axterm/plugin-plugins',
        '@axterm/infra-hmr',
        '@axterm/infra-subprocess-local',
        '@axterm/infra-subprocess',
        '@axterm/infra-gateway',
        '@axterm/infra-typert-registry',
        '@axterm/infra-remote-access',
      ].includes(name)
    )
      throw new PackageRunError('permission');
  }
  private validateBundle(directory: string, manifest: PackageMetadata): void {
    const bundle = manifest.axterm?.bundle;
    if (!bundle) return;
    const files = bundlePatchFiles({ patch: bundle.patch });
    if (files.length > 32) throw new PackageRunError('capacity');
    for (const file of files) {
      const path = resolve(directory, file),
        local = relative(directory, path);
      if (isAbsolute(file) || local === '..' || local.startsWith('../') || local.startsWith('..\\'))
        throw new PackageRunError('invalid-input');
      boundedManifestSync(path);
      loadOverlayPatches('axterm', path);
    }
  }
  private async removeInstalled(name: string, signal: AbortSignal): Promise<void> {
    if (this.lifecycleUncertain) throw new PackageRunError('unavailable');
    this.assertStopped(name);
    const result = await this.runner.run(
      [
        'remove',
        '--config.ignore-scripts=true',
        '--config.ignore-pnpmfile=true',
        '--config.manage-package-manager-versions=false',
        '--config.registry=' + this.inspector.registry,
        '--',
        name,
      ],
      { signal, timeoutMs: 30 * 60_000 },
    );
    if (result.exitCode !== 0) throw new PackageRunError(result.failure ?? 'unavailable');
  }
  private assertStopped(name: string): void {
    if (this.runningTarget(name)) throw new PackageRunError('permission');
  }
  private declaredRows(name: string) {
    const directory = resolveBundleDir(
      'axterm',
      name,
      this.profile.installAnchor,
      this.profile.dir,
    );
    const manifest = packageMetadata(
      JSON.parse(boundedManifestSync(join(directory, 'package.json'))),
    );
    if (!manifest.axterm?.bundle) return [{ id: 'profile:' + name, name }];
    this.validateBundle(directory, manifest);
    return flatten(
      composeEntries(
        bundlePatchFiles({ patch: manifest.axterm.bundle.patch }).map((file) =>
          loadOverlayPatches('axterm', resolve(directory, file)),
        ),
      ),
    );
  }
  private runningTarget(name: string): boolean {
    const loader = this.ctx.get('loader');
    if (!loader) return false;
    const declared = new Set(this.declaredRows(name).map((row) => row.name));
    const directory = realpathSync(
      resolveBundleDir('axterm', name, this.profile.installAnchor, this.profile.dir),
    );
    const base = this.ctx.baseUrl ?? pathToFileURL(this.profile.dir + '/').href;
    const packages = this.ctx.get('pluginPackages');
    for (const row of loader.entries()) {
      if (row.fiber?.state !== 2) continue; // Pinned Cordis ACTIVE; a higher overlay may keep this row enabled.
      const module = row.options.name;
      if (declared.has(module) || module === name || module.startsWith(name + '/')) return true;
      if (module.startsWith('file:')) {
        const local = relative(directory, realpathSync(fileURLToPath(module)));
        if (
          local !== '..' &&
          !local.startsWith('../') &&
          !local.startsWith('..\\') &&
          !isAbsolute(local)
        )
          return true;
      } else if (
        !module.startsWith('cordis:') &&
        packages?.packageOf(module, base)?.dir === directory
      )
        return true;
    }
    return false;
  }
  private async select(name: string, enabled: boolean) {
    const manifest = readProfileManifest('axterm', this.profile.dir);
    const bundles = manifest.axterm?.profile?.bundles ?? [];
    let metadata;
    let directory: string | undefined;
    try {
      directory = resolveBundleDir('axterm', name, this.profile.installAnchor, this.profile.dir);
      metadata = packageMetadata(
        JSON.parse(await boundedManifest(join(directory, 'package.json'))),
      );
    } catch {
      if (enabled) throw new PackageRunError('not-found');
    }
    if (enabled && metadata) {
      this.compatible(metadata);
      this.validateBundle(directory!, metadata);
      if (metadata.axterm?.bundle)
        assertBundlePlatform(metadata.axterm.bundle.platforms, process.platform);
    }
    if (metadata?.axterm?.bundle || bundles.includes(name)) {
      writeProfileBundles(
        this.profile.dir,
        manifest,
        enabled ? [...new Set([...bundles, name])] : bundles.filter((item) => item !== name),
      );
    } else {
      const id = 'profile:' + name;
      const rows = this.entries().filter((row) => row.name === name);
      if (rows.length) {
        for (const row of rows) await writePluginEnabled(this.profile, row.id, name, enabled);
      } else if (enabled) {
        const text = await readFile(this.profile.patchPath, 'utf8').catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return '[]\n';
            throw error;
          },
        );
        const document = parseDocument(text, {
          customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
        });
        if (document.errors[0]) throw document.errors[0];
        if (!isSeq(document.contents)) throw new PackageRunError('invalid-input');
        document.add({ insert: [{ id, name }] });
        await writeFileAtomic(this.profile.patchPath, String(document), { mode: 0o600 });
      }
    }
  }
  private async reload(requiredIds: readonly string[] = []): Promise<PluginChange> {
    if (this.managementOnly) return { changed: false, application: 'applied' };
    const hmr = this.ctx.get('hmr');
    if (!hmr) return { changed: false, application: 'restart-required', restartReason: 'no-hmr' };
    let disposalFailed = false;
    const release = this.ctx.logger.exporter({
      levels: { default: 0 },
      export: (record) => {
        const fiber = record.fiber?.deref();
        if (record.type === 'error' && fiber && (fiber.state === 4 || fiber.state === 5))
          disposalFailed = true;
      },
    });
    let result;
    try {
      result = await hmr.reconcileProfile(requiredIds);
    } finally {
      await release();
      if (disposalFailed) this.lifecycleUncertain = true;
    }
    if (this.lifecycleUncertain) throw new PackageRunError('unavailable');
    const restartReason = result.restartReason ?? result.pending[0]?.reason;
    return restartReason
      ? { changed: false, application: 'restart-required', restartReason }
      : { changed: false, application: 'applied' };
  }
  private async backup(): Promise<string> {
    const directory = join(this.profile.dir, '.plugin-manager/transactions', randomUUID());
    const files: Record<string, string | null> = {};
    for (const name of backupFiles) {
      try {
        const text = await boundedManifest(join(this.profile.dir, name), 16 * 1024 * 1024);
        files[name] = text;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') files[name] = null;
        else throw error;
      }
    }
    backupSchema.parse(files);
    const serialized = JSON.stringify(files);
    if (Buffer.byteLength(serialized) > 64 * 1024 * 1024) throw new PackageRunError('capacity');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFileAtomic(join(directory, 'before.json'), serialized, { mode: 0o600 });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return directory;
  }
  private async finishBackup(directory: string) {
    await rm(directory, { recursive: true });
  }
  private async restore(directory: string, signal: AbortSignal) {
    const files = backupSchema.parse(
      JSON.parse(await boundedManifest(join(directory, 'before.json'), 64 * 1024 * 1024)),
    );
    await this.restoreFiles(files);
    // Never replay lifecycle scripts during repair. An interrupted repair remains visible and blocks later mutations.
    const result = await this.runner.run(
      [
        'install',
        '--offline',
        '--config.ignore-scripts=true',
        '--config.ignore-pnpmfile=true',
        '--config.manage-package-manager-versions=false',
        ...(files['pnpm-lock.yaml'] ? ['--frozen-lockfile'] : []),
      ],
      { signal, timeoutMs: 30 * 60_000 },
    );
    if (result.exitCode !== 0) throw new PackageRunError('unavailable');
    await this.restoreFiles(files);
    await this.reload();
    await this.finishBackup(directory);
  }
  private async restoreFiles(files: z.infer<typeof backupSchema>): Promise<void> {
    for (const [name, text] of Object.entries(files)) {
      if (text === null) await rm(join(this.profile.dir, name), { force: true });
      else await writeFileAtomic(join(this.profile.dir, name), text, { mode: 0o600 });
    }
  }
}
