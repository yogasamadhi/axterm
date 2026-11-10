import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runProfile } from '../../apps/cli/src/profile-boot.ts';
import { PROFILE_TEMPLATES } from '../../apps/cli/src/profile-templates.ts';
import type {} from '../../packages/infra/hmr/src/index.ts';
it('drains an admitted HMR mutation before releasing Loader and its providers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'axterm-profile-shutdown-'));
  let app: Awaited<ReturnType<typeof runProfile>> | undefined;
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  try {
    app = await runProfile({
      profile: 'web',
      home,
      installAnchor: resolve('apps/cli/package.json'),
      templates: PROFILE_TEMPLATES,
      patchFiles: [],
      args: [],
      requiredServices: ['configurationController', 'hmr'],
      prepare(ctx) {
        ctx.provide('webAssets', {
          index: resolve('apps/web/dist/index.html'),
          authenticationPage: resolve('apps/web/dist/auth.html'),
        });
      },
    });
    const host = app.ctx,
      hmr = host.hmr;
    const mutation = hmr.runExclusive(async () => {
      entered.resolve();
      await release.promise;
      expect(host.get('loader')).toBeDefined();
      expect(host.get('configurationController')).toBeDefined();
    });
    await entered.promise;
    const stopping = app.shutdown.shutdown(0);
    const rejected = expect(hmr.runExclusive(async () => {})).rejects.toThrow('disposed');
    expect(host.get('configurationController')).toBeDefined();
    release.resolve();
    await mutation;
    await rejected;
    await stopping;
    expect(host.get('loader')).toBeUndefined();
    app = undefined;
  } finally {
    release.resolve();
    await app?.shutdown.shutdown(0);
    await rm(home, { recursive: true, force: true });
  }
});
