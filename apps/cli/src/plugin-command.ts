import { clearProfileRecovery, profileRecoveryActive } from '@axterm/infra-profile-recovery';
import { Context } from '@deepseek-ai/cordis';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import LocalSubprocess from '@axterm/infra-subprocess-local';
import * as Manager from '@axterm/infra-plugin-manager';
import { readProfileManifest } from '@axterm/infra-app-boot';
import { withProfileManagement } from './profile-boot.ts';
import { PROFILE_TEMPLATES } from './profile-templates.ts';

export const PLUGIN_USAGE = `Usage: axterm plugin --profile <name> <command>
  list | inspect <spec> | add <spec> [--disabled] | upgrade <spec> [--disabled]
  remove <package> | enable|disable <package> [--entry]
  builds | approve-builds <id[,id]> --confirm
  allow-version <package@version> --axterm-version <version> --accept-risk
  deny-version <package@version> --axterm-version <version>
  recovery status | recovery clear --confirm
  transactions | repair <transaction-id>
Registry defaults to https://registry.npmjs.org/ with no fallbacks; --registry selects an explicit source.
External code runs with application permissions. Installation never executes dependency build scripts.
`;

interface PluginInvocation {
  profile: string;
  registry?: string;
  command:
    | 'recovery'
    | 'list'
    | 'builds'
    | 'approve-builds'
    | 'transactions'
    | 'repair'
    | 'inspect'
    | 'add'
    | 'upgrade'
    | 'remove'
    | 'enable'
    | 'disable'
    | 'allow-version'
    | 'deny-version';
  target?: string;
  entry: boolean;
  runtimeVersion?: string;
  acceptRisk: boolean;
  disabled: boolean;
  confirm: boolean;
}
export function parsePluginInvocation(args: readonly string[]): PluginInvocation {
  let profile: string | undefined, registry: string | undefined, runtimeVersion: string | undefined;
  let entry = false,
    acceptRisk = false,
    disabled = false,
    confirm = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!;
    if (value === '--profile' || value === '--registry' || value === '--axterm-version') {
      const next = args[++i];
      if (!next || next.startsWith('-')) throw new Error('PLUGIN_ARGUMENT_REQUIRED');
      if (value === '--profile') {
        if (profile) throw new Error('DUPLICATE_PLUGIN_PROFILE');
        profile = next;
      } else if (value === '--registry') {
        if (registry) throw new Error('DUPLICATE_PLUGIN_REGISTRY');
        registry = next;
      } else {
        if (runtimeVersion) throw new Error('DUPLICATE_PLUGIN_RUNTIME');
        runtimeVersion = next;
      }
    } else if (value === '--entry') entry = true;
    else if (value === '--accept-risk') acceptRisk = true;
    else if (value === '--disabled') disabled = true;
    else if (value === '--confirm') confirm = true;
    else if (value.startsWith('-')) throw new Error('UNKNOWN_PLUGIN_ARGUMENT');
    else positional.push(value);
  }
  const [command, target] = positional;
  if (!profile || !/^[a-z][a-z0-9-]*$/.test(profile)) throw new Error('PLUGIN_PROFILE_REQUIRED');
  const commands = [
    'recovery',
    'list',
    'builds',
    'approve-builds',
    'transactions',
    'repair',
    'inspect',
    'add',
    'upgrade',
    'remove',
    'enable',
    'disable',
    'allow-version',
    'deny-version',
  ] as const;
  if (
    !commands.some((value) => command === value) ||
    positional.length !== (['list', 'builds', 'transactions'].includes(command ?? '') ? 1 : 2)
  )
    throw new Error('INVALID_PLUGIN_COMMAND');
  const versionCommand = command === 'allow-version' || command === 'deny-version';
  if (
    versionCommand !== !!runtimeVersion ||
    (acceptRisk && command !== 'allow-version') ||
    (entry && command !== 'enable' && command !== 'disable') ||
    (disabled && command !== 'add' && command !== 'upgrade') ||
    (confirm && command !== 'approve-builds' && !(command === 'recovery' && target === 'clear')) ||
    (command === 'recovery' &&
      (registry !== undefined ||
        !['status', 'clear'].includes(target ?? '') ||
        (target === 'clear' && !confirm)))
  )
    throw new Error('INVALID_PLUGIN_ARGUMENT');
  return {
    profile,
    command: command as PluginInvocation['command'],
    entry,
    acceptRisk,
    disabled,
    confirm,
    ...(target ? { target } : {}),
    ...(registry ? { registry } : {}),
    ...(runtimeVersion ? { runtimeVersion } : {}),
  };
}
export async function runPluginCommand(args: readonly string[], home: string): Promise<unknown> {
  const invocation = parsePluginInvocation(args);
  if (invocation.command === 'recovery') {
    if (invocation.target === 'clear') {
      await clearProfileRecovery(home, invocation.profile, invocation.confirm);
      return { profile: invocation.profile, recovery: false };
    }
    return withProfileManagement(
      { profile: invocation.profile, home, templates: PROFILE_TEMPLATES },
      async () => ({
        profile: invocation.profile,
        recovery: profileRecoveryActive(home, invocation.profile),
      }),
    );
  }
  return withProfileManagement(
    { profile: invocation.profile, home, templates: PROFILE_TEMPLATES },
    async (directory) => {
      const ctx = new Context();
      ctx.provide('profileContext', {
        name: invocation.profile,
        home: resolve(home),
        dir: directory,
        patchPath: join(directory, 'cordis.patch.yml'),
        installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)),
        cwd: process.cwd(),
        startedBundles: readProfileManifest('axterm', directory).axterm?.profile?.bundles ?? [],
        overlays: [],
        telemetryDisabledEnv: undefined,
      });
      let owner: Manager.PluginManager | undefined;
      try {
        await ctx.plugin(LocalSubprocess);
        owner = await Manager.createPluginManager(
          ctx,
          {
            ...(invocation.registry ? { registry: invocation.registry } : {}),
          },
          true,
        );
        if (!ctx.get('pluginManager')) throw new Error('PLUGIN_MANAGER_UNAVAILABLE');
        const manager = ctx.pluginManager,
          target = invocation.target!;
        const source = () => (existsSync(resolve(target)) ? resolve(target) : target);
        switch (invocation.command) {
          case 'list':
            return {
              profile: invocation.profile,
              packages: manager.list(),
              entries: manager.entries(),
            };
          case 'builds':
            return await manager.pendingBuilds();
          case 'approve-builds':
            return await manager.approveBuilds(target.split(','), invocation.confirm);
          case 'transactions':
            return await manager.transactions();
          case 'repair':
            return await manager.repair(target);
          case 'inspect':
            return await manager.inspect(source());
          case 'add':
            return await manager.install(source(), { enabled: !invocation.disabled });
          case 'upgrade':
            return await manager.install(source(), {
              replace: true,
              ...(invocation.disabled ? { enabled: false } : {}),
            });
          case 'remove':
            return await manager.remove(target);
          case 'enable':
          case 'disable':
            return invocation.entry
              ? await manager.setPluginEnabled(target, invocation.command === 'enable')
              : await manager.setBundleEnabled(target, invocation.command === 'enable');
          case 'allow-version':
          case 'deny-version':
            return await manager.allowVersion(
              target,
              invocation.runtimeVersion!,
              invocation.command === 'allow-version',
              invocation.acceptRisk,
            );
        }
      } finally {
        try {
          await owner?.close();
        } finally {
          await ctx.fiber.dispose();
        }
      }
    },
  );
}
