#!/usr/bin/env node
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { PROFILE_TEMPLATES } from './profile-templates.ts';
import { fileURLToPath } from 'node:url';
import { resolveAxtermHome } from '@axterm/infra-home-paths';
import { dumpProfile, runProfile, type ProfileBootOptions } from './profile-boot.ts';
import { parseInvocation } from './invocation.ts';
import { runPluginCommand, PLUGIN_USAGE } from './plugin-command.ts';

const invocation = parseInvocation(process.argv.slice(2));
if (invocation.kind === 'help') {
  console.info(
    'Usage: axterm --profile <name> [--patch <file>] [--dump-config] [application arguments]',
  );
} else if (invocation.kind === 'plugin') {
  if (!invocation.args.length || invocation.args.includes('--help'))
    process.stdout.write(PLUGIN_USAGE);
  else
    process.stdout.write(
      JSON.stringify(await runPluginCommand(invocation.args, resolveAxtermHome())) + '\n',
    );
} else {
  const options: ProfileBootOptions = {
    profile: invocation.profile,
    home: resolveAxtermHome(),
    installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)),
    templates: PROFILE_TEMPLATES,
    requiredServices:
      invocation.profile === 'headless'
        ? ['headlessCommand', 'subprocess']
        : ['subprocess', 'webStartup', 'clientModules', 'typertGateway', 'remoteEvents'],
    prepare(ctx) {
      if (invocation.profile !== 'headless') {
        const index = createRequire(import.meta.url).resolve('@axterm/web/dist');
        ctx.provide('webAssets', { index, authenticationPage: join(dirname(index), 'auth.html') });
      }
      ctx.provide('profileTemplates', PROFILE_TEMPLATES);
    },
    patchFiles: invocation.patchFiles.map((file) => resolve(file)),
    args: [...invocation.args],
  };
  if (invocation.dump) process.stdout.write(dumpProfile(options));
  else {
    const app = await runProfile(options);
    if (options.profile === 'web') {
      const startup = app.ctx.get('webStartup') as { url: string; tokenFile?: string } | undefined;
      if (!startup) {
        await app.shutdown.shutdown(1);
        throw new Error('WEB_STARTUP_UNAVAILABLE');
      }
      process.stdout.write(`Axterm: ${startup.url}\nLaunch token file: ${startup.tokenFile}\n`);
    }
  }
}
