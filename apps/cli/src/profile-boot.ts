import { assertDataMigrationReady } from '@axterm/infra-storage-relational/copy';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type {} from '@axterm/plugin-api/host';
// Copyright (c) 2026 DeepSeek. SPDX-License-Identifier: MIT
// Adapted from apps/cli/src/profile-boot.ts at 8bd073392eef6f54e921a093b95076248eb08cbb.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { FiberState, Context } from '@deepseek-ai/cordis';
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include';
import {
  boot,
  createRuntimeResolution,
  initProfile,
  installFailLoud,
  loadOverlayPatches,
  loadOptionalPatches,
  loadProfile,
  loadRecoveryProfile,
  PluginPackages,
  readProfilePatches,
  reportSkippedBundles,
  resolveProfileDir,
  renderConfigDump,
} from '@axterm/infra-app-boot';
import type { ProfileContext } from '@axterm/infra-app-boot';
import {
  createLaunchEnvironmentSnapshot,
  AXTERM_LAUNCH_ENVIRONMENT_KEY,
  type LaunchEnvironmentSnapshot,
} from '@axterm/infra-launch-environment';
import { installProxyFromEnvironment } from '@axterm/infra-http-proxy';
import { provideCmdline, type AppReady } from '@axterm/infra-cmdline';
import { withFileLock } from '@axterm/infra-atomic-write';
import { profileRecoveryActive } from '@axterm/infra-profile-recovery';
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts';

// Pinned Cordis const enum; same declaration-compatible convention as the upstream boot audit.
const FIBER_ACTIVE: FiberState = 2;

export interface ProfileTemplate {
  readonly bundles: readonly string[];
}
export interface ProfileBootOptions {
  profile: string;
  home: string;
  installAnchor: string;
  templates: Readonly<Record<string, ProfileTemplate>>;
  patchFiles: readonly string[];
  args: readonly string[];
  environment?: LaunchEnvironmentSnapshot;
  packageManager?: ProfileContext['packageManager'];
  desktopOwner?: boolean;
  /** Only the owning Electron shell may choose the Desktop generation. */
  desktopGeneration?: string;
  /** Install startup facts and their effects before any Profile entry activates. */
  prepare?: (ctx: Context) => void | Promise<void>;
  /** Application composition's required services; optional plugins may still fail independently. */
  requiredServices?: readonly string[];
  onWarning?: (message: string) => void;
}

function validateOptions(options: ProfileBootOptions): void {
  if (!/^[a-z][a-z0-9-]*$/.test(options.profile)) throw new Error('Invalid profile name');
  if (options.profile === 'desktop' && !options.desktopOwner)
    throw new Error('The desktop Profile is owned by Electron');
  if (
    options.desktopGeneration !== undefined &&
    (options.profile !== 'desktop' ||
      !options.desktopOwner ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        options.desktopGeneration,
      ))
  )
    throw new Error('Invalid Desktop generation');
}

function compose(options: ProfileBootOptions) {
  validateOptions(options);
  if (!/^[a-z][a-z0-9-]*$/.test(options.profile)) throw new Error('Invalid profile name');
  if (options.profile === 'desktop' && !options.desktopOwner)
    throw new Error('The desktop Profile is owned by Electron');
  const home = resolve(options.home);
  const dir = resolveProfileDir(options.profile, home);
  if (profileRecoveryActive(home, options.profile)) {
    const template = Object.hasOwn(options.templates, options.profile)
      ? options.templates[options.profile]
      : undefined;
    if (!template) throw new Error('PROFILE_RECOVERY_TEMPLATE_UNAVAILABLE');
    const profile = loadRecoveryProfile(
      options.profile,
      home,
      options.installAnchor,
      template.bundles.filter(
        (name) => !['@axterm/bundle-plugins', '@axterm/bundle-market'].includes(name),
      ),
    );
    const patches: PatchOptions[] = structuredClone([
      ...profile.layers.flatMap((layer) => layer.patches),
      { id: 'hmr', disabled: true },
    ]);
    return { home, profile, overlays: [], patches, recovery: true };
  }
  if (!existsSync(join(dir, 'package.json'))) {
    const template = Object.hasOwn(options.templates, options.profile)
      ? options.templates[options.profile]
      : undefined;
    if (!template) throw new Error(`Unknown Profile: ${options.profile}`);
    initProfile(dir, template.bundles);
  }
  const profile = loadProfile('axterm', options.profile, options.installAnchor, home);
  reportSkippedBundles('axterm', profile);
  const overlays = options.patchFiles
    .map((file) => loadOverlayPatches('axterm', resolve(file)))
    .flat();
  const patches: PatchOptions[] = structuredClone([
    ...profile.layers.flatMap((layer) => layer.patches),
    ...profile.patches,
    ...(loadOptionalPatches('axterm', join(home, 'cordis.patch.yml')) ?? []),
    ...overlays,
  ]);
  return { home, profile, overlays, patches, recovery: false };
}

