import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Axterm application icon generation', () => {
  it.skipIf(process.platform !== 'darwin')(
    'keeps PNG, ICO and ICNS variants byte-identical to the editable SVG source',
    () => {
      const result = spawnSync('bun', ['run', 'icons:check'], {
        cwd: resolve('.'),
        encoding: 'utf8',
      });

      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Application icon variants match icon.svg.');
    },
  );
});
