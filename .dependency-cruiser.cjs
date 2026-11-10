/** Actual owned boundaries plus retained rejection coverage for retired-layout fixtures. */
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-unresolved',
      severity: 'error',
      from: { pathNot: '^packages/infra/hmr/src/package-manifest\\.ts$' },
      to: { couldNotResolve: true, pathNot: '\\?modulePath$' },
    },
    {
      name: 'hmr-no-unresolved',
      severity: 'error',
      from: { path: '^packages/infra/hmr/src/package-manifest\\.ts$' },
      to: { couldNotResolve: true, pathNot: '^internal/test/binding$|\\?modulePath$' },
    },
    {
      name: 'owned-client-no-node-builtins',
      severity: 'error',
      from: { path: '^apps/web/src/|^packages/(?:api|infra|plugins)/[^/]+/src/client/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'public-api-no-node-builtins',
      severity: 'error',
      from: { path: '^packages/api/[^/]+/src/', pathNot: '^packages/api/[^/]+/src/host/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'owned-client-no-host-or-native',
      severity: 'error',
      from: { path: '^apps/web/src/|^packages/(?:api|infra|plugins)/[^/]+/src/client/' },
      to: {
        path: '(^|/)(electron|ssh2|node-pty|drizzle-orm)(/|$)|^apps/(desktop|desktop-host)/|^packages/(engines|pi-engine)/',
      },
    },
    {
      name: 'owned-host-no-electron-or-bun',
      severity: 'error',
      from: {
        path: '^apps/(cli|desktop-host)/src/|^packages/(?:api|infra|plugins|engines|data|tooling)/[^/]+/src/',
      },
      to: { path: '(^|/)electron(/|$)|^bun:|^apps/desktop/' },
    },
    {
      name: 'owned-domain-no-infrastructure',
      severity: 'error',
      from: { path: '^packages/plugins/[^/]+/src/(?:application|domain)/' },
      to: { path: '(^|/)(hono|drizzle-orm|ssh2|node-pty)(/|$)' },
    },
    {
      name: 'renderer-no-host-or-runtime',
      severity: 'error',
      from: { path: '^apps/desktop/src/renderer' },
      to: {
        path: '(^|/)(electron|ssh2|node-pty|drizzle-orm)(/|$)|^node:|^packages/(runtime|db-schema|pi-engine)/|^apps/desktop/src/(main|preload)/',
      },
    },
    {
      name: 'renderer-no-node-builtins',
      severity: 'error',
      from: { path: '^apps/desktop/src/renderer' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'portable-no-backend',
      severity: 'error',
      from: { path: '^packages/(client|contracts|shared)/src' },
      to: {
        path: '(^|/)(electron|ssh2|node-pty|drizzle-orm)(/|$)|^node:|^packages/(runtime|db-schema|pi-engine)/|^apps/desktop/',
      },
    },
    {
      name: 'portable-no-node-builtins',
      severity: 'error',
      from: { path: '^packages/(client|contracts|shared)/src' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'runtime-no-electron-or-bun',
      severity: 'error',
      from: { path: '^packages/runtime/src' },
      to: { path: '(^|/)electron(/|$)|^bun:|^apps/desktop/' },
    },
    {
      name: 'domain-no-infrastructure',
      severity: 'error',
      from: { path: '^packages/runtime/src/domain/' },
      to: {
        path: '(hono|drizzle-orm|ssh2|node-pty|packages/runtime/src/(http|adapters|repositories|application|bootstrap|entry)/)',
      },
    },
    {
      name: 'main-no-runtime-implementation',
      severity: 'error',
      from: { path: '^apps/desktop/src/main/' },
      to: {
        path: 'packages/runtime/',
        // The dependency resolver strips the query. The AST gate below requires
        // the exact ?modulePath import in Main/index.ts, never a runtime import.
        pathNot: '^packages/runtime/src/entry/desktop\\.ts$',
      },
    },
    {
      name: 'no-vendor-runtime-import',
      severity: 'error',
      from: { path: '^(apps|packages)/', pathNot: '^packages/pi-engine/src/' },
      to: { path: '(^|/)vendor/' },
    },
    {
      name: 'pi-engine-source-scope',
      severity: 'error',
      from: { path: '^packages/pi-engine/src/' },
      to: {
        path: '(^|/)vendor/',
        pathNot:
          '^vendor/(pi/packages/((ai|agent|telemetry)/src/|schema/src/index\\.ts$)|pi-auto-review/src/(policy\\.ts|path-surfaces\\.ts|review/shell-text\\.ts)$)',
      },
    },
    {
      name: 'pi-engine-only-runtime-adapter',
      severity: 'error',
      from: {
        path: '^(apps|packages)/',
        pathNot:
          '^packages/(pi-engine/|runtime/src/adapters/ai/|engines/pi/src/index\\.ts$|plugins/ai/src/adapters/(command-review|pi-metadata)\\.ts$)',
      },
      to: { path: '^packages/pi-engine/' },
    },
    {
      name: 'pi-engine-no-desktop',
      severity: 'error',
      from: { path: '^packages/pi-engine/' },
      to: { path: '(^|/)electron(/|$)|^bun:|^apps/desktop/' },
    },
  ],
  options: {
    // Framework is the hash-checked vendor snapshot, never an application implementation.
    doNotFollow: { path: 'node_modules|vendor|packages/framework/|packages/pi-engine/dist/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
    exclude: '\\.test\\.ts$',
  },
};
