import { checkOperationMap } from '../../scripts/level3-operation-map.mjs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { checkFrameworkSource, frameworkNames } from '../../scripts/dsh-framework.mjs';
import {
  inspectLevel3Source,
  inspectRemoteContributors,
  inspectSourceFirst,
  inspectClientSource,
  inspectClientConfiguration,
} from '../../scripts/level3-architecture.mjs';
import { isExcludedFromIndependentSnapshot } from '../../scripts/commercialization/audit-independent-snapshot.mjs';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Level 3 migration foundation', () => {
  it('reserves the React root for the selected UI renderer', () => {
    const source = "import {createRoot} from 'react-dom/client'";
    expect(
      inspectLevel3Source(
        '/repo/packages/infra/ui-renderer/src/client/index.ts',
        source,
        { name: '@axterm/infra-ui-renderer', dependencies: { 'react-dom': '18.3.1' } },
        'client',
      ),
    ).toEqual([]);
    expect(
      inspectLevel3Source(
        '/repo/packages/plugins/example/src/client/index.ts',
        source,
        { name: '@axterm/plugin-example', dependencies: { 'react-dom': '18.3.1' } },
        'client',
      ).join(' '),
    ).toContain('React root');
  });
  it('allows only the exact Web module-identity seed without exposing root execution', () => {
    const path = '/repo/apps/web/src/seed.ts',
      manifest = { name: '@axterm/web', dependencies: { 'react-dom': '18.3.1' } };
    const source =
      "import * as ReactDomClient from 'react-dom/client'; export function getStaticModules(){return {'react-dom/client':ReactDomClient}}";
    expect(inspectLevel3Source(path, source, manifest, 'client')).toEqual([]);
    for (const extra of [
      'ReactDomClient.createRoot(document.body);',
      'const root=ReactDomClient.createRoot;',
    ])
      expect(inspectLevel3Source(path, source + extra, manifest, 'client').join(' ')).toContain(
        'React root',
      );
    expect(
      inspectLevel3Source('/repo/apps/web/src/other.ts', source, manifest, 'client').join(' '),
    ).toContain('React root');
  });
  it('permits only filesystem recovery in the shell and rejects execution dependencies in that component', () => {
    const file = '/repo/apps/desktop/src/shell/application.ts';
    const shell = {
      name: '@axterm/desktop',
      dependencies: { '@axterm/infra-profile-recovery': 'workspace:*' },
    };
    expect(
      inspectLevel3Source(file, "import '@axterm/infra-profile-recovery'", shell, 'shell'),
    ).toEqual([]);
    for (const name of [
      '@axterm/infra-app-boot',
      '@axterm/infra-app-boot/recovery',
      '@axterm/cli/profile-boot',
    ])
      expect(inspectLevel3Source(file, `import '${name}'`, shell, 'shell').join(' ')).toContain(
        'Desktop shell',
      );
    const owner = {
      name: '@axterm/infra-profile-recovery',
      dependencies: { '@axterm/infra-atomic-write': 'workspace:*' },
    };
    const source = '/repo/packages/infra/profile-recovery/src/index.ts';
    expect(inspectLevel3Source(source, 'await import(name)', owner).join(' ')).toContain(
      'Profile recovery dynamic resolution',
    );
    expect(
      inspectLevel3Source(source, "process.getBuiltinModule('node:child_process')", owner).join(
        ' ',
      ),
    ).toContain('Profile recovery is filesystem-only');
    expect(
      inspectLevel3Source(source, "import 'node:fs'; import '@axterm/infra-atomic-write'", owner),
    ).toEqual([]);
    for (const name of [
      'node:child_process',
      'node:module',
      'node:net',
      'electron',
      '@axterm/infra-app-boot',
    ]) {
      expect(inspectLevel3Source(source, `await import('${name}')`, owner).join(' ')).toContain(
        'Profile recovery is filesystem-only',
      );
      expect(
        inspectLevel3Source(source, '', {
          ...owner,
          dependencies: { ...owner.dependencies, [name]: '*' },
        }).join(' '),
      ).toContain('Profile recovery dependency is filesystem-only');
    }
  });
  it('rejects direct AI Agent/API execution, including imports hidden inside the selected metadata adapter', () => {
    const manifest = {
      name: '@axterm/plugin-ai',
      dependencies: {
        '@axterm/engine-pi-core': 'workspace:*',
        '@axterm/engine-pi': 'workspace:*',
        '@axterm/engine-api': 'workspace:*',
      },
    };
    const metadata = '/repo/packages/plugins/ai/src/adapters/pi-metadata.ts';
    expect(
      inspectLevel3Source(
        metadata,
        "import {piCatalog,piSkills as skills} from '@axterm/engine-pi-core'",
        manifest,
      ),
    ).toEqual([]);
    expect(
      inspectLevel3Source(
        '/repo/packages/plugins/ai/src/adapters/command-review.ts',
        "import {parseDecision,estimateReviewTextTokens} from '@axterm/engine-pi-core'",
        manifest,
      ),
    ).toEqual([]);
    for (const code of [
      "import {streamPiAgent} from '@axterm/engine-pi-core'",
      "import {piSkills,streamPiAgent} from '@axterm/engine-pi-core'",
      "import * as core from '@axterm/engine-pi-core'",
      "import core from '@axterm/engine-pi-core'",
      "import '@axterm/engine-pi-core'",
      "export {piCatalog} from '@axterm/engine-pi-core'",
      "await import('@axterm/engine-pi-core')",
      "const core=require('@axterm/engine-pi-core')",
      "import {PiEngineProvider} from '@axterm/engine-pi'",
      "import {piCatalog} from '@axterm/engine-pi-core/unreviewed'",
    ])
      expect(inspectLevel3Source(metadata, code, manifest).join(' ')).toContain(
        'AI Agent/API execution must use ctx.engines',
      );
    expect(
      inspectLevel3Source(
        '/repo/packages/plugins/ai/src/adapters/other.ts',
        "import {piCatalog} from '@axterm/engine-pi-core'",
        manifest,
      ).join(' '),
    ).toContain('AI Agent/API execution must use ctx.engines');
    expect(
      inspectLevel3Source(metadata, '', { ...manifest, dependencies: { openai: '1.0.0' } }).join(
        ' ',
      ),
    ).toContain('AI provider SDK dependency must remain behind ctx.engines');
    expect(
      inspectLevel3Source(metadata, "await import('@axterm/' + name)", manifest).join(' '),
    ).toContain('AI dynamic dependency resolution must name a reviewed contract');
    const discovery = '/repo/packages/plugins/ai/src/adapters/model-discovery.ts';
    expect(
      inspectLevel3Source(
        discovery,
        "import {discoverLegacyModels} from '@axterm/engine-pi/discovery'",
        manifest,
      ),
    ).toEqual([]);
    for (const code of [
      "import * as discovery from '@axterm/engine-pi/discovery'",
      "import {PiEngineProvider} from '@axterm/engine-pi/discovery'",
      "export {discoverLegacyModels} from '@axterm/engine-pi/discovery'",
      "await import('@axterm/engine-pi/discovery')",
    ])
      expect(inspectLevel3Source(discovery, code, manifest).join(' ')).toContain(
        'AI Agent/API execution must use ctx.engines',
      );
    expect(
      inspectLevel3Source(
        metadata,
        "import {discoverLegacyModels} from '@axterm/engine-pi/discovery'",
        manifest,
      ).join(' '),
    ).toContain('AI Agent/API execution must use ctx.engines');
  });
  it('enforces one shared controls owner and rejects the retired UI stack, including unused dependencies', () => {
    const file = '/repo/packages/plugins/fixture/src/client/view.tsx';
    for (const name of [
      'radix-ui',
      '@radix-ui/react-dialog',
      'class-variance-authority',
      '@base-ui/react',
      'tailwind-merge',
      'tailwindcss',
      '@tailwindcss/vite',
    ]) {
      const manifest = { name: '@axterm/plugin-fixture', dependencies: { [name]: '1.0.0' } };
      expect(
        inspectLevel3Source(file, `import '${name}'`, manifest, 'client').length,
      ).toBeGreaterThan(0);
      expect(inspectLevel3Source(file, '', manifest, 'client').length).toBeGreaterThan(0);
    }
    const owner = {
      name: '@axterm/ui',
      dependencies: { 'radix-ui': '1.8.1', 'class-variance-authority': '0.7.1' },
    };
    expect(
      inspectLevel3Source(
        '/repo/packages/api/ui/src/client/controls.tsx',
        "import 'radix-ui';import 'class-variance-authority'",
        owner,
        'client',
      ),
    ).toEqual([]);
    expect(
      inspectLevel3Source(
        file,
        "import {Button} from '@axterm/ui/controls'",
        { name: '@axterm/plugin-fixture', dependencies: { '@axterm/ui': 'workspace:*' } },
        'client',
      ),
    ).toEqual([]);
  });

  it('rejects native imports in a Client TSX contribution with the same boundary as TypeScript models', () => {
    const file = '/repo/packages/plugins/fixture/src/client/panel.tsx';
    const manifest = { name: '@axterm/plugin-fixture', dependencies: {} };
    expect(
      inspectClientSource(
        file,
        "import {readFile} from 'node:fs/promises'; export const Panel=()=> <main/>;",
        manifest,
      ).join(' '),
    ).toContain('Client code cannot import native modules');
  });
  it('rejects direct native IO, concrete adapters and private infrastructure in domain/application code', () => {
    const manifest = {
      name: '@axterm/plugin-fixture',
      dependencies: { 'node-pty': '*', '@axterm/infra-storage-relational': '*' },
    };
    const file = '/repo/packages/plugins/fixture/src/application/workflow.ts';
    for (const specifier of [
      'node:fs',
      'node:sqlite',
      'node:child_process',
      'node-pty',
      '@axterm/infra-storage-relational',
      '../adapters/database.ts',
    ])
      expect(inspectLevel3Source(file, `import '${specifier}'`, manifest).join(' ')).toContain(
        'Application/domain code must use its owned ports',
      );
    expect(
      inspectLevel3Source(file, "import type { ReadStream } from 'node:fs'", manifest),
    ).toEqual([]);
    expect(
      inspectLevel3Source(
        '/repo/packages/plugins/fixture/src/adapters/pty.ts',
        "import 'node-pty'",
        manifest,
      ).join(' '),
    ).toContain('Business plugins must acquire PTYs through ctx.subprocess');
    expect(
      inspectLevel3Source(
        '/repo/packages/plugins/fixture/src/adapters/pty.ts',
        "import type {SubprocessService} from '@axterm/plugin-api/host'",
        { name: '@axterm/plugin-fixture', dependencies: { '@axterm/plugin-api': '*' } },
      ),
    ).toEqual([]);
  });
  it('requires every declared Remote contributor in the source-first compiler aggregate', () => {
    const contributors = [
      {
        directory: 'packages/plugins/fixture',
        manifest: {
          name: '@axterm/plugin-fixture',
          exports: { './typert': './lib/typert.host.js' },
        },
        hostConfig: 'tsconfig.host.json',
      },
    ];
    expect(inspectRemoteContributors({ references: [] }, contributors).join(' ')).toContain(
      'absent',
    );
    expect(
      inspectRemoteContributors(
        { references: [{ path: './packages/plugins/fixture/tsconfig.host.json' }] },
        contributors,
      ),
    ).toEqual([]);
  });

  it('owns Electron imports only in the narrow Desktop shell source role', () => {
    const file = '/repo/apps/desktop/src/shell/index.ts';
    const manifest = {
      name: '@axterm/desktop',
      dependencies: {
        electron: '*',
        '@axterm/cli': '*',
        '@workspace/runtime': '*',
        '@axterm/plugin-desktop': '*',
        react: '*',
        '@axterm/web': '*',
      },
    };
    expect(inspectLevel3Source(file, "import { app } from 'electron'", manifest, 'shell')).toEqual(
      [],
    );
    for (const dependency of [
      '@axterm/cli',
      '@workspace/runtime',
      '@axterm/plugin-desktop',
      'react',
      '../main/index.ts',
    ])
      expect(
        inspectLevel3Source(file, `import '${dependency}'`, manifest, 'shell').join(' '),
      ).toContain('Desktop shell');
    expect(
      inspectLevel3Source(file, "import '@axterm/web/bootstrap'", manifest, 'shell').join(' '),
    ).toContain('only use Web bootstrap types');
    for (const [path, face] of [
      [file, 'client'],
      [file, 'host'],
      ['/repo/apps/other/src/shell/index.ts', 'shell'],
      ['/repo/apps/desktop/src/main/index.ts', 'shell'],
    ])
      expect(inspectLevel3Source(path!, "import 'electron'", manifest, face).join(' ')).toContain(
        'Native shell dependency',
      );
  });

  it('rejects Node, native services and execution modules from the sandboxed preload', () => {
    const manifest = {
      name: '@axterm/desktop',
      dependencies: { electron: '*', '@axterm/infra-credential-vault': '*' },
    };
    for (const specifier of ['node:fs', '@axterm/infra-credential-vault', './application.ts'])
      expect(
        inspectLevel3Source(
          '/repo/apps/desktop/src/shell/preload.ts',
          `import '${specifier}'`,
          manifest,
          'shell',
        ).join(' '),
      ).toContain('Desktop preload only permits');
  });
  it('restricts the pinned native package binding to its exact private Host owner', () => {
    const source = "require('internal/test/binding')";
    const owner = { name: '@axterm/infra-hmr' };
    expect(
      inspectLevel3Source('/packages/infra/hmr/src/package-manifest.ts', source, owner),
    ).toEqual([]);
    for (const [path, manifest, face] of [
      ['/packages/infra/hmr/src/package-manifest.ts', owner, 'client'],
      ['/packages/infra/hmr/src/other.ts', owner, 'host'],
      ['/packages/api/plugin-api/src/index.ts', { name: '@axterm/plugin-api' }, 'host'],
      ['/packages/infra/other/src/package-manifest.ts', { name: '@axterm/infra-other' }, 'host'],
    ] as const)
      expect(inspectLevel3Source(path, source, manifest, face).join(' ')).toContain(
        'Node internal access is restricted',
      );
    expect(
      inspectLevel3Source(
        '/packages/infra/hmr/src/package-manifest.ts',
        "require('internal/unknown')",
        owner,
      ).join(' '),
    ).toContain('Node internal access is restricted');
  });

  it('rejects Node capabilities and paired Host entries throughout a Client source graph', () => {
    const manifest = { name: '@axterm/infra-fixture', exports: { './client': './lib/client.js' } };
    for (const source of [
      "import type { Buffer } from 'node:buffer'",
      "import('node:fs')",
      "require('fs')",
    ])
      expect(
        inspectClientSource('/packages/fixture/src/shared.ts', source, manifest).join(' '),
      ).toContain('Client code cannot import native modules');
    expect(
      inspectClientSource(
        '/packages/fixture/src/index.ts',
        'export const value = 1',
        manifest,
      ).join(' '),
    ).toContain("Client program cannot load a paired package's Host entry");
    expect(
      inspectClientSource('/packages/fixture/src/shared.ts', 'export const value = 1', manifest),
    ).toEqual([]);
  });

  it('permits declared generated self exports while rejecting private paths and the Client Host entry', () => {
    const manifest = {
      name: '@axterm/plugin-fixture',
      exports: {
        '.': './lib/index.js',
        './client': './lib/client.js',
        './remote': './lib/typert.remote-client.js',
      },
    };
    expect(
      inspectClientSource(
        '/packages/fixture/src/client/index.ts',
        "import '@axterm/plugin-fixture/remote'",
        manifest,
      ),
    ).toEqual([]);
    expect(
      inspectLevel3Source('src/index.ts', "import '@axterm/plugin-fixture/private'", manifest).join(
        ' ',
      ),
    ).toContain('declared export');
    expect(
      inspectClientSource(
        '/packages/fixture/src/client/index.ts',
        "import '@axterm/plugin-fixture'",
        manifest,
      ).join(' '),
    ).toContain('Host entry');
  });

  it('requires explicit Client ambient isolation and source mappings', () => {
    expect(inspectClientConfiguration({ compilerOptions: { types: [] } })).toEqual([]);
    expect(inspectClientConfiguration({ compilerOptions: { types: ['node'] } })).toHaveLength(1);
    expect(inspectClientConfiguration({})).toHaveLength(1);
    for (const target of ['./packages/api/src/host/types.ts', './packages/api/lib/types.d.ts'])
      expect(
        inspectClientConfiguration({
          compilerOptions: { types: [], paths: { '@axterm/fixture': [target] } },
        }),
      ).toHaveLength(1);
  });
  it('excludes every application build artifact from an independent source snapshot', () => {
    for (const name of ['cli', 'desktop', 'desktop-host', 'web']) {
      expect(isExcludedFromIndependentSnapshot(`apps/${name}/lib`)).toBe(true);
      expect(isExcludedFromIndependentSnapshot(`apps/${name}/lib/shell/main.js`)).toBe(true);
      expect(isExcludedFromIndependentSnapshot(`apps/${name}/tsconfig.generated.json`)).toBe(true);
      expect(isExcludedFromIndependentSnapshot(`apps/${name}/src/index.ts`)).toBe(false);
    }
  });
  it('excludes only generated Engine outputs while preserving the independent Engine source inputs', () => {
    for (const path of [
      'packages/engines/pi/lib',
      'packages/engines/pi/lib/index.js',
      'packages/engines/pi/lib/types/index.d.ts',
      'packages/engines/pi/tsconfig.generated.json',
    ])
      expect(isExcludedFromIndependentSnapshot(path)).toBe(true);
    for (const path of [
      'packages/engines/pi/src/index.ts',
      'packages/engines/pi/src/config.ts',
      'packages/engines/pi/tsconfig.json',
      'packages/engines/pi/LICENSE',
      'packages/engines/pi/SOURCE.json',
    ])
      expect(isExcludedFromIndependentSnapshot(path)).toBe(false);
  });
  it('assigns every frozen operation once without pretending migration has passed', async () => {
    const map = JSON.parse(
      await readFile('tests/fixtures/engineering/level3/operation-map.json', 'utf8'),
    );
    const client = await readFile(
      'tests/fixtures/engineering/level3/frozen/level1-api.d.ts',
      'utf8',
    );
    const ids = [
      ...client.matchAll(
        /^ {8}(?:get|put|post|delete|patch|options|head|trace): operations\["([^"\n]+)"\];/gm,
      ),
    ].map((match) => match[1]);
    expect(ids).toHaveLength(264);
    expect(
      map.operations.map((entry: { operationId: string }) => entry.operationId).sort(),
    ).toEqual(ids.sort());
    expect(await checkOperationMap()).toMatchObject({ total: 264 });
  });

  it('keeps current Axterm screenshot bytes tied to the pre-migration commit', async () => {
    const { createHash } = await import('node:crypto');
    const baseline = JSON.parse(
      await readFile('tests/fixtures/engineering/level3/baseline.json', 'utf8'),
    );
    expect(baseline.sourceCommit).toBe('f252e62c7841ba906f9d4cb73152cd55a3bea9b3');
    const images = baseline.files.filter((file: { path: string }) =>
      file.path.startsWith('tests/e2e/visual.spec.ts-snapshots/'),
    );
    expect(images.length).toBeGreaterThanOrEqual(19);
    for (const image of images)
      expect(
        createHash('sha256')
          .update(await readFile(image.path))
          .digest('hex'),
      ).toBe(image.sha256);
  });

  it('verifies framework originals and rejects a source or manifest alteration', async () => {
    await expect(checkFrameworkSource()).resolves.toBe(resolve('vendor/deepseek-harness'));
    const root = await mkdtemp(join(tmpdir(), 'axterm-framework-source-'));
    temporary.push(root);
    await cp(
      'compliance/DSH_FRAMEWORK_SOURCE.json',
      join(root, 'compliance/DSH_FRAMEWORK_SOURCE.json'),
      { recursive: true },
    );
    await cp('vendor/deepseek-harness/LICENSE', join(root, 'vendor/deepseek-harness/LICENSE'), {
      recursive: true,
    });
    for (const name of frameworkNames) {
      for (const leaf of [
        'package.json',
        'tsconfig.json',
        'LICENSE',
        'src',
        ...(name === 'timer' ? ['locale'] : []),
      ])
        await cp(
          `vendor/deepseek-harness/vendor/${name}/${leaf}`,
          join(root, `vendor/deepseek-harness/vendor/${name}/${leaf}`),
          { recursive: true },
        );
      await cp(
        `packages/framework/${name}/package.json`,
        join(root, `packages/framework/${name}/package.json`),
        { recursive: true },
      );
    }
    await expect(checkFrameworkSource(root)).resolves.toBe(join(root, 'vendor/deepseek-harness'));
    const original = await readFile(
      join(root, 'vendor/deepseek-harness/vendor/cordis/src/index.ts'),
      'utf8',
    );
    await writeFile(
      join(root, 'vendor/deepseek-harness/vendor/cordis/src/index.ts'),
      original + '\n// changed\n',
    );
    await expect(checkFrameworkSource(root)).rejects.toThrow('differs');
    await writeFile(join(root, 'vendor/deepseek-harness/vendor/cordis/src/index.ts'), original);
    await writeFile(join(root, 'packages/framework/cordis/package.json'), '{}\n');
    await expect(checkFrameworkSource(root)).rejects.toThrow('manifest was modified');
  });

  it('includes only framework reconstruction inputs in independent snapshots', () => {
    for (const path of [
      'vendor/deepseek-harness/vendor/cordis/src/context.ts',
      'vendor/deepseek-harness/vendor/cordis/LICENSE',
      'vendor/deepseek-harness/vendor/timer/locale/en.json',
    ])
      expect(isExcludedFromIndependentSnapshot(path)).toBe(false);
    for (const path of [
      'vendor/deepseek-harness/.git',
      'vendor/deepseek-harness/apps/cli',
      'vendor/deepseek-harness/packages/boot/app-boot',
      'vendor/deepseek-harness/vendor/cordis/lib/index.js',
      'packages/framework/cordis/src/index.ts',
      'packages/infra/app-boot/lib/index.js',
      'packages/api/plugin-api/lib/index.js',
      'packages/api/plugin-api/tsconfig.generated.json',
      'packages/data/schema/lib/index.js',
      'packages/data/schema/tsconfig.generated.json',
    ])
      expect(isExcludedFromIndependentSnapshot(path)).toBe(true);
  });

  it('rejects product dependencies and infrastructure-to-application imports', () => {
    const manifest = {
      name: '@axterm/infra-example',
      dependencies: {
        '@deepseek-ai/dsh-app-boot': '1',
        '@axterm/cli': 'workspace:*',
        '@deepseek-ai/cordis': 'workspace:*',
      },
    };
    expect(
      inspectLevel3Source(
        'src/index.ts',
        "import '@deepseek-ai/dsh-app-boot'; import '@axterm/cli'; import 'electron';",
        manifest,
      ).join('\n'),
    ).toMatch(/DSH product dependency/);
    expect(
      inspectLevel3Source('src/index.ts', "import '@axterm/cli';", manifest).join('\n'),
    ).toMatch(/Infrastructure cannot import application/);
    expect(
      inspectLevel3Source('src/index.ts', "import '@deepseek-ai/cordis';", {
        name: '@axterm/infra-example',
        dependencies: { '@deepseek-ai/cordis': 'workspace:*' },
      }),
    ).toEqual([]);
  });
  it('rejects dynamic product imports and relative dependency-boundary escapes', () => {
    const manifest = { name: '@axterm/infra-example', dependencies: {} };
    for (const source of [
      "await import('@deepseek-ai/dsh-webserver')",
      "const module=require('@deepseek-ai/dsh-webserver')",
      "type T=typeof import('@deepseek-ai/dsh-webserver')",
    ])
      expect(
        inspectLevel3Source('/repo/packages/infra/example/src/index.ts', source, manifest).join(
          '\n',
        ),
      ).toContain('DSH product dependency');
    expect(
      inspectLevel3Source(
        '/repo/packages/infra/example/src/index.ts',
        "import '../../../other/src/index.ts'",
        manifest,
      ).join('\n'),
    ).toContain('Relative import escapes package');
  });

  it('admits only the exact fixed Pi source edges and its source type facade', () => {
    const owner = { name: '@axterm/engine-pi-core' };
    const file = '/repo/packages/pi-engine/src/index.ts';
    const source =
      "import {runAgentLoop} from '../../../vendor/pi/packages/agent/src/agent-loop.ts'";
    expect(inspectLevel3Source(file, source, owner)).toEqual([]);
    const schema = "import {obj} from '../../../vendor/pi/packages/schema/src/index.ts'";
    expect(inspectLevel3Source(file, schema, owner)).toEqual([]);
    for (const [filename, code, manifest] of [
      ['/repo/packages/pi-engine/src/other.ts', source, owner],
      [file, source, { name: '@axterm/engine-other' }],
      [file, "import '../../../vendor/pi/packages/coding-agent/src/index.ts'", owner],
      [file, "import '../../../packages/runtime/src/index.ts'", owner],
      ['/repo/packages/pi-engine/src/other.ts', schema, owner],
      [file, schema, { name: '@axterm/engine-other' }],
      [file, "import '../../../vendor/pi/packages/schema/src/private.ts'", owner],
      [file, "import '../../../vendor/deepseek-harness/packages/schema/src/index.ts'", owner],
    ] as const)
      expect(inspectLevel3Source(filename, code, manifest).join(' ')).toContain(
        'Relative import escapes package',
      );
    const packages = [{ name: '@axterm/engine-pi-core', directory: 'packages/pi-engine' }];
    expect(
      inspectSourceFirst(
        {
          compilerOptions: {
            paths: { '@axterm/engine-pi-core': ['./packages/pi-engine/src/public.ts'] },
          },
        },
        packages,
      ),
    ).toEqual([]);
    for (const target of [
      './packages/pi-engine/lib/types/index.d.ts',
      './packages/pi-engine/dist/index.js',
      './packages/pi-engine/src/index.ts',
    ])
      expect(
        inspectSourceFirst(
          { compilerOptions: { paths: { '@axterm/engine-pi-core': [target] } } },
          packages,
        ),
      ).toHaveLength(1);
    expect(
      inspectSourceFirst(
        {
          compilerOptions: {
            paths: { '@axterm/engine-other': ['./packages/engines/other/src/public.ts'] },
          },
        },
        [{ name: '@axterm/engine-other', directory: 'packages/engines/other' }],
      ),
    ).toHaveLength(1);
  });
  it('rejects stale declaration mappings and Client leakage into the Host source check', () => {
    const packages = [{ name: '@axterm/infra-example', directory: 'packages/infra/example' }];
    expect(
      inspectSourceFirst(
        {
          compilerOptions: {
            paths: { '@axterm/infra-example': ['./packages/infra/example/lib/types/index.d.ts'] },
          },
          include: ['packages/example/src/client/index.ts'],
        },
        packages,
      ),
    ).toHaveLength(2);
    expect(
      inspectSourceFirst(
        {
          compilerOptions: {
            paths: { '@axterm/infra-example': ['./packages/infra/example/src/index.ts'] },
          },
          include: ['packages/infra/*/src/**/*.ts'],
        },
        packages,
      ),
    ).toEqual([]);
  });
  it('rejects undeclared native capabilities and legacy application dependencies even without a source import', () => {
    const errors = inspectLevel3Source('package.json', '', {
      name: '@axterm/infra-example',
      dependencies: { electron: '44.3.0', '@workspace/runtime': 'workspace:*' },
    });
    expect(errors.join('\n')).toContain('Native shell dependency');
    expect(errors.join('\n')).toContain('legacy application code');
  });
  it('keeps public contracts independent from private implementation and common native imports', () => {
    const manifest = {
      name: '@axterm/plugin-api',
      dependencies: { '@axterm/infra-connection': 'workspace:*' },
    };
    expect(
      inspectLevel3Source(
        '/repo/packages/api/plugin-api/src/index.ts',
        "import 'node:fs'",
        manifest,
      ).join('\n'),
    ).toContain('Common public API cannot import native');
    expect(inspectLevel3Source('package.json', '', manifest).join('\n')).toContain(
      'Public API cannot depend on private',
    );
    expect(
      inspectLevel3Source(
        '/repo/packages/api/plugin-api/src/host/http.ts',
        "import type {IncomingMessage} from 'node:http'",
        { name: '@axterm/plugin-api' },
      ),
    ).toEqual([]);
  });
});

