import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { expect, it } from 'vitest';

it('checks actual runtime cycles, erased type cycles, Client laundering and exact HMR resolution ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-owned-dependency-gate-'));
  const write = async (path: string, source: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  };
  const run = () =>
    promisify(execFile)(process.execPath, [resolve('scripts/architecture-check.mjs')], {
      cwd: root,
    }).then(
      (result) => ({ rejected: false, output: result.stdout + result.stderr }),
      (error: { code: number; stdout: string; stderr: string }) => ({
        rejected: error.code === 1,
        output: error.stdout + error.stderr,
      }),
    );
  try {
    await write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          moduleResolution: 'Bundler',
          module: 'ESNext',
          target: 'ES2024',
          verbatimModuleSyntax: true,
        },
      }),
    );
    const a = 'packages/api/fixture/src/a.ts',
      b = 'packages/api/fixture/src/b.ts';
    await write(a, "import type { B } from './b.ts'; export interface A { b?: B }");
    await write(b, "import type { A } from './a.ts'; export interface B { a?: A }");
    await write(
      'packages/infra/hmr/src/package-manifest.ts',
      "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); require('internal/test/binding');",
    );
    expect((await run()).rejected).toBe(false);

    await write(a, "import { b } from './b.ts'; export const a=() => b();");
    await write(b, "import { a } from './a.ts'; export const b=() => a();");
    const cycle = await run();
    expect(cycle.rejected).toBe(true);
    expect(cycle.output).toContain('no-circular');
    await write(a, 'export interface A {}');
    await write(b, 'export interface B {}');

    const client = 'packages/plugins/fixture/src/client/index.ts';
    const api = 'packages/api/fixture/src/unsafe.ts';
    const specifier = relative(dirname(client), api).replaceAll('\\', '/');
    await write(api, "export * from 'node:fs';");
    await write(
      client,
      `import type { Stats } from '${specifier}'; export interface View { stat: Stats }`,
    );
    const laundered = await run();
    expect(laundered.rejected).toBe(true);
    expect(laundered.output).toContain('public-api-no-node-builtins');
    await write(api, 'export interface Stats {}');
    await write(
      client,
      "import type { Buffer } from 'node:buffer'; export interface View { value: Buffer }",
    );
    expect((await run()).output).toContain('owned-client-no-node-builtins');
    await write(client, 'export interface View {}');

    await write('packages/infra/fixture/src/index.ts', "import 'internal/test/binding';");
    const unresolved = await run();
    expect(unresolved.rejected).toBe(true);
    expect(unresolved.output).toContain('no-unresolved');
    await write('packages/infra/fixture/src/index.ts', 'export const value=true;');
    await write('packages/infra/hmr/src/package-manifest.ts', "import 'an-unavailable-package';");
    expect((await run()).output).toContain('hmr-no-unresolved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
