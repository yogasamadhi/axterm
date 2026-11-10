import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { checkRemoteArtifacts } from '../../scripts/remote-contracts.mjs';
const artifact = {
  packageRoot: 'packages/service',
  face: 'host',
  js: 'HOST_BYTES\n',
  dts: 'HOST_TYPES\n',
  remote: { js: 'CLIENT_BYTES\n', dts: 'CLIENT_TYPES\n', dtsMap: '{"version":3}\n' },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'axterm-remote-output-'));
  const lib = join(root, artifact.packageRoot, 'lib');
  await mkdir(lib, { recursive: true });
  for (const [name, text] of [
    ['typert.host.js', artifact.js],
    ['typert.host.d.ts', artifact.dts],
    ['typert.remote-client.js', artifact.remote.js],
    ['typert.remote-client.d.ts', artifact.remote.dts],
    ['typert.remote-client.d.ts.map', artifact.remote.dtsMap],
  ])
    await writeFile(join(lib, name!), text!);
  return { root, lib };
}
it('checks exact generated Host/Client/map bytes and rejects stale, missing, duplicate or retired outputs', async () => {
  const f = await fixture();
  try {
    await expect(checkRemoteArtifacts(f.root, [artifact])).resolves.toEqual({
      contributors: 1,
      files: 5,
    });
    await writeFile(join(f.lib, 'typert.remote-client.js'), 'STALE');
    await expect(checkRemoteArtifacts(f.root, [artifact])).rejects.toThrow('output is stale');
    await writeFile(join(f.lib, 'typert.remote-client.js'), artifact.remote.js);
    await rm(join(f.lib, 'typert.remote-client.d.ts.map'));
    await expect(checkRemoteArtifacts(f.root, [artifact])).rejects.toThrow('output missing');
    await writeFile(join(f.lib, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap);
    await expect(checkRemoteArtifacts(f.root, [artifact, artifact])).rejects.toThrow('Duplicate');
    await expect(
      checkRemoteArtifacts(f.root, [{ ...artifact, remote: undefined }]),
    ).rejects.toThrow('Retired Remote client output remains');
    await expect(checkRemoteArtifacts(f.root, [])).rejects.toThrow(
      'No generated Host contributors',
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
it('rejects traversal, invalid faces and symlink escapes before reading a foreign output', async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'axterm-remote-foreign-'));
  try {
    for (const invalid of [
      { ...artifact, packageRoot: '../foreign' },
      { ...artifact, packageRoot: outside },
      { ...artifact, face: '../../foreign' },
    ])
      await expect(checkRemoteArtifacts(f.root, [invalid])).rejects.toThrow(/owner|workspace/);
    await writeFile(join(outside, 'private'), 'FOREIGN_BYTES_NEVER_READ');
    await rm(join(f.lib, 'typert.host.js'));
    await symlink(join(outside, 'private'), join(f.lib, 'typert.host.js'));
    await expect(checkRemoteArtifacts(f.root, [artifact])).rejects.toThrow('output escaped owner');
    await rm(f.lib, { recursive: true });
    await symlink(outside, f.lib, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(checkRemoteArtifacts(f.root, [artifact])).rejects.toThrow('output escaped owner');
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
