import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { resolveLevel3PackagedArtifact } from '../fixtures/level3-packaged-artifact';

it('resolves actual platform layouts and executable names from the new artifact, including non-asar macOS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axterm-l3-artifact-paths-'));
  try {
    expect(await resolveLevel3PackagedArtifact({})).toBeUndefined();
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const candidate = join(root, platform);
      const app = join(
        candidate,
        platform === 'darwin' ? 'Contents/Resources/app' : 'resources/app',
      );
      const bin = platform === 'darwin' ? join(candidate, 'Contents/MacOS') : candidate;
      await mkdir(join(app, 'lib/shell'), { recursive: true });
      await mkdir(bin, { recursive: true });
      const executablePath = join(
        bin,
        platform === 'win32'
          ? 'Axterm Level3 Validation.exe'
          : platform === 'linux'
            ? 'axterm-level3-validation'
            : 'Axterm Level3 Validation',
      );
      await writeFile(executablePath, 'fixture-only');
      await writeFile(join(app, 'lib/shell/main.js'), 'export {};');
      await writeFile(
        join(app, 'package.json'),
        JSON.stringify({ main: 'lib/shell/main.js', axterm: { migrationValidation: true } }),
      );
      await writeFile(
        join(app, 'LEVEL3_PACKAGE.json'),
        JSON.stringify({ purpose: 'migration-validation', productCutover: false, platform }),
      );
      const result = join(root, platform + '.json');
      await writeFile(
        result,
        JSON.stringify({ purpose: 'migration-validation', productCutover: false, app }),
      );
      expect(await resolveLevel3PackagedArtifact({ result }, platform)).toMatchObject({
        appDirectory: app,
        executablePath,
      });
      expect(await resolveLevel3PackagedArtifact({ candidate }, platform)).toMatchObject({
        appDirectory: app,
        executablePath,
      });
      await expect(
        resolveLevel3PackagedArtifact({ result }, platform === 'linux' ? 'darwin' : 'linux'),
      ).rejects.toThrow('new-architecture');
      await writeFile(join(bin, 'unrelated.exe'), 'ambiguous');
      if (platform === 'win32')
        await expect(resolveLevel3PackagedArtifact({ result }, platform)).rejects.toThrow(
          'unambiguous',
        );
      await writeFile(join(app, 'package.json'), JSON.stringify({ main: 'out/main/index.js' }));
      await expect(resolveLevel3PackagedArtifact({ result }, platform)).rejects.toThrow(
        'new-architecture',
      );
    }
    const malformed = join(root, 'malformed.json');
    for (const record of [
      { app: root },
      { purpose: 'migration-validation', productCutover: false, app: 'relative' },
      null,
    ]) {
      await writeFile(malformed, JSON.stringify(record));
      await expect(resolveLevel3PackagedArtifact({ result: malformed })).rejects.toThrow(
        'explicit Level3',
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
