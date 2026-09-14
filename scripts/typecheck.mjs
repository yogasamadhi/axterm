import { spawnSync } from 'node:child_process';
const configs = [
  'tsconfig.json',
  'apps/desktop/tsconfig.node.json',
  'apps/desktop/tsconfig.web.json',
  ...['runtime', 'contracts', 'client', 'db-schema', 'shared'].map(
    (name) => `packages/${name}/tsconfig.json`,
  ),
];
for (const config of configs) {
  const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', config], {
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
