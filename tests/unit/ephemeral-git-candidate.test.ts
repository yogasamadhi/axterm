import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEphemeralGitCandidate,
  parseArguments,
} from '../../scripts/commercialization/check-ephemeral-git-candidate.mjs';

const directories: string[] = [];

async function fixtureSource() {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-git-candidate-source-'));
  directories.push(directory);
  await writeFile(join(directory, 'package.json'), '{"name":"candidate-fixture"}\n');
  await writeFile(join(directory, 'bun.lock'), 'lockfileVersion: 1\n');
  await writeFile(join(directory, 'README.md'), '# candidate fixture\n');
  await mkdir(join(directory, 'vendor', 'legacy-prototype'), { recursive: true });
  await writeFile(join(directory, 'vendor', 'legacy-prototype', 'legacy.js'), 'excluded\n');
  await mkdir(join(directory, 'node_modules', 'example'), { recursive: true });
  await writeFile(join(directory, 'node_modules', 'example', 'index.js'), 'excluded\n');
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('ephemeral independent Git candidate', () => {
  it('only runs the Docker-backed SSH fixture when explicitly requested', () => {
    expect(parseArguments(['--check'])).toEqual({
      keep: false,
      ssh: false,
      externalPeers: false,
    });
    expect(parseArguments(['--check', '--ssh', '--keep'])).toEqual({
      keep: true,
      ssh: true,
      externalPeers: false,
    });
    expect(parseArguments(['--check', '--ssh', '--external-peers'])).toEqual({
      keep: false,
      ssh: true,
      externalPeers: true,
    });
    expect(() => parseArguments(['--ssh'])).toThrow(/Usage:/u);
    expect(() => parseArguments(['--check', '--unknown'])).toThrow(/Usage:/u);
  });

  it('creates a clean no-submodule clone from the audited source-only snapshot', async () => {
    const candidate = await createEphemeralGitCandidate(await fixtureSource());
    directories.push(candidate.temporaryDirectory);

    expect(candidate.report).toMatchObject({ passed: true, sourceFiles: 3 });
    expect(candidate.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(candidate.trackedFiles).toBe(3);
    expect(existsSync(join(candidate.cloneDirectory, '.gitmodules'))).toBe(false);
    expect(existsSync(join(candidate.cloneDirectory, 'vendor', 'legacy-prototype'))).toBe(false);
    expect(existsSync(join(candidate.cloneDirectory, 'node_modules'))).toBe(false);
  });
});