export function dumpProfile(options: ProfileBootOptions): string {
  const { home, profile, patches, recovery } = compose(options);
  const owned = recovery ? mkdtempSync(join(home, 'profiles', '.recovery-')) : undefined;
  const rootConfig = join(owned ?? profile.dir, 'cordis.yml');
  mkdirSync(dirname(rootConfig), { recursive: true });
  writeFileSync(rootConfig, '[]\n', { mode: 0o600 });
  try {
    return renderConfigDump(
      'axterm',
      rootConfig,
      [{ label: 'profile composition', patches }],
      options.onWarning,
    );
  } finally {
    if (owned) rmSync(owned, { recursive: true, force: true });
  }
}

function appReadiness(): { service: AppReady; commit(): void } {
  let ready = false;
  const listeners = new Set<() => void>();
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener();
          return () => {};
        }
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    commit() {
      if (ready) return;
      ready = true;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
}

async function lockProfile(options: ProfileBootOptions): Promise<() => Promise<void>> {
  validateOptions(options);
  return lockProfileDirectory(options.profile, options.home);
}

async function lockProfileDirectory(profile: string, home: string): Promise<() => Promise<void>> {
  if (!/^[a-z][a-z0-9-]*$/.test(profile)) throw new Error('Invalid profile name');
  const directory = resolveProfileDir(profile, resolve(home));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const acquired = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const operation = withFileLock(
    join(directory, 'profile-runtime'),
    async () => {
      acquired.resolve();
      await released.promise;
    },
    { waitMs: 0 },
  );
  // Install the rejection observer before awaiting acquisition; both paths are awaited.
  void operation.catch((error) => {
    acquired.reject(error);
  });
  try {
    await acquired.promise;
  } catch (error) {
    await operation.catch(() => {});
    throw error;
  }
  return async () => {
    released.resolve();
    await operation;
  };
}

/** Offline management shares the runner's lock without activating Profile code or a server. */
export async function withProfileManagement<T>(
  options: Pick<ProfileBootOptions, 'profile' | 'home' | 'templates'>,
  manage: (directory: string) => Promise<T>,
): Promise<T> {
  const release = await lockProfileDirectory(options.profile, options.home);
  try {
    const directory = resolveProfileDir(options.profile, resolve(options.home));
    if (!existsSync(join(directory, 'package.json'))) {
      const template = Object.hasOwn(options.templates, options.profile)
        ? options.templates[options.profile]
        : undefined;
      if (!template) throw new Error('Unknown Profile');
      initProfile(directory, template.bundles);
    }
    return await manage(directory);
  } finally {
    await release();
  }
}

