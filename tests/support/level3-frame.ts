import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
/** A test-only Client contribution; this is deliberately not a product workspace. */
export async function installFrameFixture(
  home: string,
  surface: 'web' | 'desktop',
  options: { taskInspectionFailure?: boolean } = {},
): Promise<void> {
  const profile = join(home, 'profiles', surface);
  const bundle = join(profile, 'node_modules/@fixture/bundle');
  const frame = join(profile, 'node_modules/@fixture/frame');
  await mkdir(bundle, { recursive: true });
  await mkdir(frame, { recursive: true });
  const json = (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
  await json(join(profile, 'package.json'), {
    name: 'fixture-profile',
    private: true,
    dependencies: { '@fixture/bundle': '1.0.0', '@fixture/frame': '1.0.0' },
    axterm: {
      profile: { bundles: ['@axterm/bundle-base', '@axterm/bundle-web', '@fixture/bundle'] },
    },
  });
  await json(join(bundle, 'package.json'), {
    name: '@fixture/bundle',
    version: '1.0.0',
    dependencies: { '@fixture/frame': '1.0.0' },
    axterm: { bundle: { patch: './patch.json' } },
  });
  await json(join(bundle, 'patch.json'), [
    { insert: [{ id: 'fixture-frame', name: '@fixture/frame' }] },
  ]);
  await json(join(frame, 'package.json'), {
    name: '@fixture/frame',
    version: '1.0.0',
    type: 'module',
    exports: {
      '.': './index.js',
      './client': { browser: './client.browser.js', default: './client.js' },
    },
    axterm: {
      client: { platform: 'web', immediately: true, external: ['@axterm/plugin-desktop/client'] },
    },
  });
  await writeFile(
    join(frame, 'index.js'),
    options.taskInspectionFailure
      ? `export const inject=['desktopTaskInspection'];
    export function apply(ctx){ctx.desktopTaskInspection.register('fixture-unknown',{inspect(){throw new Error('CONTROLLED_TASK_INSPECTION_FAILURE');},async dispose(){}});}`
      : 'export function apply() {}',
  );
  await writeFile(
    join(frame, 'client.browser.js'),
    `window.__ModuleLoader__.load({id:'@fixture/frame',factory(require){
    const React=require('react');
    return {inject:['slots','desktopRuntimeModel'],apply(ctx){ const model=ctx.desktopRuntimeModel;
      ctx.slots.register({name:'root'},function Probe(){ const state=React.useSyncExternalStore(model.subscribe,model.getSnapshot);
        return React.createElement('main',{'data-probe-state':state.status},state.status==='ready'
          ? React.createElement('output',{'data-generation':state.baseline.metadata.generation},state.baseline.version.appVersion):state.status); });
    }};
  }});`,
  );
}
