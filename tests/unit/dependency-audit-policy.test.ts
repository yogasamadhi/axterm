import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('dependency vulnerability audit policy', () => {
  it('pins the known vulnerable esbuild transitive resolution and executes an advisory query in CI', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      overrides?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const lockfile = readFileSync(resolve('bun.lock'), 'utf8');
    const workflow = readFileSync(resolve('.github/workflows/check.yml'), 'utf8');

    expect(manifest.overrides?.esbuild).toBe('0.28.2');
    expect(manifest.scripts?.['audit:dependencies']).toBe(
      'npm_config_registry=https://registry.npmjs.org bun audit --json',
    );
    expect(lockfile).not.toMatch(/esbuild@0\.(?:1[0-9]|2[0-4])\./u);
    expect(workflow).toContain('- run: bun run audit:dependencies');
  });
});
