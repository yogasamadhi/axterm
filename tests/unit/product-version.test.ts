import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../../packages/shared/src/index';

describe('product version consistency', () => {
  it('keeps the shared product version equal to the workspace and packaged manifests', () => {
    const workspace = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      version: string;
    };
    const desktop = JSON.parse(readFileSync(resolve('apps/desktop/package.json'), 'utf8')) as {
      version: string;
    };

    expect(workspace.version).toBe(APP_VERSION);
    expect(desktop.version).toBe(APP_VERSION);
  });
});
