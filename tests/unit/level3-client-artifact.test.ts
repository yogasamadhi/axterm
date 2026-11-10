import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { assertClientArtifact } from '../../scripts/client-artifact.mjs';
it('refuses absent, escaping and linked browser artifacts before staging a declared Client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axterm-client-artifact-'));
  const client = {
    name: '@fixture/client',
    axterm: { client: { platform: 'web' } },
    exports: { './client': { browser: './lib/client.browser.js' } },
  };
  try {
    await expect(assertClientArtifact(directory, client)).rejects.toThrow('artifact missing');
    await mkdir(join(directory, 'lib'));
    await writeFile(join(directory, 'lib/client.browser.js'), 'window.fixture = true;');
    await expect(assertClientArtifact(directory, client)).resolves.toBeUndefined();
    await expect(
      assertClientArtifact(directory, {
        ...client,
        exports: { './client': { browser: './../outside.js' } },
      }),
    ).rejects.toThrow('escapes');
    await symlink('client.browser.js', join(directory, 'lib/linked.js'));
    await expect(
      assertClientArtifact(directory, {
        ...client,
        exports: { './client': { browser: './lib/linked.js' } },
      }),
    ).rejects.toThrow('artifact missing');
    await expect(assertClientArtifact(directory, { ...client, exports: {} })).rejects.toThrow(
      'export',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
