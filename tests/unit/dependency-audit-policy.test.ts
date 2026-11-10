import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('dependency vulnerability audit policy', () => {
  it('pins the known vulnerable esbuild transitive resolution and executes an advisory query in CI', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const workspace = readFileSync(resolve('pnpm-workspace.yaml'), 'utf8');
    const lockfile = readFileSync(resolve('pnpm-lock.yaml'), 'utf8');
    const workflow = readFileSync(resolve('.github/workflows/check.yml'), 'utf8');

    expect(workspace).toContain('esbuild: 0.28.2');
    expect(manifest.scripts?.['audit:dependencies']).toBe(
      'pnpm audit --json --registry=https://registry.npmjs.org',
    );
    expect(lockfile).not.toMatch(/esbuild@0\.(?:1[0-9]|2[0-4])\./u);
    expect(workflow).toContain('- run: pnpm run audit:dependencies');
  });
});
