import type { Context } from '@deepseek-ai/cordis';
import type { PluginCommandsService } from '@axterm/plugin-api/host';
import type { AiPluginManagementPort } from '../ports/plugins.ts';
import { ApplicationError } from '../application/errors.ts';
/** Uses the current Plugins owner; never calls pnpm or waits for Engine uninstall. */
export function pluginManagement(ctx: Context, profile: string): AiPluginManagementPort {
  const current = () => ctx.get('pluginCommands') as PluginCommandsService | undefined;
  return {
    target: 'Profile ' + profile,
    available: () => current() !== undefined,
    async invoke(id, generation, input, signal) {
      signal?.throwIfAborted();
      const commands = current();
      if (!commands || commands.generation !== generation)
        throw new ApplicationError(
          'CAPABILITY_UNAVAILABLE',
          'Plugin management is unavailable',
          503,
        );
      switch (input.action) {
        case 'command':
          return commands.execute(id, generation, input.request);
        case 'outcome':
          return commands.outcome(input.id);
        case 'snapshot': {
          const snapshot = await commands.snapshot();
          const inventory = snapshot.inventory;
          return {
            generation: snapshot.generation,
            inventory: inventory
              ? {
                  packages: inventory.packages.slice(0, 32),
                  entries: inventory.entries.slice(0, 32),
                  builds: inventory.builds.slice(0, 32),
                  transactions: inventory.transactions.length,
                  counts: {
                    packages: inventory.packages.length,
                    entries: inventory.entries.length,
                    builds: inventory.builds.length,
                  },
                  truncated:
                    inventory.packages.length > 32 ||
                    inventory.entries.length > 32 ||
                    inventory.builds.length > 32,
                }
              : null,
            commands: snapshot.commands.slice(0, 4),
          };
        }
        case 'inspect': {
          const inspection = await commands.inspect(input.spec, signal, input.registry);
          return {
            spec: inspection.spec,
            registry: inspection.registry,
            name: inspection.manifest.name,
            version: inspection.manifest.version,
            engines: inspection.manifest.engines,
            peerDependencies: inspection.manifest.peerDependencies,
            bundle: !!inspection.manifest.axterm?.bundle,
          };
        }
      }
    },
  };
}
