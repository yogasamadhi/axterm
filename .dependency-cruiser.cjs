/** Level 1 boundaries also apply to imports made through client/contracts/shared. */
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-unresolved',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true, pathNot: '\\?modulePath$' },
    },
    {
      name: 'renderer-no-host-or-runtime',
      severity: 'error',
      from: { path: '^apps/desktop/src/renderer' },
      to: {
        path: '(^|/)(electron|ssh2|node-pty|drizzle-orm)(/|$)|^node:|^packages/(runtime|db-schema)/|^apps/desktop/src/(main|preload)/',
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
        path: '(^|/)(electron|ssh2|node-pty|drizzle-orm)(/|$)|^node:|^packages/(runtime|db-schema)/|^apps/desktop/',
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
      from: { path: '^(apps|packages)/' },
      to: { path: '(^|/)vendor/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules|vendor' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'apps/desktop/tsconfig.web.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
    exclude: '\\.test\\.ts$',
  },
};
