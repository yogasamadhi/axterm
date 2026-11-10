import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
it('does not add raw caught Error messages back into the actual Workspace or palette surfaces', () => {
  const directory = resolve('packages/plugins/workspace/src/client');
  const surfaces = readdirSync(directory).filter((name) => name.endsWith('.tsx'));
  expect(surfaces).toContain('index.tsx');
  expect(surfaces).toContain('command-palette.tsx');
  for (const name of surfaces) {
    const source = readFileSync(join(directory, name), 'utf8');
    expect(source).not.toMatch(/(?:cause|error)\.message/u);
    expect(source).not.toMatch(/(?:cause|error) instanceof Error/u);
  }
});