export async function runProfile(
  options: ProfileBootOptions,
): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  validateOptions(options);
  const environment =
    options.environment ??
    createLaunchEnvironmentSnapshot([
      {
        source: 'process',
        values: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      },
    ]);
  const releaseProxy = await installProxyFromEnvironment(
    environment,
    options.onWarning ?? (() => {}),
  );
  let releaseLock: (() => Promise<void>) | undefined;
  let releaseMigration: (() => Promise<void>) | undefined;
  let current: Context | undefined;
  let cleanup: Promise<void> | undefined;
  let removeFailLoud: () => void = () => {};
  let recoveryRoot: string | undefined;
  const interrupt = (signal: NodeJS.Signals) => shutdown.interrupt(signal === 'SIGINT' ? 130 : 0);
  const onTerm = () => interrupt('SIGTERM');
  const onInt = () => interrupt('SIGINT');
  const dispose = () =>
    (cleanup ??= (async () => {
      const failures: unknown[] = [];
      for (const release of [
        () => current?.get('hmr')?.quiesce(),
        () => current?.fiber.dispose(),
        releaseProxy,
        () => releaseMigration?.(),
        () => releaseLock?.(),
      ]) {
        try {
          await release();
        } catch (error) {
          failures.push(error);
        }
      }
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      removeFailLoud?.();
      if (recoveryRoot && !failures.length) rmSync(recoveryRoot, { recursive: true, force: true });
      if (failures.length) throw new AggregateError(failures, 'Profile cleanup failed');
    })());
  const shutdown = createProcessShutdown(dispose);
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  removeFailLoud = installFailLoud('axterm', process, dispose);
  try {
    releaseLock = await lockProfile(options);
    const acquired = Promise.withResolvers<void>(),
      released = Promise.withResolvers<void>();
    const lease = withFileLock(
      join(resolve(options.home), 'data-migration'),
      async () => {
        acquired.resolve();
        await released.promise;
      },
      { waitMs: 0 },
    );
    void lease.catch((error) => acquired.reject(error));
    await acquired.promise;
    releaseMigration = async () => {
      released.resolve();
      await lease;
    };
    await assertDataMigrationReady(resolve(options.home));
    const { home, profile, overlays, patches, recovery } = compose(options);
    const resolution = await createRuntimeResolution({
      installAnchor: options.installAnchor,
      ...(recovery ? {} : { profile }),
      home,
    });
    const context: ProfileContext = {
      name: options.profile,
      dir: profile.dir,
      patchPath: profile.patchPath,
      installAnchor: options.installAnchor,
      cwd: process.cwd(),
      home,
      startedBundles: profile.layers.map((layer) => layer.packageName),
      overlays,
      telemetryDisabledEnv: undefined,
      ...(recovery ? { recoveryPatches: patches } : {}),
      ...(options.packageManager ? { packageManager: options.packageManager } : {}),
    };
    if (recovery) recoveryRoot = mkdtempSync(join(home, 'profiles', '.recovery-'));
    const rootConfig = join(recoveryRoot ?? profile.dir, 'cordis.yml');
    writeFileSync(rootConfig, '[]\n', { mode: 0o600 });
    const readiness = appReadiness();
    const ctx = await boot(
      'axterm',
      rootConfig,
      readProfilePatches('axterm', context, profile),
      async (host) => {
        current = host;
        host.provide('profileContext', context);
        host.provide(
          'runtimeIdentity',
          Object.freeze({
            profileName: options.profile,
            runtimeId: randomUUID(),
            generation: options.desktopGeneration ?? randomUUID(),
            startedAt: new Date().toISOString(),
            pid: process.pid,
            mode:
              options.profile === 'desktop'
                ? 'desktop'
                : options.profile === 'headless'
                  ? 'headless'
                  : 'web',
            appVersion: (
              JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
                version: string;
              }
            ).version,
            ...(recovery ? { recoveryMode: true as const, recoveryHome: home } : {}),
          }),
        );
        host.provide(AXTERM_LAUNCH_ENVIRONMENT_KEY, environment);
        await host.plugin(PluginPackages, { resolution });
        provideCmdline(host, {
          args: options.args,
          exit: (code) => {
            void shutdown.shutdown(code);
          },
          ready: readiness.service,
        });
        await options.prepare?.(host);
      },
    );
    const missing = (options.requiredServices ?? []).filter((key) => ctx.get(key) === undefined);
    if (missing.length) throw new Error('PROFILE_REQUIRED_SERVICES_UNAVAILABLE');
    if (ctx.fiber.state === FIBER_ACTIVE && ctx.get('loader')) readiness.commit();
    await releaseMigration();
    releaseMigration = undefined;
    return { ctx, shutdown };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Profile startup and cleanup failed', {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