it('permits only the document producer to import the pure policy helper and refuses execution dependencies', () => {
  const shell = {
    name: '@axterm/desktop',
    dependencies: { '@axterm/infra-connection': 'workspace:*' },
  };
  const imported = "import '@axterm/infra-connection/document-security'";
  expect(
    inspectLevel3Source('/repo/apps/desktop/src/shell/web-document.ts', imported, shell, 'shell'),
  ).toEqual([]);
  expect(
    inspectLevel3Source('/repo/apps/desktop/src/shell/application.ts', imported, shell, 'shell'),
  ).toContain(
    '/repo/apps/desktop/src/shell/application.ts: Desktop shell cannot load business or execution packages: @axterm/infra-connection/document-security',
  );
  const helper = { name: '@axterm/infra-connection', dependencies: { parse5: '^8.1.0' } };
  const path = '/repo/packages/infra/connection/src/document-security.ts';
  expect(inspectLevel3Source(path, "import 'node:crypto'; import 'parse5'", helper)).toEqual([]);
  for (const dependency of ['node:child_process', './index.ts', '@axterm/plugin-ai'])
    expect(inspectLevel3Source(path, `import '${dependency}'`, helper)).toContain(
      `${path}: Document security must remain a pure policy helper: ${dependency}`,
    );
});
